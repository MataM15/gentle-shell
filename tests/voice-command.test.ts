import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import gentleVoice from "../extensions/gentle-voice.ts";
import { VoiceInstallError, type VoiceInstallProgress, type VoiceInstallResult } from "../lib/voice-install.ts";
import { VoiceSessionError, type VoiceSessionState, type VoiceTranscript } from "../lib/voice-session.ts";
import { VOICE_COMMAND_NAME, type VoiceCommandDeps, type VoiceDictation } from "../lib/voice-command.ts";
import type { PushToTalkTimers } from "../lib/voice-push-to-talk.ts";
import type { VoiceSpeechSettings } from "../lib/voice-settings.ts";
import { SpeechEngineError, type SpeechEngine, type SpeechOptions, type SpeechOutcome } from "../lib/voice-speech.ts";

// /gentle:voice through its registered command, with fake UI, acquisition and
// session adapters: nothing here downloads, loads native code or opens a
// microphone.

type Handler = (event: unknown, ctx: unknown) => unknown;
type Component = { render(width: number): string[]; handleInput?(data: string): void };

// A broken lifecycle shows up as a hang; fail it instead of waiting forever.
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 5_000 }, fn);

const ENTER = "\r";
const ESC = "\x1b";
const VOICE_HOME = "/home/user/.pi/gentle-ai/voice";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, attempts = 200) {
	for (let attempt = 0; attempt < attempts && !check(); attempt++) await tick();
	assert.ok(check(), "condition not reached");
}

type Shortcut = { description?: string; handler(ctx: unknown): Promise<void> | void };

function fakePi() {
	const commands = new Map<string, { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const shortcuts = new Map<string, Shortcut>();
	const handlers = new Map<string, Handler[]>();
	const counts = { tools: 0, shortcuts: 0, sends: 0 };
	// Extension-to-extension events, as the parent shell receives them.
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const sent: Array<{ content: unknown; options?: unknown }> = [];
	const pi = {
		registerCommand: (name: string, registration: { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, registration),
		registerTool: () => { counts.tools++; },
		registerShortcut: (key: string, options: Shortcut) => { counts.shortcuts++; shortcuts.set(key, options); },
		sendUserMessage: (content: unknown, options?: unknown) => { counts.sends++; sent.push({ content, options }); },
		sendMessage: () => { counts.sends++; },
		events: { emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); }, on: () => () => {} },
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: unknown = {}, payload: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { pi, commands, shortcuts, handlers, counts, emitted, sent, fire };
}

interface UiScript {
	select?: (title: string, options: string[]) => string | undefined;
	confirm?: (title: string, message: string) => boolean;
}

function fakeContext(script: UiScript = {}, mode = "tui", hasUI = true, sessionId: string | undefined = "session-alpha", idle = () => true) {
	const notices: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const events: string[] = [];
	const renders: Array<boolean | undefined> = [];
	let editor = "draft: ";
	let component: Component | undefined;
	let open = false;
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const statuses: Array<string | undefined> = [];
	const terminal = { subscribes: 0, unsubscribes: 0 };
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: (force?: boolean) => renders.push(force) };
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI,
		mode,
		isIdle: idle,
		cwd: "/work/alpha",
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (message: string, type?: string) => { notices.push({ message, type }); events.push(`notify:${message}`); },
			select: async (title: string, options: string[]) => { selects.push({ title, options }); return script.select?.(title, options); },
			confirm: async (title: string, message: string) => { confirms.push({ title, message }); return script.confirm?.(title, message) ?? false; },
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component) =>
				new Promise((resolve) => {
					open = true;
					events.push("open");
					component = factory(tui, theme, {}, (value) => { open = false; events.push("close"); resolve(value); });
				}),
			pasteToEditor: (text: string) => { editor += text; events.push(`paste:${text}`); },
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
			onTerminalInput: (listener: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				terminal.subscribes++;
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) { listeners.splice(index, 1); terminal.unsubscribes++; }
				};
			},
			setStatus: (key: string, text: string | undefined) => { if (key === "gentle-voice") statuses.push(text); },
		},
	} as unknown as ExtensionCommandContext;
	// Raw input as Pi's TUI routes it: listeners first, then the focused editor,
	// which appends text and treats DEL as Backspace.
	const type = (data: string) => {
		let current = data;
		for (const listener of [...listeners]) {
			const result = listener(current);
			if (result?.consume) return;
			if (result?.data !== undefined) current = result.data;
		}
		if (current === "\x7f") editor = editor.slice(0, -1);
		else editor += current;
	};
	return { ctx, notices, selects, confirms, events, renders, statuses, terminal, type, editor: () => editor, component: () => component, open: () => open };
}

class FakeSession implements VoiceDictation {
	state: VoiceSessionState = "idle";
	readonly calls: string[] = [];
	readonly started = deferred<void>();
	readonly result = deferred<VoiceTranscript>();
	readonly onStateChange: (state: VoiceSessionState) => void;
	constructor(onStateChange: (state: VoiceSessionState) => void) {
		this.onStateChange = onStateChange;
		this.result.promise.catch(() => {});
	}
	emit(state: VoiceSessionState) {
		this.state = state;
		this.onStateChange(state);
	}
	async start() {
		this.calls.push("start");
		this.emit("starting");
		await this.started.promise;
		this.emit("recording");
	}
	async stop() {
		this.calls.push("stop");
		if (this.state === "recording") this.emit("transcribing");
		const transcript = await this.result.promise;
		this.emit("finished");
		return transcript;
	}
	async cancel() {
		this.calls.push("cancel");
		this.emit("finished");
	}
}

function manualClock() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const timers: PushToTalkTimers = {
		setTimeout: (callback, ms) => {
			const id = nextId++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => { pending.delete(handle as number); },
		now: () => now,
		// Runs right after the timer that deferred it, as setImmediate would with no queued input.
		defer: (callback) => { deferred.push(callback); },
	};
	const deferred: Array<() => void> = [];
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of pending) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			pending.delete(due[0]);
			now = due[1].at;
			due[1].callback();
			while (deferred.length > 0) deferred.shift()!();
		}
		now = target;
	};
	return { timers, advance };
}

interface Harness {
	deps: VoiceCommandDeps;
	calls: string[];
	sessions: FakeSession[];
	endpoints: Array<{ endOfSpeechMs: number; noSpeechMs: number } | undefined>;
	installs: Array<{ kind: string; options: Record<string, unknown> }>;
	settings: { enabled: boolean; reads: number; writes: boolean[] };
	speech: { current: VoiceSpeechSettings; writes: VoiceSpeechSettings[] };
	clock: ReturnType<typeof manualClock>;
}

