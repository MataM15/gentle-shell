import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { KOKORO_PLAYER_SCRIPT, kokoroChunks } from "./voice-kokoro-engine.ts";
import { decodeWav, encodeWav, levelVoice, robotize, scaleWav } from "./voice-robot.ts";
import { createPlayerFeed, readPlaybackMarkers } from "./voice-speech-events.ts";
import type { SpeechEngine, SpeechLanguage, SpeechOutcome } from "./voice-speech.ts";

// The owner's voice (docs/voice.md, "Robot voice"): the Windows OneCore voice
// "Microsoft Raul" (es-MX) for Spanish replies and "Microsoft David" (en-US)
// for English ones, synthesized on this machine through the WinRT speech API,
// then robotized and leveled in code, at a per-language speech rate. One
// PowerShell process synthesizes sentence by sentence and writes each one as a
// base64 WAV line; another plays the processed sentences as they arrive. The
// text goes only to the synthesizer's stdin, as base64 JSON lines, never into a
// command line, and nothing leaves the machine.

export const ONECORE_VOICES = { es: "Microsoft Raul", en: "Microsoft David" } as const;

// The Spanish robot voice, the first one the owner picked.
export const ONECORE_VOICE = ONECORE_VOICES.es;

function synthScript(voice: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Runtime.WindowsRuntime",
		"[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null",
		"$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])",
		"$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer",
		`$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object DisplayName -eq '${voice}' | Select-Object -First 1`,
		"if (-not $voice) { [Console]::Out.WriteLine('error:no-voice'); exit 1 }",
		"$synth.Voice = $voice",
		"while ($null -ne ($line = [Console]::In.ReadLine())) {",
		"  $line = $line.Trim()",
		"  if (-not $line) { continue }",
		"  try {",
		"    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json",
		"    if ($null -ne $request.rate) { $synth.Options.SpeakingRate = [Math]::Max(0.5, [Math]::Min(2.0, [double]$request.rate)) }",
		"    $task = $asTask.Invoke($null, @($synth.SynthesizeTextToStreamAsync([string]$request.text)))",
		"    $task.Wait(-1) | Out-Null",
		"    $in = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)",
		"    $buffer = New-Object System.IO.MemoryStream",
		"    $in.CopyTo($buffer)",
		"    [Console]::Out.WriteLine('audio:' + [Convert]::ToBase64String($buffer.ToArray()))",
		"  } catch { [Console]::Out.WriteLine('error:synthesis'); exit 1 }",
		"}",
	].join("\n");
}

// One script per language: the voice it selects is fixed in the command, which
// is encoded once, so nothing the model writes ever becomes PowerShell code.
export const ONECORE_SYNTH_SCRIPTS = { es: synthScript(ONECORE_VOICES.es), en: synthScript(ONECORE_VOICES.en) } as const;

export const ONECORE_SYNTH_SCRIPT = ONECORE_SYNTH_SCRIPTS.es;

const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const ENCODED_SYNTH = { es: encode(ONECORE_SYNTH_SCRIPTS.es), en: encode(ONECORE_SYNTH_SCRIPTS.en) };
const ENCODED_PLAYER = encode(KOKORO_PLAYER_SCRIPT);

export type RobotVoiceErrorCode = "unavailable" | "no-voice" | "failed" | "timeout";

const MESSAGES: Record<RobotVoiceErrorCode, (voice: string) => string> = {
	unavailable: () => "The robot voice is not available from this system.",
	"no-voice": (voice) => `The Windows voice ${voice} is not installed.`,
	failed: (voice) => `The ${voice} voice could not read the reply.`,
	timeout: (voice) => `The ${voice} voice took too long and was stopped.`,
};

export class RobotVoiceError extends Error {
	readonly code: RobotVoiceErrorCode;
	// True once part of the reply was played: the voice must not repeat it.
	readonly audible: boolean;
	// The voice that failed, so its message names it.
	readonly voice: string;

	constructor(code: RobotVoiceErrorCode, audible = false, voice: string = ONECORE_VOICES.es) {
		super(MESSAGES[code](voice));
		this.name = "RobotVoiceError";
		this.code = code;
		this.audible = audible;
		this.voice = voice;
	}
}

