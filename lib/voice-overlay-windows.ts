import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { createOutputLevelMeter, encodeOverlayState, levelToPercent, type VoiceOverlay, type VoiceOverlaySnapshot } from "./voice-overlay.ts";
import { resolvePowerShell, windowsSpeechAvailable } from "./voice-speech.ts";

// The overlay window on Windows (T12, S5, S10, docs/voice.md "Voice listener").
// One warm PowerShell host, the same shape as the cue host in
// lib/voice-cues-windows.ts: the host is spawned with an encoded bootstrap that
// reads scripts/voice-overlay-window.ps1 from the first stdin line (the script
// is far larger than a command line allows), then every command is one short
// line on stdin. A state change is answered `ok state`; levels are fire and
// forget, written at most once per interval with only the newest value ever
// kept. Whether the microphone records is never guessed from the levels: it
// travels with the snapshot and is written as `rec 1` / `rec 0` right after the
// state it belongs to, so a quiet microphone is never shown as a closed one and
// a loud one never claims an open microphone (S10).
//
// This module never throws into the listener: a missing PowerShell, a missing
// script, a host that exits, refuses or hangs all reject the call that was
// waiting, the listener drops the overlay once, and a host that is gone is not
// started again. It never logs, and no level, label or transcript leaves it
// except as a command line to the local window.

export const OVERLAY_ENV = "GENTLE_PI_VOICE_OVERLAY";

const BOOTSTRAP = [
	"$ErrorActionPreference = 'Stop'",
	"$s = [Console]::In.ReadLine()",
	"Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)))",
].join("; ");
const ENCODED_BOOTSTRAP = Buffer.from(BOOTSTRAP, "utf16le").toString("base64");
const DEFAULT_SCRIPT = join(import.meta.dirname, "..", "scripts", "voice-overlay-window.ps1");
// The script is a few tens of KiB at most; a bigger file is not ours.
const MAX_SCRIPT_BYTES = 96 * 1024;

