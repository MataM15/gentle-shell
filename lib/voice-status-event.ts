import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { VoiceSessionState } from "./voice-session.ts";

// The display-only voice state the parent shell draws (the sidebar tab). The
// extension that draws it cannot reach this module, so the state travels as one
// event per change, keyed by the session that owns it. The payload is exactly
// { schema, sessionId, state }: no transcript, path, error text or other
// content ever leaves the voice command. Importing this module has no side
// effects: it registers nothing and starts nothing.

export const VOICE_STATE_EVENT = "gentle-ai:voice-state";
export const VOICE_STATE_SCHEMA = "gentle-pi.voice-state/v1";

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
		close() {
			closed = true;
		},
	};
}