function harness(overrides: { platform?: string; arch?: string; installed?: boolean; install?: (kind: "runtime" | "model", options: { signal: AbortSignal; onProgress(progress: VoiceInstallProgress): void }) => Promise<VoiceInstallResult>; env?: NodeJS.ProcessEnv; pushToTalk?: boolean; speech?: Partial<VoiceSpeechSettings>; engine?: SpeechEngine } = {}): Harness {
	const calls: string[] = [];
	const sessions: FakeSession[] = [];
	const endpoints: Harness["endpoints"] = [];
	const installs: Harness["installs"] = [];
	// The toggle store is always faked: no test reads or writes the real config home.
	const settings = { enabled: overrides.pushToTalk ?? false, reads: 0, writes: [] as boolean[] };
	// Spoken replies are faked too: no test reaches PowerShell or the config home.
	const speech = { current: { speakReplies: false, conversation: false, ...overrides.speech }, writes: [] as VoiceSpeechSettings[] };
	const clock = manualClock();
	const state = overrides.installed ? "installed" : "missing";
	const install = overrides.install ?? (async (kind) => ({ kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false }));
	const deps: VoiceCommandDeps = {
		env: overrides.env ?? {},
		probe: () => { calls.push("probe"); return { platform: overrides.platform ?? "darwin", arch: overrides.arch ?? "arm64" }; },
		readStatus: async (target) => {
			calls.push(`status:${target}`);
			return { voiceHome: VOICE_HOME, model: { kind: "model", state, path: `${VOICE_HOME}/models/m` }, runtime: { kind: "runtime", state, path: `${VOICE_HOME}/runtime/r` } };
		},
		installRuntime: async (options) => { calls.push("install:runtime"); installs.push({ kind: "runtime", options: options as unknown as Record<string, unknown> }); return install("runtime", options); },
		installModel: async (options) => { calls.push("install:model"); installs.push({ kind: "model", options: options as unknown as Record<string, unknown> }); return install("model", options); },
		createSession: (options) => {
			calls.push(`session:${options.target}`);
			endpoints.push(options.endpoint);
			const session = new FakeSession(options.onStateChange);
			sessions.push(session);
			return session;
		},
		settings: {
			read: () => { settings.reads++; return settings.enabled; },
			write: (enabled) => { settings.writes.push(enabled); settings.enabled = enabled; },
		},
		pushToTalk: { timers: clock.timers },
		speechEngine: () => overrides.engine,
		speechSettings: {
			read: () => ({ ...speech.current }),
			write: (next) => { speech.writes.push({ ...next }); speech.current = { ...next }; },
		},
	};
	return { deps, calls, sessions, endpoints, installs, settings, speech, clock };
}

const pick = (pattern: RegExp) => (_title: string, options: string[]) => options.find((option) => pattern.test(option));

function register(h: Harness) {
	const pi = fakePi();
	gentleVoice(pi.pi, h.deps);
	return pi;
}

async function run(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	return pi.commands.get(VOICE_COMMAND_NAME)!.handler("", ui.ctx);
}

// --- registration and refusals ------------------------------------------------

test("registers only /gentle:voice and one dictation shortcut, and does no voice work at registration or session start", async () => {
	const h = harness();
	const pi = register(h);
	assert.equal(VOICE_COMMAND_NAME, "gentle:voice");
	assert.deepEqual([...pi.commands.keys()], ["gentle:voice"]);
	assert.match(pi.commands.get(VOICE_COMMAND_NAME)!.description, /dictation/i);
	assert.equal(pi.counts.tools, 0, "no model-callable tool");
	assert.deepEqual([...pi.shortcuts.keys()], ["alt+m"], "one shortcut, and it is the free default");
	assert.equal(pi.counts.sends, 0);
	await pi.fire("session_start");
	assert.deepEqual(h.calls, []);
});

test("a delegated child session refuses before any probe, status read or UI", async () => {
	const h = harness({ env: { GENTLE_PI_AGENTS_CHILD: "1" }, installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/dictat/i) });
	await run(pi, ui);
	assert.deepEqual(h.calls, []);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /delegated/i);
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
});

test("non-TUI modes refuse without voice work", async () => {
	for (const [mode, hasUI] of [["rpc", true], ["print", false]] as const) {
		const h = harness({ installed: true });
		const pi = register(h);
		const ui = fakeContext({ select: pick(/dictat/i) }, mode, hasUI);
		await run(pi, ui);
		assert.deepEqual(h.calls, [], mode);
		assert.equal(ui.selects.length, 0, mode);
		assert.equal(ui.editor(), "draft: ", mode);
	}
});

test("an unsupported platform is explained and offers no download", async () => {
	const h = harness({ platform: "win32", arch: "arm64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	assert.deepEqual(h.calls, ["probe"]);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /Windows ARM64/);
	assert.equal(ui.notices[0]!.type, "error");
});

// --- installation -------------------------------------------------------------

test("a missing install offers the download and declining it downloads nothing", async () => {
	const h = harness({ platform: "win32", arch: "x64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => false });
	await run(pi, ui);
	assert.ok(!ui.selects[0]!.options.some((option) => /start dictation/i.test(option)), "dictation needs an install first");
	const { message } = ui.confirms[0]!;
	assert.match(message, /MB/);
	assert.ok(message.includes(VOICE_HOME), "names the destination");
	assert.match(message, /CC-BY-4\.0/);
	assert.match(message, /NVIDIA/);
	assert.match(message, /Apache-2\.0/);
	assert.match(message, /Visual C\+\+/);
	assert.match(message, /not .*installed by Gentle AI|never (downloads|installs)/i);
	assert.ok(!h.calls.some((call) => call.startsWith("install:")));
	assert.equal(ui.editor(), "draft: ");
});

test("an accepted download installs runtime then model with progress and pinned defaults", async () => {
	const gate = deferred<void>();
	const h = harness({
		install: async (kind, options) => {
			options.onProgress({ component: kind, phase: "download", item: kind === "model" ? "encoder.int8.onnx" : "node-cpal", receivedBytes: 50, totalBytes: 100, overallReceivedBytes: 50, overallTotalBytes: 100 });
			if (kind === "model") await gate.promise;
			return { kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false };
		},
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:model"));
	assert.ok(ui.open());
	const screen = ui.component()!.render(80).join("\n");
	assert.match(screen, /50%/);
	assert.match(screen, /encoder\.int8\.onnx/);
	assert.match(screen, /esc/i);
	gate.resolve();
	await done;
	assert.deepEqual(h.calls.filter((call) => call.startsWith("install:")), ["install:runtime", "install:model"]);
	for (const install of h.installs) {
		assert.ok(install.options.signal instanceof AbortSignal);
		for (const key of ["manifest", "manifests", "fetch"]) assert.equal(key in install.options, false, `${install.kind} gets no ${key} override`);
	}
	assert.equal(h.installs[0]!.options.target, "darwin-arm64");
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /installed/i);
	assert.equal(ui.editor(), "draft: ");
});

test("Esc during a download aborts it and keeps nothing", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "raw /secret/path")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!h.calls.includes("install:model"));
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	assert.ok(!ui.notices.some((notice) => notice.message.includes("/secret/path")), "fixed messages only");
});

test("a failed download reports a fixed message without raw error text", async () => {
	const h = harness({ install: async () => { throw new VoiceInstallError("integrity", "encoder at /home/user/x does not match"); } });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /digest|verif/i);
	assert.ok(!last.message.includes("/home/user/x"));
	assert.ok(!ui.open());
});

// --- dictation ----------------------------------------------------------------

async function startDictation(h: Harness, pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1 && ui.open());
	const session = h.sessions[0]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	return { done, session };
}

test("Enter stops recording, closes the overlay and pastes the exact transcript into the draft", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	assert.match(ui.component()!.render(80).join("\n"), /recording/i);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.component()!.render(80).join("\n"), /transcrib/i);
	assert.ok(ui.open(), "stays open until the transcript settles");
	session.result.resolve({ text: "hola canción", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: hola canción");
	assert.ok(ui.events.indexOf("close") < ui.events.indexOf("paste:hola canción"), "closes before pasting");
	assert.equal(pi.counts.sends, 0, "never submits");
	assert.deepEqual(session.calls, ["start", "stop"]);
});

test("Esc while recording cancels the session and leaves the draft untouched", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ESC);
	await done;
	session.result.resolve({ text: "late text", truncated: false });
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});

test("the recording limit transcribes by itself and delivers without a key press", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	session.emit("transcribing");
	session.result.resolve({ text: "limit reached", truncated: true });
	session.emit("finished");
	await done;
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: limit reached");
	assert.match(ui.notices.map((notice) => notice.message).join("\n"), /limit/i);
});

