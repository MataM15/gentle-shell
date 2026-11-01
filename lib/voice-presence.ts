import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Where voice may act (docs/voice.md, "Voice in a session"). The microphone
// reopens only in the pane the user is looking at, and readings from every Pi
// process take turns instead of talking over each other.

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 2_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
	});

// Outside herdr there is one terminal, so it counts as focused. Inside herdr
// only its own answer that this pane is focused counts: a failed or unclear
// lookup keeps the microphone closed.
export async function paneFocused(options: { env?: NodeJS.ProcessEnv; run?: CommandRunner } = {}): Promise<boolean> {
	const env = options.env ?? process.env;
	const pane = env.HERDR_PANE_ID?.trim();
	if (!pane) return true;
	try {
		const output = await (options.run ?? runCommand)(env.HERDR_BIN_PATH?.trim() || "herdr", ["pane", "get", pane]);
		const parsed: unknown = JSON.parse(output);
		const focused = (parsed as { result?: { pane?: { focused?: unknown } } } | null)?.result?.pane?.focused;
		return focused === true;
	} catch {
		return false;
	}
}

export const READING_TURN_FILE = "reading-turn.json";

export interface ReadingTurnOptions {
	// The voice home, shared by every Pi process of this user.
	dir: string;
	signal: AbortSignal;
	pid?: number;
	isAlive?: (pid: number) => boolean;
	pollMs?: number;
	maxWaitMs?: number;
}

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

const holderOf = (path: string): number | undefined => {
	try {
		const pid: unknown = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown } | null)?.pid;
		return Number.isSafeInteger(pid) && (pid as number) > 0 ? (pid as number) : undefined;
	} catch {
		return undefined;
	}
};

// Waits for the one reading turn shared by every Pi process and returns its
// release, or undefined when the reading was cancelled or waited past
// maxWaitMs. The turn is a file created exclusively; a turn whose process is
// gone, or whose file cannot be read, is taken over.
export async function acquireReadingTurn(options: ReadingTurnOptions): Promise<(() => void) | undefined> {
	const path = join(options.dir, READING_TURN_FILE);
	const pid = options.pid ?? process.pid;
	const isAlive = options.isAlive ?? processAlive;
	const pollMs = options.pollMs ?? 250;
	const deadline = Date.now() + (options.maxWaitMs ?? 180_000);
	try {
		mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	} catch {
		/* the exclusive create below reports a real failure */
	}
	for (;;) {
		if (options.signal.aborted) return undefined;
		try {
			writeFileSync(path, JSON.stringify({ pid }), { flag: "wx", mode: 0o600 });
			let released = false;
			return () => {
				if (released) return;
				released = true;
				// Only our own turn is removed, never one another process took over.
				if (holderOf(path) !== pid) return;
				try {
					unlinkSync(path);
				} catch {
					/* already gone */
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
		}
		const holder = holderOf(path);
		if (holder === undefined || !isAlive(holder)) {
			try {
				unlinkSync(path);
			} catch {
				/* someone else cleared it first */
			}
			continue;
		}
		if (Date.now() >= deadline) return undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, pollMs);
			function done() {
				clearTimeout(timer);
				options.signal.removeEventListener("abort", done);
				resolve();
			}
			options.signal.addEventListener("abort", done, { once: true });
		});
	}
}
