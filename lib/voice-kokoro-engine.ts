import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { createChunkSink, PLAYBACK_MARKER, readPlaybackMarkers } from "./voice-speech-events.ts";
import type { SpeechEngine, SpeechOutcome } from "./voice-speech.ts";

// The natural-voice engine (docs/voice.md, "Natural voice with Kokoro"). One
// reading runs two processes: scripts/voice-tts-worker.cjs synthesizes the text
// chunk by chunk with Kokoro, and one PowerShell process plays each chunk with
// System.Media.SoundPlayer as soon as it arrives. PowerShell starts while the
// first chunk is synthesized, and the first chunk is the first sentence alone,
// so the voice starts early. Only base64 WAV lines reach the player; the reply
// itself goes only to the worker's stdin, never into a command line.

export const KOKORO_TTS_SCHEMA = "gentle.voice-tts/v1";
export const KOKORO_TTS_WORKER_URL = new URL("../scripts/voice-tts-worker.cjs", import.meta.url);

export interface KokoroLaunch {
	// A Piper VITS voice, or Kokoro when absent.
	kind?: "kokoro" | "piper";
	runtimeRoot: string;
	core: { root: string; files: Array<{ name: string; size: number }> };
	espeak: Array<{ root: string; folder: "" | "lang/roa" | "lang/gmw"; files: Array<{ name: string; size: number }> }>;
}

export const KOKORO_PLAYER_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"while ($null -ne ($line = [Console]::In.ReadLine())) {",
	"  $line = $line.Trim()",
	"  if (-not $line) { continue }",
	"  $stream = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($line))",
	"  $player = New-Object System.Media.SoundPlayer($stream)",
	// Reported before the sound starts, so each chunk's loudness reaches the
	// listener while it is still being heard, not after it ended.
	`  [Console]::Out.WriteLine('${PLAYBACK_MARKER}')`,
	"  $player.PlaySync()",
	"  $player.Dispose()",
	"  $stream.Dispose()",
	"}",
].join("\n");

const ENCODED_PLAYER = Buffer.from(KOKORO_PLAYER_SCRIPT, "utf16le").toString("base64");

// Later chunks stay short: synthesizing one has to finish before the previous
// one has played, or the voice stops mid-reply. Short sentences are merged up
// to CHUNK_MIN so the player does not restart for every few words.
const CHUNK_MIN = 40;
const CHUNK_MAX = 160;
// The natural voice reads a little faster than its normal pace.
const BASE_SPEED = 1.08;
const MAX_CHUNKS = 256;

// The first sentence alone, then one sentence per chunk, merging short ones up
// to CHUNK_MIN and never past CHUNK_MAX. A sentence longer than CHUNK_MAX is
// cut at word boundaries.
export function kokoroChunks(text: string): string[] {
	const sentences = text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean).flatMap((sentence) => {
		const pieces: string[] = [];
		let piece = "";
		for (const word of sentence.split(/\s+/)) {
			for (let at = 0; at < word.length; at += CHUNK_MAX) {
				const part = word.slice(at, at + CHUNK_MAX);
				if (piece && piece.length + 1 + part.length > CHUNK_MAX) {
					pieces.push(piece);
					piece = part;
				} else piece = piece ? `${piece} ${part}` : part;
			}
		}
		if (piece) pieces.push(piece);
		return pieces;
	});
	if (sentences.length === 0) return [];
	const chunks = [sentences[0]!];
	let current = "";
	for (const sentence of sentences.slice(1)) {
		if (current && (current.length >= CHUNK_MIN || current.length + 1 + sentence.length > CHUNK_MAX)) {
			chunks.push(current);
			current = sentence;
		} else current = current ? `${current} ${sentence}` : sentence;
	}
	if (current) chunks.push(current);
	return chunks.slice(0, MAX_CHUNKS);
}

export type KokoroSpeechErrorCode = "unavailable" | "failed" | "timeout";

const MESSAGES: Record<KokoroSpeechErrorCode, string> = {
	unavailable: "The natural voice is not installed.",
	failed: "The natural voice could not read the reply.",
	timeout: "The natural voice took too long and was stopped.",
};

export class KokoroSpeechError extends Error {
	readonly code: KokoroSpeechErrorCode;
	// True once part of the reply was already handed to the player, so a
	// fallback must not read it again from the start.
	readonly audible: boolean;

	constructor(code: KokoroSpeechErrorCode, audible = false) {
		super(MESSAGES[code]);
		this.name = "KokoroSpeechError";
		this.code = code;
		this.audible = audible;
	}
}