test("a session failure shows its fixed message with a user action and pastes nothing", async () => {
	const h = harness({ installed: true, platform: "linux", arch: "x64" });
	h.deps.probe = () => ({ platform: "linux", arch: "x64", glibcVersion: "2.39" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.reject(new VoiceSessionError("runtime-load"));
	await done;
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /could not be loaded/);
	assert.match(last.message, /libasound|ALSA/);
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
});

test("a second /gentle:voice while one is active is refused with a notice", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	const second = fakeContext({ select: pick(/start dictation/i) });
	await run(pi, second);
	assert.equal(h.sessions.length, 1, "no parallel session");
	assert.match(second.notices[0]!.message, /already/i);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
	// The lock is released once the first run settles.
	const third = fakeContext({ select: () => undefined });
	await run(pi, third);
	assert.equal(third.selects.length, 1);
});

test("session shutdown cancels an active dictation and drops a late transcript", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	await pi.fire("session_shutdown");
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	// The state observer stays safe after teardown.
	assert.doesNotThrow(() => session.onStateChange("finished"));
});

test("session shutdown aborts an active download", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "cancelled")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	await pi.fire("session_shutdown");
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!ui.open());
	assert.ok(!h.calls.includes("install:model"));
});

test("status reports the target, both components and the unverified hardware state", async () => {
	const h = harness({ platform: "linux", arch: "arm64" });
	h.deps.probe = () => ({ platform: "linux", arch: "arm64", glibcVersion: "2.35", wsl: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/status/i) });
	await run(pi, ui);
	const message = ui.notices.at(-1)!.message;
	assert.match(message, /linux-arm64/);
	assert.match(message, /unproven/i);
	assert.match(message, /model: missing/i);
	assert.match(message, /runtime: missing/i);
	assert.match(message, /not been verified on hardware/);
	assert.match(message, /libasound/);
	assert.ok(!h.calls.some((call) => call.startsWith("install:") || call.startsWith("session:")));
});

test("a transcript that arrives while cancelling is dropped", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	// As with the real worker, the result line can land before the process closes.
	session.cancel = async () => {
		session.calls.push("cancel");
		session.result.resolve({ text: "raced", truncated: false });
		await tick();
		session.emit("finished");
	};
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal(ui.editor(), "draft: ");
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});

// --- push-to-talk (hold Space) ------------------------------------------------

const SPACE = " ";
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 40;
const RELEASE = 250;

async function startSession(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	await pi.fire("session_start", ui.ctx);
}

// Space pressed and held: the first space, then `repeats` OS auto-repeats.
function holdSpace(h: Harness, ui: ReturnType<typeof fakeContext>, repeats: number, first = true) {
	if (first) ui.type(SPACE);
	for (let index = 0; index < repeats; index++) {
		h.clock.advance(first && index === 0 ? REPEAT_DELAY : REPEAT_INTERVAL);
		ui.type(SPACE);
	}
}

// Holds Space until a dictation is recording, as on the very first hold of a
// session: the install check runs lazily while the spaces are still typed.
async function holdUntilRecording(h: Harness, ui: ReturnType<typeof fakeContext>) {
	holdSpace(h, ui, 4);
	await until(() => h.calls.some((call) => call.startsWith("status:")));
	await tick();
	holdSpace(h, ui, 1, false);
	assert.equal(h.sessions.length, 1, "the hold started one dictation");
	holdSpace(h, ui, 4, false);
	const session = h.sessions[0]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	return session;
}

test("startup arms push-to-talk only when enabled, reading the toggle and nothing else", async () => {
	const enabled = harness({ installed: true, pushToTalk: true });
	const pi = register(enabled);
	const ui = fakeContext();
	await startSession(pi, ui);
	assert.equal(ui.terminal.subscribes, 1);
	assert.equal(enabled.settings.reads, 1);
	assert.deepEqual(enabled.calls, [], "no probe, status read, download or session at startup");

	const disabled = harness({ installed: true });
	const off = register(disabled);
	const typing = fakeContext();
	await startSession(off, typing);
	assert.equal(typing.terminal.subscribes, 0, "no listener when disabled");
	holdSpace(disabled, typing, 6);
	typing.type("a");
	assert.equal(typing.editor(), `draft: ${SPACE.repeat(7)}a`, "typing is unchanged");
	assert.deepEqual(disabled.calls, []);
});

test("child sessions and non-TUI modes never arm or read the toggle", async () => {
	const child = harness({ installed: true, pushToTalk: true, env: { GENTLE_PI_AGENTS_CHILD: "1" } });
	const childPi = register(child);
	const childUi = fakeContext();
	await startSession(childPi, childUi);
	assert.equal(childUi.terminal.subscribes, 0);
	for (const [mode, hasUI] of [["rpc", true], ["print", false]] as const) {
		const h = harness({ installed: true, pushToTalk: true });
		const pi = register(h);
		const ui = fakeContext({}, mode, hasUI);
		await startSession(pi, ui);
		assert.equal(ui.terminal.subscribes, 0, mode);
		assert.equal(h.settings.reads, 0, mode);
	}
	assert.equal(child.settings.reads, 0);
});

test("holding Space records, releasing it pastes the transcript into the draft and never sends", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	assert.equal(ui.editor(), "draft: ", "every space typed by the hold was erased");
	assert.match(ui.statuses.at(-1) ?? "", /recording/i);
	assert.ok(!ui.open(), "no overlay steals the editor focus");
	h.clock.advance(RELEASE);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.statuses.at(-1) ?? "", /transcrib/i);
	session.result.resolve({ text: "hola mundo", truncated: false });
	await until(() => ui.editor() === "draft: hola mundo");
	await until(() => ui.statuses.at(-1) === undefined);
	assert.equal(pi.counts.sends, 0);
	assert.deepEqual(session.calls, ["start", "stop"]);
	assert.deepEqual(h.calls.filter((call) => call === "probe").length, 1, "the install is checked once per session");
	// The lock is free again: a second hold starts a second dictation directly.
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 2);
});

test("a release before recording starts stops as soon as recording begins", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	holdSpace(h, ui, 4);
	await until(() => h.calls.some((call) => call.startsWith("status:")));
	await tick();
	holdSpace(h, ui, 1, false);
	const session = h.sessions[0]!;
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
	session.started.resolve();
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "short", truncated: false });
	await until(() => ui.editor().endsWith("short"));
});

test("Esc during a hold cancels the dictation and leaves the draft unchanged", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	ui.type(ESC);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "dropped", truncated: false });
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(ui.editor(), "draft: ", "Esc was consumed and nothing was pasted");
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
});

test("not installed: the hold types its spaces, notifies once and disarms", async () => {
	const h = harness({ pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	holdSpace(h, ui, 4);
	await until(() => ui.notices.length > 0);
	holdSpace(h, ui, 3, false);
	assert.equal(ui.editor(), `draft: ${SPACE.repeat(8)}`, "all eight spaces typed normally");
	assert.equal(h.sessions.length, 0);
	assert.match(ui.notices[0]!.message, /\/gentle:voice/);
	assert.equal(ui.terminal.unsubscribes, 1, "disarmed");
	h.clock.advance(RELEASE);
	holdSpace(h, ui, 4);
	assert.equal(ui.notices.length, 1, "notified once");
	assert.equal(h.settings.writes.length, 0, "the saved choice is kept");
});

test("a hold while /gentle:voice is dictating does not start a second session", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	await startSession(pi, ui);
	const { done, session } = await startDictation(h, pi, ui);
	holdSpace(h, ui, 6);
	await tick();
	assert.equal(h.sessions.length, 1);
	assert.equal(ui.editor(), `draft: ${SPACE.repeat(7)}`, "spaces pass through");
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
});

test("session shutdown cancels a held dictation, disarms and drops a late transcript", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	await pi.fire("session_shutdown");
	assert.equal(ui.terminal.unsubscribes, 1);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "too late", truncated: false });
	await tick();
	await tick();
	assert.equal(ui.editor(), "draft: ");
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
});

