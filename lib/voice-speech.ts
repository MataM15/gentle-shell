import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Spoken replies (docs/voice.md, "Read replies aloud"). This module turns a
// finished Markdown reply into plain sentences worth hearing and reads them
// with a speech engine that runs in its own process, so a slow or crashed
// voice never blocks Gentle AI. Importing it does no IO; only speak() spawns.
//
// The first engine is the Windows voice (System.Speech through PowerShell),
// reachable from Windows and from WSL with no download. The script is a fixed
// constant passed with -EncodedCommand; the reply travels only through stdin,
// as base64 JSON, so no reply text ever becomes a command-line argument and
// accents survive every console code page.

export type SpeechLanguage = "es" | "en";

export interface SpeechOptions {
	language?: SpeechLanguage;
	// -10 (slowest) to 10 (fastest); 0 is the voice's normal pace.
	rate?: number;
	signal: AbortSignal;
}

export type SpeechOutcome = "done" | "cancelled";

export interface SpeechEngine {
	readonly id: string;
	speak(text: string, options: SpeechOptions): Promise<SpeechOutcome>;
}

export type SpeechEngineErrorCode = "unavailable" | "failed" | "timeout";

const ENGINE_MESSAGES: Record<SpeechEngineErrorCode, string> = {
	unavailable: "The Windows voice is not available from this system.",
	failed: "The Windows voice could not read the reply.",
	timeout: "The Windows voice took too long and was stopped.",
};

export class SpeechEngineError extends Error {
	readonly code: SpeechEngineErrorCode;

	constructor(code: SpeechEngineErrorCode) {
		super(ENGINE_MESSAGES[code]);
		this.name = "SpeechEngineError";
		this.code = code;
	}
}

// --- what is read aloud --------------------------------------------------------

// Readings stream sentence by sentence, so a long reply is read whole; the
// limit only guards against a runaway reply.
export const SPOKEN_TEXT_LIMIT = 8_000;

const SENTENCE_END = /[.!?:;,]$/;

// A token with two or more slashes is a path or a URL fragment: only its last
// segment is worth hearing.
const shortenPath = (token: string): string => {
	if (token.split("/").length <= 2) return token;
	const trailing = /[.,;:!?)]*$/.exec(token)?.[0] ?? "";
	const core = token.slice(0, token.length - trailing.length).replace(/\/+$/, "");
	return `${core.slice(core.lastIndexOf("/") + 1)}${trailing}`;
};

function spokenLine(line: string): string {
	let text = line.trim();
	if (text.startsWith("|")) return "";
	text = text
		.replace(/^#{1,6}\s+/, "")
		.replace(/^>\s?/, "")
		.replace(/^([-*+]|\d+[.)])\s+/, "")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\bhttps?:\/\/\S+/g, "")
		.replace(/`([^`]*)`/g, (_match, code: string) => shortenPath(code.trim()))
		.replace(/\*\*|__/g, "")
		.replace(/(^|\s)[*_](\S(?:[^*_]*\S)?)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
		.replace(/[→←⇒↔]/g, " ");
	text = text.split(/\s+/).map(shortenPath).join(" ");
	text = text.replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim();
	if (!text || !/[\p{L}\p{N}]/u.test(text)) return "";
	return SENTENCE_END.test(text) ? text : `${text}.`;
}

// Ends within the limit at the last sentence boundary, or cuts hard when the
// first sentence alone is longer than the limit.
function withinLimit(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, limit + 1);
	const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
	return end > 0 ? head.slice(0, end + 1) : text.slice(0, limit).trim();
}

export function spokenText(markdown: string, limit = SPOKEN_TEXT_LIMIT): string {
	const withoutCode = markdown
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
		// An unterminated fence hides the rest of the reply.
		.replace(/^(```|~~~)[\s\S]*$/m, "");
	const sentences = withoutCode.split(/\r?\n/).map(spokenLine).filter(Boolean);
	return withinLimit(sentences.join(" "), limit);
}

// --- which voice language a reply asks for ---------------------------------------

const SPANISH_WORDS = new Set(
	"de la que el en y los se del las por un para con una su al es lo como más pero sus le ya este sí porque esta entre cuando muy sin sobre también me hasta hay donde desde todo nos todos les ni eso esto qué yo él ella mi mis tu tus te vos sos tenés está están ahora listo acá ahí".split(" "),
);
const ENGLISH_WORDS = new Set(
	"the of and to in is that it for on with as was are be this by not or have from at but you your they an which can if do does did will would should now done here there what".split(" "),
);

export function guessReplyLanguage(text: string): SpeechLanguage | undefined {
	let spanish = (text.match(/[áéíóúñ¿¡]/gi) ?? []).length;
	let english = 0;
	for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
		if (SPANISH_WORDS.has(word)) spanish++;
		if (ENGLISH_WORDS.has(word)) english++;
	}
	if (spanish + english < 2 || spanish === english) return undefined;
	return spanish > english ? "es" : "en";
}

// --- where the Windows voice exists -----------------------------------------------

