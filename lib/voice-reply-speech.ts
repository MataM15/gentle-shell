import { release } from "node:os";
import { createKokoroSpeechEngine } from "./voice-kokoro-engine.ts";
import { resolveKokoroLaunch, resolveMiroLaunch } from "./voice-kokoro.ts";
import { createRobotVoiceEngine } from "./voice-onecore.ts";
import {
	createFallbackSpeechEngine,
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

// The natural voice (Kokoro) once it is installed, with the Windows voice as its
// fallback, when this system can reach Windows audio; resolved once per caller.
// Whether Kokoro is installed is checked again for every reading, so a download
// made during the session is used at once.
export function defaultSpeechEngineResolver(env: NodeJS.ProcessEnv = process.env): () => SpeechEngine | undefined {
	let resolved: SpeechEngine | null | undefined;
	return () => {
		if (resolved === undefined) {
			const command = windowsSpeechAvailable({ platform: process.platform, kernelRelease: release() }) ? resolvePowerShell(process.platform, env) : undefined;
			resolved = command
				? createFallbackSpeechEngine(
						// The owner's Raúl robot voice reads Spanish replies; Miro takes
						// over when Raúl fails before any audio, then Kokoro and the
						// Windows voice, which also read everything else.
						createRobotVoiceEngine({ powershell: command }),
						createFallbackSpeechEngine(
							createKokoroSpeechEngine({ launch: () => resolveMiroLaunch({ env }), powershell: command, env, voices: { es: { lang: "es", sid: 0 } } }),
							createFallbackSpeechEngine(createKokoroSpeechEngine({ launch: () => resolveKokoroLaunch({ env }), powershell: command, env }), createWindowsSpeechEngine({ command })),
						),
					)
				: null;
		}
		return resolved ?? undefined;
	};
}