test("the /gentle:voice menu toggles push-to-talk, persists it and arms or disarms immediately", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/disable push-to-talk/i) });
	await startSession(pi, ui);
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Disable push-to-talk (hold Space)"));
	assert.deepEqual(h.settings.writes, [false]);
	assert.equal(ui.terminal.unsubscribes, 1);
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 0, "disarmed in the live session");

	const again = fakeContext({ select: pick(/enable push-to-talk/i) });
	await run(pi, again);
	assert.ok(again.selects[0]!.options.includes("Enable push-to-talk (hold Space)"));
	assert.deepEqual(h.settings.writes, [false, true]);
	assert.equal(again.terminal.subscribes, 1, "armed in the live session");
	// A reload reads the persisted choice.
	const reloaded = register(h);
	const fresh = fakeContext();
	await startSession(reloaded, fresh);
	assert.equal(fresh.terminal.subscribes, 1);
});

// --- toggle dictation (one shortcut starts and stops) -------------------------

const TOGGLE_KEY = "alt+m";

// Pi's editor offers each raw key to extension shortcuts before the draft sees
// it, so a press is the registered handler and the key never reaches the editor.
function press(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>, key = TOGGLE_KEY): Promise<void> {
	const shortcut = pi.shortcuts.get(key);
	assert.ok(shortcut, `the ${key} shortcut is registered`);
	return Promise.resolve(shortcut.handler(ui.ctx));
}

// One press, then the microphone opens: the install check runs lazily on it.
async function pressUntilRecording(h: Harness, pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	const done = press(pi, ui);
	await until(() => h.sessions.length === 1);
	const session = h.sessions[0]!;
	assert.match(ui.statuses.at(-1) ?? "", /prepar/i);
	session.started.resolve();
	await until(() => session.state === "recording");
	return { done, session };
}

test("the toggle shortcut starts a dictation and the same shortcut stops it, pasting but never sending", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const { done, session } = await pressUntilRecording(h, pi, ui);
	const status = ui.statuses.at(-1) ?? "";
	assert.match(status, /recording/i);
	assert.match(status, /alt\+m/i, "the status names the key that stops it");
	assert.ok(!ui.open(), "no overlay: the editor keeps the focus");
	assert.equal(pi.counts.sends, 0, "nothing is sent while recording");
	await press(pi, ui);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.statuses.at(-1) ?? "", /transcrib/i);
	session.result.resolve({ text: "hola mundo", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: hola mundo");
	assert.equal(h.sessions.length, 1, "one session for the whole toggle");
	assert.deepEqual(session.calls, ["start", "stop"]);
	assert.equal(pi.counts.sends, 0, "the transcript is pasted, never submitted");
	assert.equal(ui.statuses.at(-1), undefined, "the footer status is cleared");
});

test("a second press while preparing stops as soon as recording begins", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const done = press(pi, ui);
	await until(() => h.sessions.length === 1);
	const session = h.sessions[0]!;
	await press(pi, ui);
	assert.deepEqual(session.calls, ["start"], "no stop before the microphone is open");
	assert.match(ui.statuses.at(-1) ?? "", /prepar/i);
	session.started.resolve();
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "short", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: short");
	assert.deepEqual(session.calls, ["start", "stop"]);
});

test("a press while transcribing neither starts a second capture nor pastes twice", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const { done, session } = await pressUntilRecording(h, pi, ui);
	await press(pi, ui);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.statuses.at(-1) ?? "", /transcrib/i);
	await press(pi, ui);
	assert.equal(h.sessions.length, 1, "no second session while the first transcribes");
	assert.equal(h.calls.filter((call) => call.startsWith("session:")).length, 1);
	assert.deepEqual(session.calls, ["start", "stop"], "no extra stop or cancel");
	session.result.resolve({ text: "one", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: one");
});

test("Esc cancels a toggle dictation, is consumed and leaves the draft unchanged", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const { done, session } = await pressUntilRecording(h, pi, ui);
	ui.type(ESC);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "dropped", truncated: false });
	await done;
	await tick();
	assert.equal(ui.editor(), "draft: ", "Esc was consumed and nothing was pasted");
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	assert.equal(ui.terminal.unsubscribes, 1, "the Esc listener of the toggle is gone");
	assert.equal(ui.statuses.at(-1), undefined);
	assert.equal(pi.counts.sends, 0);
});

test("Esc while the install check still runs cancels before any session starts", async () => {
	const gate = deferred<void>();
	const h = harness({ installed: true });
	const readStatus = h.deps.readStatus!;
	h.deps.readStatus = async (target) => {
		await gate.promise;
		return readStatus(target);
	};
	const pi = register(h);
	const ui = fakeContext();
	const done = press(pi, ui);
	assert.ok(h.calls.includes("probe"), "the first press starts the lazy install check");
	ui.type(ESC);
	gate.resolve();
	await done;
	assert.equal(h.sessions.length, 0, "nothing was recorded or transcribed");
	assert.equal(ui.editor(), "draft: ");
	assert.equal(ui.statuses.at(-1), undefined);
});

test("a press while /gentle:voice is dictating is refused and starts no second session", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	const toggling = fakeContext();
	await press(pi, toggling);
	assert.equal(h.sessions.length, 1, "no second capture");
	assert.match(toggling.notices[0]!.message, /already/i);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
	// The lock is free again: the shortcut dictates on its own.
	const second = fakeContext();
	const secondDone = press(pi, second);
	await until(() => h.sessions.length === 2);
	h.sessions[1]!.started.resolve();
	await until(() => h.sessions[1]!.state === "recording");
	await press(pi, second);
	await until(() => h.sessions[1]!.calls.includes("stop"));
	h.sessions[1]!.result.resolve({ text: "two", truncated: false });
	await secondDone;
	assert.equal(second.editor(), "draft: two");
});

test("not installed: a press points to /gentle:voice, starts nothing and checks again on the next press", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext();
	await press(pi, ui);
	assert.equal(h.sessions.length, 0);
	assert.match(ui.notices.at(-1)!.message, /\/gentle:voice/);
	assert.equal(ui.statuses.at(-1), undefined);
	assert.equal(ui.terminal.unsubscribes, 1, "the Esc listener is gone");
	await press(pi, ui);
	assert.equal(h.calls.filter((call) => call === "probe").length, 2, "a missing install is not cached");
	assert.equal(h.sessions.length, 0);
});

test("session shutdown cancels a toggle dictation, clears the lock and drops a late transcript", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const { done, session } = await pressUntilRecording(h, pi, ui);
	await pi.fire("session_shutdown");
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.equal(ui.editor(), "draft: ");
	assert.equal(ui.terminal.unsubscribes, 1);
	assert.equal(pi.counts.sends, 0);
});

test("delegated child sessions and non-TUI modes ignore the shortcut without voice work", async () => {
	for (const [env, mode, hasUI] of [[{ GENTLE_PI_AGENTS_CHILD: "1" }, "tui", true], [{}, "rpc", true], [{}, "print", false]] as const) {
		const h = harness({ installed: true, env });
		const pi = register(h);
		const ui = fakeContext({}, mode, hasUI);
		await press(pi, ui);
		assert.deepEqual(h.calls, [], mode);
		assert.equal(ui.notices.length, 0, mode);
		assert.equal(ui.terminal.subscribes, 0, mode);
	}
});

test("GENTLE_PI_VOICE_TOGGLE_KEY rebinds the shortcut and off disables it", async () => {
	const custom = harness({ installed: true, env: { GENTLE_PI_VOICE_TOGGLE_KEY: "alt+o" } });
	const pi = register(custom);
	assert.deepEqual([...pi.shortcuts.keys()], ["alt+o"]);
	for (const value of ["off", "OFF", ""]) {
		const h = harness({ env: { GENTLE_PI_VOICE_TOGGLE_KEY: value } });
		assert.equal(register(h).shortcuts.size, 0, JSON.stringify(value));
	}
});

test("Enable is offered only when voice is installed", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext({ select: () => undefined });
	await run(pi, ui);
	assert.ok(!ui.selects[0]!.options.some((option) => /push-to-talk/i.test(option)));
});