interface Proc {
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ProcSpawn = (command: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => Proc;

export interface KokoroEngineOptions {
	launch: () => Promise<KokoroLaunch | undefined>;
	powershell: string;
	spawn?: ProcSpawn;
	nodePath?: string;
	workerPath?: string;
	env?: NodeJS.ProcessEnv;
	numThreads?: number;
	timeoutMs?: (text: string) => number;
	// The voice per reply language; a language without one is refused so the
	// fallback reads it. Kokoro's Spanish and English voices by default.
	voices?: Partial<Record<"es" | "en", { lang: "es" | "es-419" | "en-us"; sid: number }>>;
}

const VOICE_BY_LANGUAGE = { es: { lang: "es", sid: 28 }, en: { lang: "en-us", sid: 3 } } as const;

// Synthesis runs at a fraction of real time and playback at real time, about
// 15 characters a second.
const defaultTimeout = (text: string) => 60_000 + text.length * 150;

export function createKokoroSpeechEngine(options: KokoroEngineOptions): SpeechEngine & { available(): Promise<boolean> } {
	const spawn = options.spawn ?? (nodeSpawn as unknown as ProcSpawn);
	const timeoutFor = options.timeoutMs ?? defaultTimeout;
	const env = options.env ?? process.env;
	return {
		id: "kokoro",
		available: async () => (await options.launch().catch(() => undefined)) !== undefined,
		async speak(text, { language, rate, signal, onChunk }) {
			if (signal.aborted) return "cancelled";
			const voice = (options.voices ?? VOICE_BY_LANGUAGE)[language ?? "es"];
			if (!voice) throw new KokoroSpeechError("unavailable");
			const launch = await options.launch().catch(() => undefined);
			if (!launch) throw new KokoroSpeechError("unavailable");
			if (signal.aborted) return "cancelled";
			const chunks = kokoroChunks(text);
			if (chunks.length === 0) return "done";
			const speed = Math.round(Math.max(0.5, Math.min(2, BASE_SPEED + (rate ?? 0) / 20)) * 100) / 100;
			return new Promise<SpeechOutcome>((resolve, reject) => {
				let settled = false;
				let workerDone = false;
				let audible = false;
				const exited = { worker: false, player: false };
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
				let player: Proc;
				let worker: Proc;
				const killAll = () => {
					for (const [name, proc] of [["player", player], ["worker", worker]] as const) {
						if (!proc || exited[name]) continue;
						try {
							proc.kill("SIGTERM");
						} catch {
							/* already gone */
						}
					}
				};
				const finish = (outcome: SpeechOutcome | KokoroSpeechError) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					if (outcome !== "done") killAll();
					if (outcome instanceof KokoroSpeechError) reject(audible && !outcome.audible ? new KokoroSpeechError(outcome.code, true) : outcome);
					else resolve(outcome);
				};
				const onAbort = () => finish("cancelled");
				try {
					player = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_PLAYER], { shell: false, windowsHide: true, stdio });
					worker = spawn(options.nodePath ?? process.execPath, [options.workerPath ?? fileURLToPath(KOKORO_TTS_WORKER_URL)], {
						cwd: launch.runtimeRoot,
						env: { HOME: env.HOME ?? "", NODE_NO_WARNINGS: "1", GENTLE_PI_AGENTS_CHILD: "1" },
						shell: false,
						windowsHide: true,
						stdio,
					});
				} catch {
					finish(new KokoroSpeechError("failed"));
					return;
				}
				// Native output names paths or devices: drained, never shown. Only the
				// player's own playback markers are read, so each chunk event lands
				// when that chunk is heard. Each chunk is queued and measured as it is
				// written, and reported when its marker arrives, in that order.
				const sink = createChunkSink(onChunk);
				readPlaybackMarkers(player.stdout, () => sink.play());
				player.stderr?.on("data", () => {});
				worker.stderr?.on("data", () => {});
				player.stdin?.on("error", () => {});
				worker.stdin?.on("error", () => {});
				let buffered = "";
				worker.stdout?.on("data", (data: unknown) => {
					buffered += String(data);
					let newline: number;
					while ((newline = buffered.indexOf("\n")) !== -1) {
						const line = buffered.slice(0, newline);
						buffered = buffered.slice(newline + 1);
						let message: { schema?: unknown; type?: unknown; wav?: unknown } | undefined;
						try {
							message = JSON.parse(line);
						} catch {
							message = undefined;
						}
						if (!message || message.schema !== KOKORO_TTS_SCHEMA) return finish(new KokoroSpeechError("failed"));
						if (message.type === "audio" && typeof message.wav === "string" && /^[A-Za-z0-9+/=]+$/.test(message.wav)) {
							audible = true;
							// Measured now from the very bytes the player receives, and
							// reported when the player reports it began playing.
							sink.queue(Buffer.from(message.wav, "base64"));
							player.stdin?.write(`${message.wav}\n`);
						}
						else if (message.type === "done") {
							workerDone = true;
							player.stdin?.end();
						} else return finish(new KokoroSpeechError("failed"));
					}
				});
				worker.once("error", () => finish(new KokoroSpeechError("failed")));
				player.once("error", () => finish(new KokoroSpeechError("failed")));
				worker.once("exit", (code: unknown) => {
					exited.worker = true;
					if (!workerDone || code !== 0) finish(new KokoroSpeechError("failed"));
				});
				player.once("exit", (code: unknown) => {
					exited.player = true;
					finish(workerDone && code === 0 ? "done" : new KokoroSpeechError("failed"));
				});
				signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => finish(new KokoroSpeechError("timeout")), timeoutFor(text));
				worker.stdin?.write(`${JSON.stringify({ schema: KOKORO_TTS_SCHEMA, type: "start", ...(launch.kind === "piper" ? { kind: "piper" } : {}), runtime: { root: launch.runtimeRoot }, core: launch.core, espeak: launch.espeak, lang: voice.lang, sid: voice.sid, speed, numThreads: options.numThreads ?? 4, chunks })}\n`);
			});
		},
	};
}
