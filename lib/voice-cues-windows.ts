import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";

// Microphone cues on Windows (docs/voice.md, "Microphone cues"). Under WSL the
// reply voice plays through PowerShell on the Windows default output, while
// PulseAudio goes through WSLg, which can be another device or a quieter one;
// the owner heard the replies on the speakers and not the cues. This host plays
// the cues where the replies play. One PowerShell process stays warm: the tones
// reach it once over stdin as base64 lines (never on the command line), each
// becomes a loaded SoundPlayer, and a cue is one `play <name>` line answered by
// `ok play <name>` after the tone ended. It retires when idle and the next cue
// starts a new one.

const HOST_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$players = @{}",
	"while ($null -ne ($line = [Console]::In.ReadLine())) {",
	"  $parts = $line.Trim().Split(' ')",
	"  if ($parts.Count -lt 2) { continue }",
	"  try {",
	"    if ($parts[0] -eq 'load' -and $parts.Count -eq 3) {",
	"      $stream = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($parts[2]))",
	"      $player = New-Object System.Media.SoundPlayer($stream)",
	"      $player.Load()",
	"      $players[$parts[1]] = $player",
	"      [Console]::Out.WriteLine('ok load ' + $parts[1])",
	"    } elseif ($parts[0] -eq 'play' -and $players.ContainsKey($parts[1])) {",
	"      $players[$parts[1]].PlaySync()",
	"      [Console]::Out.WriteLine('ok play ' + $parts[1])",
	"    } else { [Console]::Out.WriteLine('error ' + $parts[0]) }",
	"  } catch { [Console]::Out.WriteLine('error ' + $parts[0]) }",
	"}",
].join("\n");

const ENCODED_HOST = Buffer.from(HOST_SCRIPT, "utf16le").toString("base64");

// A cue name is a lowercase word, so nothing but a known tone reaches the host.
const SAFE_NAME = /^[a-z]+$/;

interface Proc {
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown } | null;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	kill(signal: NodeJS.Signals): boolean;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
}

type ProcSpawn = (command: string, args: readonly string[], options: { shell: false; windowsHide: true; stdio: ["pipe", "pipe", "pipe"] }) => Proc;

export interface WindowsCueOptions {
	powershell: string;
	sounds: Readonly<Record<string, Buffer>>;
	spawn?: ProcSpawn;
	// How long one cue may take, start-up included, before the host is stopped.
	timeoutMs?: number;
	// How long the host waits for another cue before it retires.
	idleMs?: number;
}

export interface WindowsCueBackend {
	probe(): Promise<{ available: boolean }>;
	play(name: string): Promise<void>;
	warm(): void;
	dispose(): void;
}

// PowerShell takes about a second to start; a warm host answers in a few ms.
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_MS = 30 * 60_000;

export function createWindowsCueBackend(options: WindowsCueOptions): WindowsCueBackend {
	const spawn = options.spawn ?? (nodeSpawn as unknown as ProcSpawn);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
	let host: { proc: Proc; alive: boolean } | undefined;
	// The command in flight and the host it was sent to: a host that already
	// retired never settles a command sent to its replacement.
	let waiting: { host: object; expect: string; resolve: () => void; reject: (error: Error) => void } | undefined;
	let queue: Promise<void> = Promise.resolve();
	let idle: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;

	const retire = (current: typeof host, kill: boolean) => {
		if (!current) return;
		current.alive = false;
		if (host === current) host = undefined;
		try {
			if (kill) current.proc.kill("SIGTERM");
			else current.proc.stdin?.end();
		} catch {
			/* already gone */
		}
	};
	const start = (): NonNullable<typeof host> => {
		if (host?.alive) return host;
		const proc = spawn(options.powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_HOST], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		const current = { proc, alive: true };
		host = current;
		let buffered = "";
		proc.stdout?.on("data", (data: unknown) => {
			buffered += String(data);
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (!line || waiting?.host !== current) continue;
				const pending = waiting;
				waiting = undefined;
				if (line === pending.expect) pending.resolve();
				else pending.reject(new Error("cue host refused"));
			}
		});
		proc.stderr?.on("data", () => {});
		proc.stdin?.on("error", () => {});
		const gone = () => {
			current.alive = false;
			if (host === current) host = undefined;
			if (waiting?.host !== current) return;
			const pending = waiting;
			waiting = undefined;
			pending.reject(new Error("cue host exited"));
		};
		proc.once("exit", gone);
		proc.once("error", gone);
		return current;
	};
	// One command at a time: send the line and wait for its answer.
	const command = (current: NonNullable<typeof host>, line: string, expect: string) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (waiting?.host === current) waiting = undefined;
				retire(current, true);
				reject(new Error("cue host timed out"));
			}, timeoutMs);
			waiting = {
				host: current,
				expect,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			current.proc.stdin?.write(`${line}\n`);
		});
	const loaded = new WeakSet<object>();
	const ensureLoaded = async (current: NonNullable<typeof host>) => {
		if (loaded.has(current)) return;
		for (const [name, bytes] of Object.entries(options.sounds)) await command(current, `load ${name} ${bytes.toString("base64")}`, `ok load ${name}`);
		loaded.add(current);
	};
	const armIdle = () => {
		if (idle) clearTimeout(idle);
		idle = setTimeout(() => retire(host, false), idleMs);
		idle.unref?.();
	};
	const serial = (work: () => Promise<void>): Promise<void> => {
		const run = queue.then(work, work);
		queue = run.catch(() => {});
		return run;
	};

	return {
		probe: async () => ({ available: !disposed }),
		play: (name) => {
			if (!SAFE_NAME.test(name) || !(name in options.sounds)) return Promise.reject(new Error(`unknown cue ${name}`));
			return serial(async () => {
				if (disposed) throw new Error("cue host disposed");
				const current = start();
				await ensureLoaded(current);
				await command(current, `play ${name}`, `ok play ${name}`);
				armIdle();
			});
		},
		warm: () => {
			if (disposed) return;
			void serial(async () => {
				if (disposed) return;
				await ensureLoaded(start());
				armIdle();
			}).catch(() => {});
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			if (idle) clearTimeout(idle);
			retire(host, false);
		},
	};
}