test("a successful download enables push-to-talk and arms it", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await startSession(pi, ui);
	await run(pi, ui);
	assert.deepEqual(h.settings.writes, [true]);
	assert.equal(ui.terminal.subscribes, 1);
	assert.match(ui.notices.at(-1)!.message, /hold Space/i);
	// Already known installed: the first hold starts directly.
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 1);
});

test("a hold right after a word keeps one space before the pasted transcript", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	ui.type("hi");
	const session = await holdUntilRecording(h, ui);
	assert.equal(ui.editor(), "draft: hi ");
	h.clock.advance(RELEASE);
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "there", truncated: false });
	await until(() => ui.editor() === "draft: hi there");
});

// --- session-scoped voice state (display only) --------------------------------

// The display contract the parent shell consumes: one channel, one schema and
// exactly { schema, sessionId, state } per change, keyed by the real session.
const VOICE_STATE_CHANNEL = "gentle-ai:voice-state";
const VOICE_STATE_SCHEMA = "gentle-pi.voice-state/v1";

const voiceEvents = (pi: ReturnType<typeof fakePi>) =>
	pi.emitted.filter((event) => event.channel === VOICE_STATE_CHANNEL).map((event) => event.data as { schema: string; sessionId: string; state: string });
const voiceStates = (pi: ReturnType<typeof fakePi>) => voiceEvents(pi).map((event) => event.state);

test("the toggle publishes the exact session-scoped state for one dictation and ends idle", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({}, "tui", true, "session-alpha");
	const { done, session } = await pressUntilRecording(h, pi, ui);
	assert.deepEqual(voiceEvents(pi), [
		{ schema: VOICE_STATE_SCHEMA, sessionId: "session-alpha", state: "preparing" },
		{ schema: VOICE_STATE_SCHEMA, sessionId: "session-alpha", state: "listening" },
	], "preparing while it opens the microphone, listening only once it records");
	assert.equal(ui.editor(), "draft: ", "the display never touches the draft");
	await press(pi, ui);
	await until(() => session.calls.includes("stop"));
	assert.deepEqual(voiceStates(pi), ["preparing", "listening", "transcribing"]);
	session.result.resolve({ text: "hola mundo", truncated: false });
	await done;
	assert.deepEqual(voiceStates(pi), ["preparing", "listening", "transcribing", "idle"]);
	assert.ok(voiceEvents(pi).every((event) => event.sessionId === "session-alpha"));
	for (const event of voiceEvents(pi)) assert.deepEqual(Object.keys(event).sort(), ["schema", "sessionId", "state"]);
	assert.equal(ui.editor(), "draft: hola mundo", "the transcript still lands in the draft");
	assert.equal(pi.counts.sends, 0);
	assert.equal(ui.statuses.at(-1), undefined, "the footer is cleared with the display");
});

test("a cancelled hold publishes idle and leaves the draft and the send count untouched", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	assert.deepEqual(voiceStates(pi), ["idle", "preparing", "listening"], "a fresh session starts idle for its own id");
	assert.ok(voiceEvents(pi).every((event) => event.sessionId === "session-alpha"));
	ui.type(ESC);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "dropped", truncated: false });
	await until(() => voiceStates(pi).at(-1) === "idle");
	await tick();
	assert.deepEqual(voiceStates(pi), ["idle", "preparing", "listening", "idle"], "a cancelled run never reports transcribing");
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
});

test("the /gentle:voice dictation publishes its states for the session and ends idle", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	assert.deepEqual(voiceStates(pi), ["preparing", "listening"], "the overlay and the tab agree");
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "hola", truncated: false });
	await done;
	assert.deepEqual(voiceStates(pi), ["preparing", "listening", "transcribing", "idle"]);
	assert.equal(ui.editor(), "draft: hola");
	assert.equal(pi.counts.sends, 0);
});

test("a failed dictation publishes idle and keeps the draft", async () => {
	const h = harness({ installed: true, platform: "linux", arch: "x64" });
	h.deps.probe = () => ({ platform: "linux", arch: "x64", glibcVersion: "2.39" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.reject(new VoiceSessionError("runtime-load"));
	await done;
	assert.deepEqual(voiceStates(pi), ["preparing", "idle"], "an error clears the display");
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
});

test("session shutdown publishes idle for the ending session and drops a late callback and transcript", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	const { done, session } = await pressUntilRecording(h, pi, ui);
	await pi.fire("session_shutdown", ui.ctx);
	await until(() => session.calls.includes("cancel"));
	// A late callback and a late transcript from the dead session arrive after it.
	session.onStateChange("recording");
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.deepEqual(voiceStates(pi), ["preparing", "listening", "idle"]);
	assert.deepEqual(voiceEvents(pi).at(-1), { schema: VOICE_STATE_SCHEMA, sessionId: "session-alpha", state: "idle" });
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
});

test("a new session start cancels the old run, resets its display and starts clean", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	const { done, session } = await pressUntilRecording(h, pi, first);
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	// Nothing from the replaced run may reach the new session's display.
	session.onStateChange("recording");
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.deepEqual(voiceEvents(pi).filter((event) => event.sessionId === "session-beta"), [
		{ schema: VOICE_STATE_SCHEMA, sessionId: "session-beta", state: "idle" },
	], "the new session opens idle and never hears the old run");
	assert.deepEqual(voiceEvents(pi).at(-1), { schema: VOICE_STATE_SCHEMA, sessionId: "session-beta", state: "idle" });
	assert.deepEqual(voiceEvents(pi).filter((event) => event.sessionId === "session-alpha").at(-1), { schema: VOICE_STATE_SCHEMA, sessionId: "session-alpha", state: "idle" }, "the replaced session's display is reset");
	assert.equal(second.editor(), "draft: ", "no stale paste");
	assert.equal(first.editor(), "draft: ", "no stale paste into the old context either");
	assert.equal(pi.counts.sends, 0);
	assert.equal(second.terminal.subscribes, 0, "push-to-talk stays off in the new session");
	// The lock and the display belong to the new session: a press starts one run.
	const again = press(pi, second);
	await until(() => h.sessions.length === 2);
	const fresh = h.sessions[1]!;
	fresh.started.resolve();
	await until(() => fresh.state === "recording");
	assert.deepEqual(voiceEvents(pi).filter((event) => event.sessionId === "session-beta").map((event) => event.state), ["idle", "preparing", "listening"]);
	await press(pi, second);
	await until(() => fresh.calls.includes("stop"));
	fresh.result.resolve({ text: "nuevo", truncated: false });
	await again;
	assert.equal(second.editor(), "draft: nuevo");
});

test("a new session start publishes no late held transcript or state and frees the lock", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	await startSession(pi, first);
	const session = await holdUntilRecording(h, first);
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	await until(() => session.onStateChange("recording") === undefined);
	session.result.resolve({ text: "too late", truncated: false });
	await tick();
	await tick();
	assert.equal(first.editor(), "draft: ", "the replaced session pastes nothing");
	assert.deepEqual(voiceStates(pi).filter((state, index) => voiceEvents(pi)[index]!.sessionId === "session-beta"), ["idle"]);
	assert.equal(first.terminal.unsubscribes, 1, "the old session is disarmed");
	assert.equal(pi.counts.sends, 0);
});

