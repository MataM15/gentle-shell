import { release } from "node:os";
import {
	createWindowsSpeechEngine,
	guessReplyLanguage,
	resolvePowerShell,
	spokenText,
	windowsSpeechAvailable,
	type SpeechEngine,
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

export interface ReplyReader {
	// Rejects with the engine's SpeechEngineError when the engine fails.
	read(markdown: string, signal: AbortSignal): Promise<ReplyReadOutcome>;
}

export function createReplyReader(options: { engine: () => SpeechEngine | undefined; rate?: number }): ReplyReader {
	return {
		async read(markdown, signal) {
			const text = spokenText(markdown);
			if (!text) return "empty";
			const engine = options.engine();
			if (!engine) return "unavailable";
			return engine.speak(text, { language: guessReplyLanguage(text), rate: options.rate, signal });
		},
	};
}

// The Windows voice when this system can reach it, resolved once per caller.
export function defaultSpeechEngineResolver(env: NodeJS.ProcessEnv = process.env): () => SpeechEngine | undefined {
	let resolved: SpeechEngine | null | undefined;
	return () => {
		if (resolved === undefined) {
			const command = windowsSpeechAvailable({ platform: process.platform, kernelRelease: release() }) ? resolvePowerShell(process.platform, env) : undefined;
			resolved = command ? createWindowsSpeechEngine({ command }) : null;
		}
		return resolved ?? undefined;
	};
}