interface Proc {
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ProcSpawn = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => Proc;

export interface RobotVoiceOptions {
	powershell: string;
	spawn?: ProcSpawn;
	timeoutMs?: (text: string) => number;
	// The reply volume, 0..1 (GENTLE_PI_VOICE_VOLUME); full volume when absent.
	volume?: number;
	// The speech-rate multiplier per reply language (GENTLE_PI_VOICE_RATE_ES,
	// GENTLE_PI_VOICE_RATE_EN); the voice's own pace when absent.
	rates?: Partial<Record<SpeechLanguage, number>>;
}

// PowerShell starts in about a second; OneCore synthesizes far faster than
// playback, which runs at about 15 characters a second.
const defaultTimeout = (text: string) => 60_000 + text.length * 150;

// Robotized like the owner's ffmpeg pick, then leveled so quiet syllables do
// not drop out.
export function processRobotVoice(wav: Buffer): Buffer {
	const { samples, sampleRate } = decodeWav(wav);
	return encodeWav(levelVoice(robotize(samples), sampleRate), sampleRate);
}

export function createRobotVoiceEngine(options: RobotVoiceOptions): SpeechEngine & { available(): Promise<boolean> } {
	const spawn = options.spawn ?? (nodeSpawn as unknown as ProcSpawn);
	const timeoutFor = options.timeoutMs ?? defaultTimeout;
	const volume = Math.max(0, Math.min(1, options.volume ?? 1));
	const rates = { es: options.rates?.es ?? 1, en: options.rates?.en ?? 1 };
	return {
		id: "raul-robot",
		voiceFor: (language) => ONECORE_VOICES[language ?? "es"],
		available: async () => true,
		async speak(text, { language, signal, onChunk }) {
			if (signal.aborted) return "cancelled";
			// Spanish and undecided replies keep the owner's first pick; English ones
			// get David with the same robot effect (S1).
			const spoken = language ?? "es";
			const voice = ONECORE_VOICES[spoken];
			const rate = rates[spoken];
			const fail = (code: RobotVoiceErrorCode, audible = false) => new RobotVoiceError(code, audible, voice);
			const chunks = kokoroChunks(text);
			if (chunks.length === 0) return "done";
			return new Promise<SpeechOutcome>((resolve, reject) => {
				let settled = false;
				let audible = false;
				let received = 0;
				let synthDone = false;
				const exited = { synth: false, player: false };
				const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
				let synth: Proc;
				let player: Proc;
				let timer: ReturnType<typeof setTimeout> | undefined;
				const killAll = () => {
					for (const [name, proc] of [["synth", synth], ["player", player]] as const) {
						if (!proc || exited[name]) continue;
						try {
							proc.kill("SIGTERM");
						} catch {
							/* already gone */
						}
					}
				};
				const finish = (outcome: SpeechOutcome | RobotVoiceError) => {
					if (settled) return;
					settled = true;
					if (timer) clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					if (outcome !== "done") killAll();
					if (outcome instanceof RobotVoiceError) reject(audible && !outcome.audible ? fail(outcome.code, true) : outcome);
					else resolve(outcome);
				};
				const onAbort = () => finish("cancelled");
				try {
					player = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_PLAYER], { shell: false, windowsHide: true, stdio });
					synth = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_SYNTH[spoken]], { shell: false, windowsHide: true, stdio });
				} catch {
					finish(fail("failed"));
					return;
				}
				// Only the player's own playback markers are read, so each sentence's
				// loudness is reported when it starts playing. Every other native
				// output line names paths or devices and is drained, never shown. One
				// sentence is in the player at a time, measured on what it receives.
				const feed = createPlayerFeed({
					write: (line) => { player.stdin?.write(line); },
					end: () => { player.stdin?.end(); },
					onChunk,
				});
				readPlaybackMarkers(player.stdout, () => feed.play());
				player.stderr?.on("data", () => {});
				synth.stderr?.on("data", () => {});
				player.stdin?.on("error", () => {});
				synth.stdin?.on("error", () => {});
				const allQueued = () => {
					if (synthDone && received === chunks.length) feed.close();
				};
				let buffered = "";
				synth.stdout?.on("data", (data: unknown) => {
					buffered += String(data);
					let newline: number;
					while ((newline = buffered.indexOf("\n")) !== -1) {
						const line = buffered.slice(0, newline).trim();
						buffered = buffered.slice(newline + 1);
						if (!line) continue;
						if (line === "error:no-voice") return finish(fail("no-voice"));
						if (!line.startsWith("audio:")) return finish(fail("failed"));
						let processed: Buffer;
						try {
							processed = processRobotVoice(Buffer.from(line.slice("audio:".length), "base64"));
						} catch {
							return finish(fail("failed"));
						}
						received++;
						audible = true;
						// Processed, turned down and measured on the very audio the player
						// receives, and reported when the player reports it began playing
						// that sentence.
						feed.queue(scaleWav(processed, volume));
					}
				});
				synth.once("error", () => finish(fail("failed")));
				player.once("error", () => finish(fail("failed")));
				synth.once("exit", (code: unknown) => {
					exited.synth = true;
					if (code !== 0 || received !== chunks.length) return finish(fail("failed"));
					synthDone = true;
					allQueued();
				});
				player.once("exit", (code: unknown) => {
					exited.player = true;
					finish(synthDone && received === chunks.length && code === 0 ? "done" : fail("failed"));
				});
				signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => finish(fail("timeout")), timeoutFor(text));
				for (const chunk of chunks) {
					// The multiplier travels with the sentence and the script sets it as the
					// synthesizer's SpeakingRate; the voice's own pace sends nothing.
					const request: { text: string; rate?: number } = { text: chunk };
					if (rate !== 1) request.rate = rate;
					synth.stdin?.write(`${Buffer.from(JSON.stringify(request), "utf8").toString("base64")}\n`);
				}
				synth.stdin?.end();
			});
		},
	};
}