test("a new session start stops a command that was still waiting instead of dictating for it", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	let answer: ((choice: string | undefined) => void) | undefined;
	const ui = fakeContext();
	// A menu that answers only when this test says so: the session is replaced
	// while the command is still waiting for the user.
	(ui.ctx as unknown as { ui: { select(title: string, options: string[]): Promise<string | undefined> } }).ui.select =
		(_title, options) => new Promise<string | undefined>((resolve) => { answer = (choice) => resolve(choice ?? options.find((option) => /start dictation/i.test(option))); });
	const done = run(pi, ui);
	await until(() => answer !== undefined);
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	answer!("Start dictation");
	await done;
	await tick();
	assert.equal(h.sessions.length, 0, "no capture starts for the replaced session");
	assert.equal(ui.editor(), "draft: ");
	assert.equal(ui.open(), false, "no overlay opened");
	assert.deepEqual(voiceEvents(pi).filter((event) => event.sessionId === "session-beta").map((event) => event.state), ["idle"]);
	assert.equal(ui.notices.length, 0, "nothing is said into the replaced session");
	assert.equal(pi.counts.sends, 0);
});

test("child and non-TUI sessions publish no voice state", async () => {
	for (const [env, mode, hasUI] of [[{ GENTLE_PI_AGENTS_CHILD: "1" }, "tui", true], [{}, "rpc", true], [{}, "print", false]] as const) {
		const h = harness({ installed: true, env });
		const pi = register(h);
		const ui = fakeContext({}, mode, hasUI);
		await pi.fire("session_start", ui.ctx);
		await press(pi, ui);
		assert.deepEqual(voiceEvents(pi), [], mode);
		assert.deepEqual(h.calls, [], mode);
		// Teardown of a session that never used voice publishes nothing either.
		await pi.fire("session_shutdown", ui.ctx);
		assert.deepEqual(voiceEvents(pi), [], mode);
	}
});

// --- one capture at a time across a session replacement -----------------------

// Where the microphone is actually claimed: runDictation creates the session
// object but only start() launches the worker, so this counts live captures.
const captureStarts = (h: Harness) => h.sessions.filter((session) => session.calls.includes("start")).length;
const statesFor = (pi: ReturnType<typeof fakePi>, sessionId: string) =>
	voiceEvents(pi).filter((event) => event.sessionId === sessionId).map((event) => event.state);

test("a session replacement starts no second capture until the old session's cancel settles", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	const { done, session } = await pressUntilRecording(h, pi, first);
	// The replaced session's worker is still alive after it was told to cancel.
	const release = deferred<void>();
	let cancelSettled = false;
	session.cancel = async () => { session.calls.push("cancel"); await release.promise; cancelSettled = true; };
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	const fresh = press(pi, second);
	await until(() => h.sessions.length === 2);
	h.sessions[1]!.started.resolve();
	await tick();
	await tick();
	assert.equal(cancelSettled, false, "the old capture has not closed yet");
	assert.equal(captureStarts(h), 1, "the replaced session's capture is still the only one");
	assert.deepEqual(statesFor(pi, "session-beta"), ["idle", "preparing"], "the new run waits without claiming the microphone");
	release.resolve();
	await until(() => h.sessions[1]!.state === "recording");
	assert.equal(captureStarts(h), 2, "the new capture starts once the old one has closed");
	assert.deepEqual(statesFor(pi, "session-beta"), ["idle", "preparing", "listening"]);
	await done;
	await tick();
	assert.equal(first.editor(), "draft: ", "the replaced session pastes nothing");
	assert.equal(first.notices.length, 0, "the replaced session is never notified again");
	await press(pi, second);
	await until(() => h.sessions[1]!.calls.includes("stop"));
	h.sessions[1]!.result.resolve({ text: "nuevo", truncated: false });
	await fresh;
	assert.equal(second.editor(), "draft: nuevo", "the new session pastes its own transcript once");
	assert.equal(pi.counts.sends, 0);
});

test("a hold in the new session waits for the replaced session's capture to close", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	await startSession(pi, first);
	const session = await holdUntilRecording(h, first);
	const release = deferred<void>();
	let cancelSettled = false;
	session.cancel = async () => { session.calls.push("cancel"); await release.promise; cancelSettled = true; };
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	assert.equal(second.terminal.subscribes, 1, "push-to-talk is armed in the new session at once");
	holdSpace(h, second, 4);
	await until(() => h.sessions.length === 2);
	const fresh = h.sessions[1]!;
	holdSpace(h, second, 1, false);
	await tick();
	await tick();
	assert.equal(cancelSettled, false, "the replaced capture has not closed yet");
	assert.equal(captureStarts(h), 1, "the new hold waits for the old capture to close");
	assert.deepEqual(statesFor(pi, "session-beta"), ["idle", "preparing"], "a waiting hold never claims to listen");
	// Still holding: the detector erases the spaces it typed, so the draft is clean
	// before any capture exists.
	holdSpace(h, second, 4, false);
	assert.equal(second.editor(), "draft: ", "the hold typed nothing during the wait");
	release.resolve();
	fresh.started.resolve();
	await until(() => fresh.state === "recording");
	assert.equal(captureStarts(h), 2, "the new hold records once the old capture has closed");
	assert.deepEqual(statesFor(pi, "session-beta"), ["idle", "preparing", "listening"]);
	h.clock.advance(RELEASE);
	await until(() => fresh.calls.includes("stop"));
	fresh.result.resolve({ text: "nuevo", truncated: false });
	await until(() => second.editor() === "draft: nuevo");
	assert.equal(first.editor(), "draft: ", "the replaced session pastes nothing");
	assert.equal(pi.counts.sends, 0);
});

test("a third session still waits for the capture the first one left closing", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	const { done, session } = await pressUntilRecording(h, pi, first);
	const release = deferred<void>();
	session.cancel = async () => { session.calls.push("cancel"); await release.promise; };
	// alpha -> beta: beta starts no run, so it must not drop alpha's reservation.
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	const third = fakeContext({}, "tui", true, "session-gamma");
	await pi.fire("session_start", third.ctx);
	const fresh = press(pi, third);
	await until(() => h.sessions.length === 2);
	h.sessions[1]!.started.resolve();
	await tick();
	await tick();
	assert.equal(captureStarts(h), 1, "the third session still waits for the first capture");
	assert.deepEqual(statesFor(pi, "session-gamma"), ["idle", "preparing"]);
	release.resolve();
	await done;
	await until(() => h.sessions[1]!.state === "recording");
	assert.equal(captureStarts(h), 2, "one capture, then the next, never two");
	await pi.fire("session_shutdown", third.ctx);
	await fresh;
	await tick();
	for (const ui of [first, second, third]) assert.equal(ui.editor(), "draft: ", "no draft of a replaced session changes");
	assert.equal(pi.counts.sends, 0);
});

test("a waiting run in a replaced session cannot release an older capture's reservation", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const first = fakeContext({}, "tui", true, "session-alpha");
	const { done, session } = await pressUntilRecording(h, pi, first);
	const release = deferred<void>();
	let cancelSettled = false;
	session.cancel = async () => { session.calls.push("cancel"); await release.promise; cancelSettled = true; };
	// beta: its press creates a run that waits for alpha's capture and never starts.
	const second = fakeContext({}, "tui", true, "session-beta");
	await pi.fire("session_start", second.ctx);
	await until(() => session.calls.includes("cancel"));
	const waiting = press(pi, second);
	await until(() => h.sessions.length === 2);
	h.sessions[1]!.started.resolve();
	await tick();
	assert.equal(captureStarts(h), 1, "beta waits for alpha's capture");
	// gamma replaces beta while beta never claimed the microphone. Beta's own
	// cancel resolves at once (no worker), and must not free alpha's barrier.
	const third = fakeContext({}, "tui", true, "session-gamma");
	await pi.fire("session_start", third.ctx);
	await waiting;
	const fresh = press(pi, third);
	await until(() => h.sessions.length === 3);
	h.sessions[2]!.started.resolve();
	await tick();
	await tick();
	assert.equal(cancelSettled, false, "alpha's worker has still not exited");
	assert.equal(captureStarts(h), 1, "gamma also waits for alpha's capture, not for beta's empty one");
	assert.deepEqual(statesFor(pi, "session-gamma"), ["idle", "preparing"], "no capture is claimed");
	release.resolve();
	await done;
	await until(() => h.sessions[2]!.state === "recording");
	assert.equal(captureStarts(h), 2, "only gamma starts once alpha has closed");
	assert.deepEqual(h.sessions.map((entry) => entry.calls.includes("start")), [true, false, true], "beta never started a capture");
	assert.deepEqual(statesFor(pi, "session-gamma"), ["idle", "preparing", "listening"]);
	await press(pi, third);
	await until(() => h.sessions[2]!.calls.includes("stop"));
	h.sessions[2]!.result.resolve({ text: "gamma", truncated: false });
	await fresh;
	assert.equal(third.editor(), "draft: gamma", "gamma pastes its transcript once");
	for (const ui of [first, second]) assert.equal(ui.editor(), "draft: ", "a replaced session pastes nothing");
	assert.deepEqual([first.notices.length, second.notices.length], [0, 0], "a replaced session is never notified");
	assert.equal(pi.counts.sends, 0);
});

