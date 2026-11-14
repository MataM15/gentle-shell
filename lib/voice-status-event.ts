import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceSessionState } from "./voice-session.ts";
import type { ListenerDisplayState, ListenerLanguage } from "./voice-listener-protocol.ts";

// Display-only events for the session's voice bubble. The legacy local-capture
// state remains exactly { schema, sessionId, state }; listener snapshots and
// levels use separate versioned channels. No transcript, path, or error text
// leaves the voice command. Importing this module has no side effects.

export const VOICE_STATE_EVENT = "gentle-ai:voice-state";
export const VOICE_STATE_SCHEMA = "gentle-pi.voice-state/v1";
export const VOICE_DISPLAY_EVENT = "gentle-ai:voice-display";
export const VOICE_DISPLAY_SCHEMA = "gentle-pi.voice-display/v1";
export const VOICE_LEVEL_EVENT = "gentle-ai:voice-level";
export const VOICE_LEVEL_SCHEMA = "gentle-pi.voice-level/v1";

export interface VoiceDisplaySnapshot {
	state: ListenerDisplayState;
	language: ListenerLanguage;
	label?: string;
}

export type VoiceDisplayState = "idle" | "preparing" | "listening" | "transcribing";

export interface VoiceStateEvent {
	schema: typeof VOICE_STATE_SCHEMA;
	sessionId: string;
	state: VoiceDisplayState;
}

// A session state says what the session is doing; the display state says what
// the indicator shows. "preparing" covers the install check and opening the
// microphone, "listening" is published only once the session is actually
// recording, and "finished" still owes its transcript, so it stays
// "transcribing" until the run settles and publishes "idle".
export function voiceDisplayState(state: VoiceSessionState): VoiceDisplayState {
	switch (state) {
		case "recording":
			return "listening";
		case "transcribing":
		case "finished":
			return "transcribing";
		case "starting":
			return "preparing";
		case "idle":
			return "idle";
	}
}

// The identity the event must quote is the real session id, read from the
// supported context API. Nothing else is ever used: no alias, no counter, no
// fallback string. Without one, the state stays unpublished.
export function readVoiceSessionId(ctx: ExtensionContext | undefined): string | undefined {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

export interface VoiceStatePublisher {
	readonly sessionId: string | undefined;
	// Publishes one state for this session. Returns true only when the event went
	// out: a publisher that was closed, a run that no longer owns the display, a
	// state repeated for this session, and a context without a session id all
	// publish nothing.
	publish(state: VoiceDisplayState, live?: () => boolean): boolean;
	publishDisplay(snapshot: VoiceDisplaySnapshot): void;
	publishLevel(source: "listening" | "reading", rms: number): void;
	// After close() the publisher is inert, so a callback from a replaced session
	// can never reach the display of the session that replaced it.
	close(): void;
}

export function createVoiceStatePublisher(pi: Pick<ExtensionAPI, "events">, ctx: ExtensionContext): VoiceStatePublisher {
	const sessionId = readVoiceSessionId(ctx);
	let closed = false;
	let last: VoiceDisplayState | undefined;
	return {
		sessionId,
		publish(state, live = () => true) {
			if (closed || !sessionId || last === state) return false;
			try {
				if (!live()) return false;
			} catch {
				return false;
			}
			try {
				pi.events.emit(VOICE_STATE_EVENT, { schema: VOICE_STATE_SCHEMA, sessionId, state } satisfies VoiceStateEvent);
			} catch {
				return false;
			}
			last = state;
			return true;
		},
		publishDisplay(snapshot) {
			if (closed || !sessionId) return;
			try {
				pi.events.emit(VOICE_DISPLAY_EVENT, { schema: VOICE_DISPLAY_SCHEMA, sessionId, ...snapshot });
			} catch { /* the display is advisory */ }
		},
		publishLevel(source, rms) {
			if (closed || !sessionId) return;
			try {
				pi.events.emit(VOICE_LEVEL_EVENT, { schema: VOICE_LEVEL_SCHEMA, sessionId, source, rms });
			} catch { /* the display is advisory */ }
		},
		close() {
			closed = true;
		},
	};
}
