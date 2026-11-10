import { release } from "node:os";
import { createRobotVoiceEngine, type RobotVoiceOptions } from "./voice-onecore.ts";
import type { VoiceSpeechChunk } from "./voice-speech-events.ts";
import {
	createRetrySpeechEngine,
	guessReplyLanguage,
	resolvePowerShell,
	spokenText,
	voiceRates,
	voiceVolume,
	windowsSpeechAvailable,
	type SpeechEngine,
	type SpeechLanguage,
	type SpeechOutcome,
} from "./voice-speech.ts";

// Spoken replies (docs/voice.md, "Read replies aloud"): which text of a
// finished run is read, and one reading handed to the speech engine. No UI
// here; lib/voice-command.ts owns the footer, keys and menu.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n\n");
}

// The reply is the text of the last assistant message that has any; thinking,
// tool calls and tool results are never read.
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant") continue;
		const text = messageText(message.content);
		if (text) return text;
	}
	return undefined;
}

export type ReplyReadOutcome = SpeechOutcome | "empty" | "unavailable";

// Where the reading reports the chunks its player really began.
export interface ReplyReadSink {
	chunk(chunk: VoiceSpeechChunk): void;
	// Reports the voice that failed before any audio was heard and the voice
	// asked to read the reply again, so the reading can log why it was retried.
	retry?(info: { attempt: number; failure: string }): void;
}

export interface ReplyReader {
	// Rejects with the engine's SpeechEngineError when the engine fails.
	read(markdown: string, signal: AbortSignal, sink?: ReplyReadSink): Promise<ReplyReadOutcome>;
}

// The language one reading asks the voice for, guessed from the text that will
// be spoken. A reply with no words, or one both languages claim equally, asks
// for none.
export function replyLanguage(markdown: string): SpeechLanguage | undefined {
	return guessReplyLanguage(spokenText(markdown));
}

export function createReplyReader(options: { engine: () => SpeechEngine | undefined; rate?: number }): ReplyReader {
	return {
		async read(markdown, signal, sink) {
			const text = spokenText(markdown);
			if (!text) return "empty";
			const engine = options.engine();
			if (!engine) return "unavailable";
			return engine.speak(text, {
				language: guessReplyLanguage(text),
				rate: options.rate,
				signal,
				...(sink ? { onChunk: (chunk: VoiceSpeechChunk) => sink.chunk(chunk) } : {}),
				...(sink?.retry ? { onRetry: (info: { attempt: number; failure: string }) => sink.retry!(info) } : {}),
			});
		},
	};
}

// The voice that reads every reply (docs/voice.md, "Robot voice"): the same
// robotized OneCore voice in the reply's own language, Raúl for Spanish and
// David for English, read again once when it fails before any audio. No other
// voice reads a reply: the plain Spanish voices are what the owner does not
// want to hear, so a second failure ends the reading instead of falling back.
export function createReplySpeechChain(options: { powershell: string; env?: NodeJS.ProcessEnv; spawn?: RobotVoiceOptions["spawn"] }): SpeechEngine {
	const env = options.env ?? process.env;
	return createRetrySpeechEngine(
		createRobotVoiceEngine({
			powershell: options.powershell,
			volume: voiceVolume(env),
			rates: voiceRates(env),
			...(options.spawn ? { spawn: options.spawn } : {}),
		}),
	);
}

// The reply voice, when this system can reach Windows audio; resolved once per
// caller, so a change to the voice variables applies to the next session.
export function defaultSpeechEngineResolver(env: NodeJS.ProcessEnv = process.env): () => SpeechEngine | undefined {
	let resolved: SpeechEngine | null | undefined;
	return () => {
		if (resolved === undefined) {
			const command = windowsSpeechAvailable({ platform: process.platform, kernelRelease: release() }) ? resolvePowerShell(process.platform, env) : undefined;
			resolved = command ? createReplySpeechChain({ powershell: command, env }) : null;
		}
		return resolved ?? undefined;
	};
}
