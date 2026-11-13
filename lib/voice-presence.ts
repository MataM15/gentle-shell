import { execFile } from "node:child_process";
// Where voice may act (docs/voice.md, "Voice in a session"). The microphone
// reopens only in the pane the user is looking at, a reply is read only there
// (a reply from any other pane is held, S12), and readings from every Pi
// process take turns instead of talking over each other, a turn the voice
// listener arbitrates (lib/voice-listener.ts) and this module only falls back to
// locally when that listener cannot be reached.

export type CommandRunner = (command: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 2_000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
	});

// Outside herdr there is one terminal, so it counts as focused. Inside herdr
// only its own answer that this pane is focused counts: a failed or unclear
// lookup keeps the microphone closed.
export async function paneFocused(options: { env?: NodeJS.ProcessEnv; run?: CommandRunner } = {}): Promise<boolean> {
	return (await paneFocus(options)) === "focused";
}

// The same question with its third answer: "unknown" when herdr cannot say
// (no process, an error, an answer that is not JSON, or a field that is neither
// true nor false). The microphone resolves unknown as unfocused, because
// opening one in the wrong pane is worse than waiting; a spoken reply resolves
// it as focused, so a herdr that cannot answer never silences a reply (S12).
export type PaneFocus = "focused" | "unfocused" | "unknown";

export async function paneFocus(options: { env?: NodeJS.ProcessEnv; run?: CommandRunner } = {}): Promise<PaneFocus> {
	const env = options.env ?? process.env;
	const pane = env.HERDR_PANE_ID?.trim();
	if (!pane) return "focused";
	try {
		const output = await (options.run ?? runCommand)(env.HERDR_BIN_PATH?.trim() || "herdr", ["pane", "get", pane]);
		const parsed: unknown = JSON.parse(output);
		const focused = (parsed as { result?: { pane?: { focused?: unknown } } } | null)?.result?.pane?.focused;
		if (focused === true) return "focused";
		if (focused === false) return "unfocused";
		return "unknown";
	} catch {
		return "unknown";
	}
}

// The reading turn a session falls back to when the voice listener cannot be
// reached (S6, slice B): one reply at a time inside this process. The shared
// turn across sessions is the listener's; this one is never a second arbiter.
interface LocalWaiter {
	signal?: AbortSignal;
	resolve: (release: (() => void) | undefined) => void;
	abandon: () => void;
}

const localQueue: LocalWaiter[] = [];
let localHolder: (() => void) | undefined;

const makeRelease = (): (() => void) => {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		localHolder = undefined;
		nextLocalTurn();
	};
};

function nextLocalTurn(): void {
	while (localQueue.length > 0) {
		const waiter = localQueue.shift()!;
		waiter.signal?.removeEventListener("abort", waiter.abandon);
		if (waiter.signal?.aborted) {
			waiter.resolve(undefined);
			continue;
		}
		localHolder = makeRelease();
		waiter.resolve(localHolder);
		return;
	}
}

// Resolves with the release of the local reading turn, or undefined when the
// reading was cancelled while it waited. A waiting reading keeps its place in
// order, so a cancelled one never lets a later reading start first.
export function acquireLocalReadingTurn(options: { signal?: AbortSignal } = {}): Promise<(() => void) | undefined> {
	if (localHolder === undefined) {
		localHolder = makeRelease();
		return Promise.resolve(localHolder);
	}
	if (options.signal?.aborted) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const waiter: LocalWaiter = { signal: options.signal, resolve, abandon: () => undefined };
		waiter.abandon = () => {
			const index = localQueue.indexOf(waiter);
			if (index >= 0) localQueue.splice(index, 1);
			resolve(undefined);
		};
		options.signal?.addEventListener("abort", waiter.abandon, { once: true });
		localQueue.push(waiter);
	});
}
