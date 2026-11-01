import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { KOKORO_PLAYER_SCRIPT, kokoroChunks } from "./voice-kokoro-engine.ts";
import { decodeWav, encodeWav, levelVoice, robotize } from "./voice-robot.ts";
import type { SpeechEngine, SpeechOutcome } from "./voice-speech.ts";

// The owner's voice for Spanish replies (docs/voice.md, "Raúl robot voice"):
// the Windows OneCore voice "Microsoft Raul" (es-MX), synthesized on this
// machine through the WinRT speech API, then robotized and leveled in code.
// One PowerShell process synthesizes sentence by sentence and writes each one
// as a base64 WAV line; another plays the processed sentences as they arrive.
// The text goes only to the synthesizer's stdin, as base64 JSON lines, never
// into a command line, and nothing leaves the machine.

export const ONECORE_VOICE = "Microsoft Raul";

export const ONECORE_SYNTH_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Runtime.WindowsRuntime",
	"[Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime] | Out-Null",
	"$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0].MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])",
	"$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer",
	`$voice = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices | Where-Object DisplayName -eq '${ONECORE_VOICE}' | Select-Object -First 1`,
	"if (-not $voice) { [Console]::Out.WriteLine('error:no-voice'); exit 1 }",
	"$synth.Voice = $voice",
	"while ($null -ne ($line = [Console]::In.ReadLine())) {",
	"  $line = $line.Trim()",
	"  if (-not $line) { continue }",
	"  try {",
	"    $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json",
	"    $task = $asTask.Invoke($null, @($synth.SynthesizeTextToStreamAsync([string]$request.text)))",
	"    $task.Wait(-1) | Out-Null",
	"    $in = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($task.Result)",
	"    $buffer = New-Object System.IO.MemoryStream",
	"    $in.CopyTo($buffer)",
	"    [Console]::Out.WriteLine('audio:' + [Convert]::ToBase64String($buffer.ToArray()))",
	"  } catch { [Console]::Out.WriteLine('error:synthesis'); exit 1 }",
	"}",
].join("\n");

const encode = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const ENCODED_SYNTH = encode(ONECORE_SYNTH_SCRIPT);
const ENCODED_PLAYER = encode(KOKORO_PLAYER_SCRIPT);

export type RobotVoiceErrorCode = "unavailable" | "no-voice" | "failed" | "timeout";

const MESSAGES: Record<RobotVoiceErrorCode, string> = {
	unavailable: "The Raúl voice only reads Spanish replies.",
	"no-voice": "The Windows voice Raúl is not installed.",
	failed: "The Raúl voice could not read the reply.",
	timeout: "The Raúl voice took too long and was stopped.",
};

export class RobotVoiceError extends Error {
	readonly code: RobotVoiceErrorCode;
	// True once part of the reply was played: a fallback must not repeat it.
	readonly audible: boolean;

	constructor(code: RobotVoiceErrorCode, audible = false) {
		super(MESSAGES[code]);
		this.name = "RobotVoiceError";
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

type ProcSpawn = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => Proc;

export interface RobotVoiceOptions {
	powershell: string;
	spawn?: ProcSpawn;
	timeoutMs?: (text: string) => number;
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
	return {
		id: "raul-robot",
		available: async () => true,
		async speak(text, { language, signal }) {
			if (signal.aborted) return "cancelled";
			if ((language ?? "es") !== "es") throw new RobotVoiceError("unavailable");
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
					if (outcome instanceof RobotVoiceError) reject(audible && !outcome.audible ? new RobotVoiceError(outcome.code, true) : outcome);
					else resolve(outcome);
				};
				const onAbort = () => finish("cancelled");
				try {
					player = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_PLAYER], { shell: false, windowsHide: true, stdio });
					synth = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_SYNTH], { shell: false, windowsHide: true, stdio });
				} catch {
					finish(new RobotVoiceError("failed"));
					return;
				}
				// Native output may name paths or devices: drained, never shown.
				player.stdout?.on("data", () => {});
				player.stderr?.on("data", () => {});
				synth.stderr?.on("data", () => {});
				player.stdin?.on("error", () => {});
				synth.stdin?.on("error", () => {});
				const allQueued = () => {
					if (synthDone && received === chunks.length) player.stdin?.end();
				};
				let buffered = "";
				synth.stdout?.on("data", (data: unknown) => {
					buffered += String(data);
					let newline: number;
					while ((newline = buffered.indexOf("\n")) !== -1) {
						const line = buffered.slice(0, newline).trim();
						buffered = buffered.slice(newline + 1);
						if (!line) continue;
						if (line === "error:no-voice") return finish(new RobotVoiceError("no-voice"));
						if (!line.startsWith("audio:")) return finish(new RobotVoiceError("failed"));
						let processed: string;
						try {
							processed = processRobotVoice(Buffer.from(line.slice("audio:".length), "base64")).toString("base64");
						} catch {
							return finish(new RobotVoiceError("failed"));
						}
						received++;
						audible = true;
						player.stdin?.write(`${processed}\n`);
					}
				});
				synth.once("error", () => finish(new RobotVoiceError("failed")));
				player.once("error", () => finish(new RobotVoiceError("failed")));
				synth.once("exit", (code: unknown) => {
					exited.synth = true;
					if (code !== 0 || received !== chunks.length) return finish(new RobotVoiceError("failed"));
					synthDone = true;
					allQueued();
				});
				player.once("exit", (code: unknown) => {
					exited.player = true;
					finish(synthDone && received === chunks.length && code === 0 ? "done" : new RobotVoiceError("failed"));
				});
				signal.addEventListener("abort", onAbort, { once: true });
				timer = setTimeout(() => finish(new RobotVoiceError("timeout")), timeoutFor(text));
				for (const chunk of chunks) synth.stdin?.write(`${Buffer.from(JSON.stringify({ text: chunk }), "utf8").toString("base64")}\n`);
				synth.stdin?.end();
			});
		},
	};
}