export interface SpeechPlatformProbe {
	platform: string;
	kernelRelease: string;
}

export function windowsSpeechAvailable(probe: SpeechPlatformProbe): boolean {
	if (probe.platform === "win32") return true;
	return probe.platform === "linux" && /microsoft/i.test(probe.kernelRelease);
}

const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

// On Windows the name is resolved by the system. Under WSL the Windows PATH is
// usually appended to the Linux one; when it is not, the standard install path
// is tried.
export function resolvePowerShell(platform: string, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
	if (platform === "win32") return "powershell.exe";
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir && exists(join(dir, "powershell.exe"))) return join(dir, "powershell.exe");
	}
	return exists(WSL_POWERSHELL) ? WSL_POWERSHELL : undefined;
}

// --- the Windows engine -------------------------------------------------------------

export const WINDOWS_SPEECH_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Speech",
	"$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json",
	"$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
	"if ($payload.language) {",
	"  $voice = $synth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq $payload.language } | Select-Object -First 1",
	"  if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }",
	"}",
	"$synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$payload.rate))",
	"$synth.SetOutputToDefaultAudioDevice()",
	"$synth.Speak([string]$payload.text)",
	"$synth.Dispose()",
].join("\n");

const ENCODED_SCRIPT = Buffer.from(WINDOWS_SPEECH_SCRIPT, "utf16le").toString("base64");

export interface SpeechChild {
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export type SpeechSpawn = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => SpeechChild;

export interface WindowsSpeechEngineOptions {
	command: string;
	spawn?: SpeechSpawn;
	// The longest one reading may take before it is killed, by text length.
	timeoutMs?: (text: string) => number;
}

// PowerShell takes about a second to start; a reading then runs at speaking
// pace, roughly 15 characters a second at the normal rate.
const defaultTimeout = (text: string) => 30_000 + text.length * 120;

export function createWindowsSpeechEngine(options: WindowsSpeechEngineOptions): SpeechEngine {
	const spawn = options.spawn ?? (nodeSpawn as unknown as SpeechSpawn);
	const timeoutFor = options.timeoutMs ?? defaultTimeout;
	return {
		id: "windows",
		speak(text, { language, rate, signal }) {
			if (signal.aborted) return Promise.resolve("cancelled");
			return new Promise<SpeechOutcome>((resolve, reject) => {
				let settled = false;
				let child: SpeechChild;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const finish = (outcome: SpeechOutcome | SpeechEngineError) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					if (outcome instanceof SpeechEngineError) reject(outcome);
					else resolve(outcome);
				};
				const stopChild = () => {
					try {
						child.kill("SIGTERM");
					} catch {
						/* already gone */
					}
				};
				const onAbort = () => {
					stopChild();
					finish("cancelled");
				};
				try {
					child = spawn(options.command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_SCRIPT], {
						shell: false,
						windowsHide: true,
						stdio: ["pipe", "pipe", "pipe"],
					});
				} catch {
					finish(new SpeechEngineError("unavailable"));
					return;
				}
				// Output is never read: PowerShell writes progress records there, and
				// native error text must not reach the user.
				child.stdout?.on("data", () => {});
				child.stderr?.on("data", () => {});
				child.once("error", () => finish(new SpeechEngineError("unavailable")));
				child.once("exit", (code: unknown) => {
					if (signal.aborted) finish("cancelled");
					else finish(code === 0 ? "done" : new SpeechEngineError("failed"));
				});
				signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => {
					stopChild();
					finish(new SpeechEngineError("timeout"));
				}, timeoutFor(text));
				const payload: { text: string; language?: SpeechLanguage; rate?: number } = { text };
				if (language) payload.language = language;
				if (rate !== undefined) payload.rate = Math.max(-10, Math.min(10, Math.round(rate)));
				child.stdin?.on("error", () => {});
				child.stdin?.write(`${Buffer.from(JSON.stringify(payload), "utf8").toString("base64")}\n`);
				child.stdin?.end();
			});
		},
	};
}

// --- the preferred engine with a fallback --------------------------------------------

// Reads with the preferred engine (the natural voice) while it is available and
// with the fallback (the Windows voice) otherwise, or when the preferred one
// fails before any of the reply was heard. A reading the user stopped is never
// read again by the fallback.
export function createFallbackSpeechEngine(preferred: SpeechEngine & { available(): Promise<boolean> }, fallback: SpeechEngine): SpeechEngine {
	return {
		id: `${preferred.id}+${fallback.id}`,
		async speak(text, options) {
			if (await preferred.available().catch(() => false)) {
				try {
					return await preferred.speak(text, options);
				} catch (error) {
					if (options.signal.aborted) return "cancelled";
					// Part of the reply was already heard: reading it again from the
					// start with another voice would repeat it.
					if ((error as { audible?: unknown } | undefined)?.audible === true) throw error;
				}
			}
			if (options.signal.aborted) return "cancelled";
			return fallback.speak(text, options);
		},
	};
}