test("an abandoned menu holds no capture: the new session dictates while it still waits", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	let answer: ((choice: string | undefined) => void) | undefined;
	const first = fakeContext();
	// A menu that answers only when this test says so: the session is replaced
	// while the command still waits, and it never reached a capture.
	(first.ctx as unknown as { ui: { select(title: string, options: string[]): Promise<string | undefined> } }).ui.select =
		(_title, options) => new Promise<string | undefined>((resolve) => { answer = (choice) => resolve(choice ?? options.find((option) => /start dictation/i.test(option))); });
	const done = run(pi, first);
	await until(() => answer !== undefined);
	const second = fakeContext({ select: pick(/start dictation/i) });
	await pi.fire("session_start", second.ctx);
	const fresh = run(pi, second);
	await until(() => h.sessions.length === 1 && h.sessions[0]!.state === "starting");
	assert.ok(answer, "the replaced menu is still waiting");
	assert.equal(captureStarts(h), 1, "the new session captures without waiting for the abandoned menu");
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	// The abandoned menu answers late and must do nothing at all.
	answer("Start dictation");
	await done;
	await tick();
	assert.equal(h.sessions.length, 1, "the replaced command never creates a session");
	assert.equal(first.editor(), "draft: ");
	assert.equal(first.notices.length, 0);
	await pi.fire("session_shutdown", second.ctx);
	await fresh;
	await tick();
	assert.equal(pi.counts.sends, 0);
});

// --- spoken replies (S1, S3) ------------------------------------------------------

function fakeEngine() {
	const readings: Array<{ text: string; options: SpeechOptions; finish: (outcome: SpeechOutcome) => void; fail: (error: unknown) => void }> = [];
	const engine: SpeechEngine = {
		id: "fake",
		speak: (text, options) => {
			const done = deferred<SpeechOutcome>();
			options.signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
			readings.push({ text, options, finish: done.resolve, fail: done.reject });
			return done.promise;
		},
	};
	return { engine, readings };
}

const reply = (text: string) => ({ messages: [{ role: "user", content: "pregunta" }, { role: "assistant", content: [{ type: "text", text }] }] });

async function settleReply(pi: ReturnType<typeof fakePi>, ctx: unknown, text: string, aborted = false) {
	await pi.fire("agent_start", ctx);
	await pi.fire("agent_end", ctx, reply(text));
	await pi.fire("agent_settled", ctx, { aborted });
}

test("a settled reply is read aloud in its language while spoken replies are on, then the footer clears", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Listo, **ya está** funcionando.\n```\ncode\n```");
	await until(() => readings.length === 1);
	assert.equal(readings[0]!.text, "Listo, ya está funcionando.");
	assert.equal(readings[0]!.options.language, "es");
	assert.equal(ui.statuses.at(-1), "Reading reply · esc stop · alt+m talk");
	assert.equal(ui.terminal.subscribes, 1);
	readings[0]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined && ui.terminal.unsubscribes === 1);
	assert.equal(ui.notices.length, 0);
	assert.equal(pi.counts.sends, 0, "a reading never sends anything");
});

test("nothing is read when spoken replies are off, the run was aborted, or the session is not a TUI parent", async () => {
	for (const scenario of [
		{ name: "off", speech: { speakReplies: false }, env: {}, mode: "tui", aborted: false },
		{ name: "aborted", speech: { speakReplies: true }, env: {}, mode: "tui", aborted: true },
		{ name: "child", speech: { speakReplies: true }, env: { GENTLE_PI_AGENTS_CHILD: "1" }, mode: "tui", aborted: false },
		{ name: "rpc", speech: { speakReplies: true }, env: {}, mode: "rpc", aborted: false },
	]) {
		const { engine, readings } = fakeEngine();
		const h = harness({ speech: scenario.speech, engine, env: scenario.env });
		const pi = register(h);
		const ui = fakeContext({}, scenario.mode);
		await pi.fire("session_start", ui.ctx);
		await settleReply(pi, ui.ctx, "Hola, esto no se lee.", scenario.aborted);
		await tick();
		assert.equal(readings.length, 0, scenario.name);
		assert.equal(ui.terminal.subscribes, 0, scenario.name);
	}
});

test("a run that ends with no reply text reads nothing, and an older reply is never read late", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await pi.fire("agent_start", ui.ctx);
	await pi.fire("agent_end", ui.ctx, reply("Respuesta vieja."));
	await pi.fire("agent_start", ui.ctx);
	await pi.fire("agent_end", ui.ctx, { messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }] }] });
	await pi.fire("agent_settled", ui.ctx, { aborted: false });
	await tick();
	assert.equal(readings.length, 0);
});

test("Esc stops a reading and is consumed before the editor or the agent sees it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Una respuesta larga para escuchar.");
	await until(() => readings.length === 1);
	ui.type(ESC);
	assert.equal(readings[0]!.options.signal.aborted, true);
	assert.equal(ui.editor(), "draft: ", "Esc never reaches the editor");
	await until(() => ui.statuses.at(-1) === undefined && ui.terminal.unsubscribes === 1);
	ui.type(ESC);
	assert.equal(ui.editor(), "draft: \x1b", "after the reading, Esc passes through again");
});

test("the dictation shortcut while reading stops the reading, then starts dictation", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine, installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Te estoy leyendo esto.");
	await until(() => readings.length === 1);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	assert.equal(readings[0]!.options.signal.aborted, true, "the reading stops at once");
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.sessions[0]!.calls, ["start"]);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	h.sessions[0]!.result.resolve({ text: "hola", truncated: false });
	await pressed;
	assert.equal(ui.editor(), "draft: hola", "dictation still pastes when conversation mode is off");
	assert.equal(pi.counts.sends, 0);
});

test("a new agent run stops the reading", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera respuesta.");
	await until(() => readings.length === 1);
	await pi.fire("agent_start", ui.ctx);
	assert.equal(readings[0]!.options.signal.aborted, true);
});

test("a second settled reply replaces the reading in progress", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera respuesta.");
	await until(() => readings.length === 1);
	await pi.fire("agent_end", ui.ctx, reply("Segunda respuesta."));
	await pi.fire("agent_settled", ui.ctx, { aborted: false });
	await until(() => readings.length === 2);
	assert.equal(readings[0]!.options.signal.aborted, true);
	assert.equal(readings[1]!.text, "Segunda respuesta.");
	assert.equal(ui.terminal.subscribes - ui.terminal.unsubscribes, 1, "one Esc listener at a time");
});

test("an engine failure is reported once with its fixed message", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Esto va a fallar.");
	await until(() => readings.length === 1);
	readings[0]!.fail(new SpeechEngineError("failed"));
	await until(() => ui.notices.length === 1);
	assert.deepEqual(ui.notices, [{ message: "The Windows voice could not read the reply.", type: "warning" }]);
	await until(() => ui.statuses.at(-1) === undefined);
});