interface Proc {
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ProcSpawn = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => Proc;

export interface WindowsOverlayOptions {
	powershell: string;
	// The window script; read when the host starts, never at construction.
	scriptPath?: string;
	readScript?: (path: string) => string;
	spawn?: ProcSpawn;
	// How long one state change may take, host start-up included.
	timeoutMs?: number;
	// How long the host lives without any call before it retires.
	idleMs?: number;
	// Levels are written at most this often; only the newest is kept.
	levelIntervalMs?: number;
}

// PowerShell and WPF take a second or two to start.
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_MS = 30 * 60_000;
const DEFAULT_LEVEL_INTERVAL_MS = 40;
const KILL_GRACE_MS = 2_000;

export function createWindowsOverlay(options: WindowsOverlayOptions): VoiceOverlay {
	const spawn = options.spawn ?? (nodeSpawn as unknown as ProcSpawn);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
	const levelIntervalMs = options.levelIntervalMs ?? DEFAULT_LEVEL_INTERVAL_MS;
	const readScript = options.readScript ?? ((path: string) => readFileSync(path, "utf8"));

	let host: { proc: Proc; alive: boolean } | undefined;
	let waiting: { host: object; resolve: () => void; reject: (error: Error) => void } | undefined;
	let queue: Promise<void> = Promise.resolve();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	// A host that exited, refused or timed out is never started again: the
	// listener drops the overlay on the first failure, and a loop of PowerShell
	// starts is worse than no window.
	let failed: Error | undefined;

	// The state the window was last told, and whether it was told the microphone
	// records: a state line resets the window's own flag, so a false one only has
	// to be written when the window held true.
	let shown: VoiceOverlaySnapshot["state"] | undefined;
	let recording = false;
	// While reading the port receives the raw RMS of the speech the player
	// started (the listener hands it over untouched), so the overlay runs it
	// through the output meter. In listening the listener's own microphone meter
	// already normalized and smoothed it, so it is passed through.
	const outputMeter = createOutputLevelMeter();
	let latest: number | undefined;
	let lastWrite = Number.NEGATIVE_INFINITY;
	let levelTimer: ReturnType<typeof setTimeout> | undefined;

	const write = (current: NonNullable<typeof host>, line: string): void => {
		try {
			current.proc.stdin?.write(`${line}\n`);
		} catch {
			/* the exit handler reports it */
		}
	};
	const retire = (current: typeof host, kill: boolean) => {
		if (!current) return;
		current.alive = false;
		if (host === current) host = undefined;
		try {
			if (kill) current.proc.kill("SIGTERM");
			else {
				current.proc.stdin?.write("quit\n");
				current.proc.stdin?.end();
				// A window that ignores the quit is stopped, never left on screen.
				const grace = setTimeout(() => {
					try {
						current.proc.kill("SIGTERM");
					} catch {
						/* already gone */
					}
				}, KILL_GRACE_MS);
				grace.unref?.();
			}
		} catch {
			/* already gone */
		}
	};
	const fail = (error: Error): Error => {
		failed ??= error;
		// The listener drops a failed overlay and never calls it again, so a window
		// that is still up would be left saying a stale state: stop the host.
		if (host?.alive) retire(host, true);
		shown = undefined;
		recording = false;
		latest = undefined;
		if (levelTimer) clearTimeout(levelTimer);
		levelTimer = undefined;
		return error;
	};
	const start = (): NonNullable<typeof host> => {
		if (host?.alive) return host;
		const script = readScript(options.scriptPath ?? DEFAULT_SCRIPT);
		if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error("overlay script too large");
		const proc = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_BOOTSTRAP], {
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const current = { proc, alive: true };
		host = current;
		let buffered = "";
		proc.stdout?.on("data", (data: unknown) => {
			buffered += String(data);
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (!line || line === "ok ready" || waiting?.host !== current) continue;
				const pending = waiting;
				waiting = undefined;
				if (line === "ok state") pending.resolve();
				else pending.reject(fail(new Error("overlay host refused")));
			}
			// A host that never ends a line cannot grow the buffer without bound.
			if (buffered.length > 4096) buffered = "";
		});
		proc.stderr?.on("data", () => {});
		proc.stdin?.on("error", () => {});
		const gone = () => {
			// A host we retired (idle, dispose, timeout) leaving is expected; one
			// that left on its own is a failure.
			const expected = !current.alive;
			current.alive = false;
			if (host === current) host = undefined;
			if (disposed || expected) return;
			const error = fail(new Error("overlay host exited"));
			if (waiting?.host !== current) return;
			const pending = waiting;
			waiting = undefined;
			pending.reject(error);
		};
		proc.once("exit", gone);
		proc.once("error", gone);
		// The first line is the window script, as base64 on one line.
		write(current, Buffer.from(script, "utf8").toString("base64"));
		return current;
	};
	const armIdle = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => {
			shown = undefined;
			recording = false;
			retire(host, false);
		}, idleMs);
		idle.unref?.();
	};
	const serial = (work: () => Promise<void>): Promise<void> => {
		const run = queue.then(work, work);
		queue = run.catch(() => {});
		return run;
	};
	// One state change at a time: send the line and wait for its answer.
	const command = (current: NonNullable<typeof host>, line: string) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (waiting?.host === current) waiting = undefined;
				retire(current, true);
				reject(fail(new Error("overlay host timed out")));
			}, timeoutMs);
			waiting = {
				host: current,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			write(current, line);
		});

	const flushLevel = () => {
		levelTimer = undefined;
		if (latest === undefined || !host?.alive || failed || disposed) return;
		const value = latest;
		latest = undefined;
		lastWrite = Date.now();
		write(host, `level ${levelToPercent(value)}`);
	};

	return {
		show: (snapshot) => {
			if (disposed) return Promise.reject(new Error("overlay disposed"));
			if (failed) return Promise.reject(failed);
			// Encoded first: a snapshot that cannot be told is refused before anything starts.
			let line: string;
			try {
				line = encodeOverlayState(snapshot);
			} catch (error) {
				return Promise.reject(error instanceof Error ? error : new Error("overlay: bad snapshot"));
			}
			return serial(async () => {
				if (disposed) throw new Error("overlay disposed");
				if (failed) throw failed;
				let current: NonNullable<typeof host>;
				try {
					current = start();
				} catch (error) {
					throw fail(error instanceof Error ? error : new Error("overlay host failed to start"));
				}
				// A state line resets the window's recording flag, so the truth of this
				// snapshot follows it: `rec 1` when the microphone records, and `rec 0`
				// only to withdraw a recording the window was holding.
				const held = recording;
				recording = false;
				latest = undefined;
				shown = snapshot.state;
				outputMeter.reset();
				await command(current, line);
				if (snapshot.recording === true) {
					recording = true;
					write(current, "rec 1");
				} else if (held) {
					write(current, "rec 0");
				}
				armIdle();
			});
		},
		level: (value) => {
			if (disposed) return;
			if (failed) return Promise.reject(failed);
			// A level draws the wave and never says anything about the microphone:
			// only the snapshot's `recording` flag decides that (S10). A level before
			// any window exists starts nothing, and only the two states that draw a
			// wave take one.
			if (!host?.alive || (shown !== "listening" && shown !== "reading")) return;
			// Only the newest value is kept; one write per interval at most.
			latest = shown === "reading" ? outputMeter.push(value) : value;
			if (levelTimer) return;
			const wait = Math.max(0, lastWrite + levelIntervalMs - Date.now());
			if (wait === 0) flushLevel();
			else {
				levelTimer = setTimeout(flushLevel, wait);
				levelTimer.unref?.();
			}
			armIdle();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (idle) clearTimeout(idle);
			if (levelTimer) clearTimeout(levelTimer);
			levelTimer = undefined;
			latest = undefined;
			// A pending state change is released, not left hanging.
			if (waiting) {
				const pending = waiting;
				waiting = undefined;
				pending.reject(new Error("overlay disposed"));
			}
			retire(host, false);
		},
	};
}

export interface OverlayEnvironment {
	env?: NodeJS.ProcessEnv;
	platform?: string;
	kernelRelease?: string;
	// A resolved PowerShell, or `null` for none; resolved from the platform when absent.
	powershell?: string | null;
	spawn?: ProcSpawn;
	scriptPath?: string;
	readScript?: (path: string) => string;
}

// The overlay the listener should own, or nothing: not under Windows or WSL,
// no PowerShell to start, or GENTLE_PI_VOICE_OVERLAY=off (the only switch; there
// is no settings key).
export function createOverlayForEnvironment(options: OverlayEnvironment = {}): VoiceOverlay | undefined {
	const env = options.env ?? process.env;
	if ((env[OVERLAY_ENV] ?? "").trim().toLowerCase() === "off") return undefined;
	const platform = options.platform ?? process.platform;
	if (!windowsSpeechAvailable({ platform, kernelRelease: options.kernelRelease ?? release() })) return undefined;
	const powershell = options.powershell === undefined ? resolvePowerShell(platform, env) : (options.powershell ?? undefined);
	if (!powershell) return undefined;
	return createWindowsOverlay({ powershell, spawn: options.spawn, scriptPath: options.scriptPath, readScript: options.readScript });
}