test("the menu turns spoken replies on and off and persists the choice", async () => {
	const { engine } = fakeEngine();
	const h = harness({ engine });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Read replies aloud: turn on$/) });
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Read replies aloud: turn on"));
	assert.ok(!ui.selects[0]!.options.includes("Stop reading"));
	assert.deepEqual(h.speech.writes, [{ speakReplies: true, conversation: false }]);
	assert.match(ui.notices.at(-1)!.message, /read aloud/i);
	const again = fakeContext({ select: pick(/^Read replies aloud: turn off$/) });
	await run(pi, again);
	assert.ok(again.selects[0]!.options.includes("Read replies aloud: turn off"));
	assert.deepEqual(h.speech.writes.at(-1), { speakReplies: false, conversation: false });
});

test("turning spoken replies on without the Windows voice is refused and nothing is saved", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Read replies aloud: turn on$/) });
	await run(pi, ui);
	assert.deepEqual(h.speech.writes, []);
	assert.deepEqual(ui.notices.at(-1), { message: "Spoken replies need the Windows voice (Windows or WSL).", type: "warning" });
});

test("Stop reading is offered only while a reply is being read, and stops it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Stop reading$/) });
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta para cortar desde el menú.");
	await until(() => readings.length === 1);
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Stop reading"));
	assert.equal(readings[0]!.options.signal.aborted, true);
});

test("session shutdown cancels the reading, and a late failure paints nothing", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ speech: { speakReplies: true }, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta interrumpida.");
	await until(() => readings.length === 1);
	await pi.fire("session_shutdown", ui.ctx);
	assert.equal(readings[0]!.options.signal.aborted, true);
	assert.equal(ui.terminal.subscribes, ui.terminal.unsubscribes);
	readings[0]!.fail(new SpeechEngineError("failed"));
	await tick();
	assert.equal(ui.notices.length, 0);
	assert.equal(ui.statuses.at(-1), undefined);
});

// --- conversation mode (S2, S3) -------------------------------------------------------

const HANDS_FREE = { endOfSpeechMs: 1200, noSpeechMs: 8000 };

// A hands-free recording ends on its own: the worker reports transcribing, then
// the session finishes, and the transcript is collected without a key press.
async function speak(h: Harness, index: number, text: string) {
	const session = h.sessions[index]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	session.emit("transcribing");
	session.emit("finished");
	session.result.resolve({ text, truncated: false });
}

test("without conversation mode the toggle records with no endpoint and pastes", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [undefined]);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	h.sessions[0]!.result.resolve({ text: "pegado", truncated: false });
	await pressed;
	assert.equal(ui.editor(), "draft: pegado");
	assert.equal(pi.counts.sends, 0);
});

test("in conversation mode the toggle records hands-free and sends the transcript instead of pasting it", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [HANDS_FREE]);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	assert.equal(ui.statuses.at(-1), "● Conversation · listening · alt+m send · esc pause");
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "hola agente", truncated: false });
	await pressed;
	assert.deepEqual(pi.sent, [{ content: "hola agente", options: undefined }]);
	assert.equal(ui.editor(), "draft: ", "nothing is pasted");
	assert.equal(ui.statuses.at(-1), undefined);
});

test("in conversation mode the toggle key sends at once, and a busy agent gets it as a follow-up", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext({}, "tui", true, "session-alpha", () => false);
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	assert.ok(h.sessions[0]!.calls.includes("stop"));
	h.sessions[0]!.result.resolve({ text: "otra cosa", truncated: false });
	await pressed;
	assert.deepEqual(pi.sent, [{ content: "otra cosa", options: { deliverAs: "followUp" } }]);
});

test("after a reply is read in conversation mode the microphone reopens hands-free, and the next answer is sent", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "¿Querés que siga?");
	await until(() => readings.length === 1);
	assert.equal(h.sessions.length, 0, "the microphone stays closed while the reply is read");
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [HANDS_FREE]);
	await speak(h, 0, "sí, seguí");
	await until(() => pi.sent.length === 1);
	assert.deepEqual(pi.sent, [{ content: "sí, seguí", options: undefined }]);
});

test("a reply with nothing readable still reopens the microphone in conversation mode", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "```\nsolo código\n```");
	await until(() => h.sessions.length === 1);
	assert.equal(readings.length, 0);
});

test("a reading stopped with Esc, or an engine failure, does not reopen the microphone", async () => {
	for (const end of ["esc", "fail"] as const) {
		const { engine, readings } = fakeEngine();
		const h = harness({ installed: true, engine, speech: { conversation: true } });
		const pi = register(h);
		const ui = fakeContext();
		await pi.fire("session_start", ui.ctx);
		await settleReply(pi, ui.ctx, "Respuesta.");
		await until(() => readings.length === 1);
		if (end === "esc") ui.type(ESC);
		else readings[0]!.fail(new SpeechEngineError("failed"));
		await until(() => ui.statuses.at(-1) === undefined);
		await tick();
		assert.equal(h.sessions.length, 0, end);
	}
});

test("hearing no speech pauses the conversation with one notice and does not reopen", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.reject(new VoiceSessionError("no-speech"));
	await until(() => ui.notices.length === 1);
	assert.deepEqual(ui.notices, [{ message: "Conversation paused: no speech was heard. Press alt+m to talk.", type: "info" }]);
	await tick();
	assert.equal(h.sessions.length, 1);
	assert.equal(pi.counts.sends, 0);
});

test("Esc while listening in conversation mode pauses it without sending", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, speech: { conversation: true } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	ui.type(ESC);
	await pressed;
	assert.ok(h.sessions[0]!.calls.includes("cancel"));
	assert.equal(pi.counts.sends, 0);
	assert.deepEqual(ui.notices.at(-1), { message: "Conversation paused. Press alt+m to talk.", type: "info" });
});

test("the menu turns conversation mode on only with dictation installed and a voice, and off again", async () => {
	const { engine, readings } = fakeEngine();
	const missing = harness({ engine });
	const missingPi = register(missing);
	const refused = fakeContext({ select: pick(/^Conversation mode: turn on$/) });
	await run(missingPi, refused);
	assert.ok(refused.selects[0]!.options.includes("Conversation mode: turn on"));
	assert.deepEqual(missing.speech.writes, []);
	assert.deepEqual(refused.notices.at(-1), { message: "Conversation mode needs voice dictation. Choose Download voice dictation first.", type: "warning" });

	const noVoice = harness({ installed: true });
	const noVoicePi = register(noVoice);
	const silent = fakeContext({ select: pick(/^Conversation mode: turn on$/) });
	await run(noVoicePi, silent);
	assert.deepEqual(noVoice.speech.writes, []);
	assert.deepEqual(silent.notices.at(-1), { message: "Spoken replies need the Windows voice (Windows or WSL).", type: "warning" });

	const h = harness({ installed: true, engine });
	const pi = register(h);
	const on = fakeContext({ select: pick(/^Conversation mode: turn on$/) });
	await run(pi, on);
	assert.deepEqual(h.speech.writes, [{ speakReplies: false, conversation: true }]);
	assert.deepEqual(on.notices.at(-1), { message: "Conversation mode is on. Press alt+m and speak: the transcript is sent, the reply is read aloud and the microphone reopens. Esc pauses.", type: "info" });
	await pi.fire("session_start", on.ctx);
	await settleReply(pi, on.ctx, "Una respuesta.");
	await until(() => readings.length === 1);
	const off = fakeContext({ select: pick(/^Conversation mode: turn off$/) });
	await run(pi, off);
	assert.deepEqual(h.speech.writes.at(-1), { speakReplies: false, conversation: false });
	assert.equal(readings[0]!.options.signal.aborted, true, "turning it off stops the reading");
	assert.deepEqual(off.notices.at(-1), { message: "Conversation mode is off.", type: "info" });
	await tick();
	assert.equal(h.sessions.length, 0, "and the microphone does not reopen");
});
