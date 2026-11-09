import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import gentleVoice from "../extensions/gentle-voice.ts";
import { VoiceInstallError, type VoiceInstallProgress, type VoiceInstallResult } from "../lib/voice-install.ts";
import { VoiceSessionError, type VoiceSessionState, type VoiceTranscript } from "../lib/voice-session.ts";
import { VOICE_COMMAND_NAME, type VoiceCommandDeps, type VoiceDictation } from "../lib/voice-command.ts";
import type { CuePlayer } from "../lib/voice-cues.ts";
import type { PushToTalkTimers } from "../lib/voice-push-to-talk.ts";
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
	warms: boolean[];
	installs: Array<{ kind: string; options: Record<string, unknown> }>;
	settings: { enabled: boolean; reads: number; writes: boolean[] };
	voice: { sessions: string[]; writes: string[][] };
	focus: { focused: boolean; asks: number };
	turn: { held: boolean; waiting: Array<() => void>; acquired: number; released: number };
	warmReleases: number;
	cues: string[];
	events: Array<{ event: string } & Record<string, unknown>>;
	kokoro: { state: "installed" | "missing"; installs: Array<{ signal: AbortSignal }> };
	miro: { state: "installed" | "missing"; installs: Array<{ signal: AbortSignal }> };
	clock: ReturnType<typeof manualClock>;
}

function harness(overrides: { platform?: string; arch?: string; installed?: boolean; install?: (kind: "runtime" | "model", options: { signal: AbortSignal; onProgress(progress: VoiceInstallProgress): void }) => Promise<VoiceInstallResult>; env?: NodeJS.ProcessEnv; pushToTalk?: boolean; voice?: boolean; focused?: boolean; turnHeld?: boolean; engine?: SpeechEngine; kokoro?: "installed" | "missing"; kokoroInstall?: () => Promise<void>; miro?: "installed" | "missing"; cues?: CuePlayer } = {}): Harness {
	const calls: string[] = [];
	const sessions: FakeSession[] = [];
	const endpoints: Harness["endpoints"] = [];
	const warms: Harness["warms"] = [];
	const installs: Harness["installs"] = [];
	// The toggle store is always faked: no test reads or writes the real config home.
	const settings = { enabled: overrides.pushToTalk ?? false, reads: 0, writes: [] as boolean[] };
	// Spoken replies are faked too: no test reaches PowerShell or the config home.
	const voice: Harness["voice"] = { sessions: overrides.voice ? ["session-alpha"] : [], writes: [] };
	const focus: Harness["focus"] = { focused: overrides.focused ?? true, asks: 0 };
	const turn: Harness["turn"] = { held: overrides.turnHeld ?? false, waiting: [], acquired: 0, released: 0 };
	const harnessRef = { warmReleases: 0, cues: [] as string[], events: [] as Array<{ event: string } & Record<string, unknown>> };
	const kokoro: Harness["kokoro"] = { state: overrides.kokoro ?? "missing", installs: [] };
	const miro: Harness["miro"] = { state: overrides.miro ?? "missing", installs: [] };
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
			warms.push(options.warm === true);
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
		miro: {
			readStatus: async () => ({ state: miro.state, voiceHome: VOICE_HOME }),
			install: async (options) => { miro.installs.push(options); miro.state = "installed"; },
		},
		kokoro: {
			readStatus: async () => ({ state: kokoro.state, voiceHome: VOICE_HOME }),
			install: async (options) => {
				kokoro.installs.push(options);
				await (overrides.kokoroInstall ?? (async () => {}))();
				kokoro.state = "installed";
			},
		},
		voiceSessions: {
			read: () => [...voice.sessions],
			write: (next) => { voice.writes.push([...next]); voice.sessions = [...next]; },
		},
		paneFocused: async () => { focus.asks++; return focus.focused; },
		releaseWarm: async () => { harnessRef.warmReleases++; },
		log: (event, fields) => { harnessRef.events.push({ event, ...fields }); },
		cues: overrides.cues ?? { play: (name) => { harnessRef.cues.push(name); return Promise.resolve({ name, outcome: "done" as const, ms: 12 }); }, warm: () => { harnessRef.cues.push("warm"); }, dispose: () => { harnessRef.cues.push("dispose"); } },
		// The shared reading turn, faked: free unless a test holds it.
		readingTurn: (signal) => new Promise((resolve) => {
			const take = () => { turn.acquired++; resolve(() => { turn.released++; }); };
			if (!turn.held) return take();
			const wait = () => { turn.held = false; take(); };
			turn.waiting.push(wait);
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
		}),
	};
	return Object.assign(harnessRef, { deps, calls, sessions, endpoints, warms, installs, settings, voice, focus, turn, kokoro, miro, clock });
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

test("a hold still ends by hand: it records with no endpoint and keeps its own message when nothing is heard", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	assert.deepEqual(h.endpoints, [undefined], "a release still ends the recording, not silence");
	h.clock.advance(RELEASE);
	await until(() => session.calls.includes("stop"));
	session.result.reject(new VoiceSessionError("no-speech"));
	await until(() => ui.notices.length === 1);
	assert.deepEqual(ui.notices.at(-1), { message: "No speech was recognized. Keep holding Space until recording starts, then speak.", type: "error" });
});

test("the /gentle:voice dictation keeps recording until Enter: no endpoint, and the command's own message when nothing is heard", async () => {
	const h = harness({ installed: true, platform: "linux", arch: "x64" });
	h.deps.probe = () => ({ platform: "linux", arch: "x64", glibcVersion: "2.39" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [undefined], "only the shortcut ends on silence");
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.reject(new VoiceSessionError("no-speech"));
	await done;
	assert.deepEqual(ui.notices.at(-1), { message: "No speech was recognized. Speak after recording starts, then press Enter.", type: "error" });
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
	const h = harness({ voice: true, engine });
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
		{ name: "off", voice: false, env: {}, mode: "tui", aborted: false },
		{ name: "aborted", voice: true, env: {}, mode: "tui", aborted: true },
		{ name: "child", voice: true, env: { GENTLE_PI_AGENTS_CHILD: "1" }, mode: "tui", aborted: false },
		{ name: "rpc", voice: true, env: {}, mode: "rpc", aborted: false },
	]) {
		const { engine, readings } = fakeEngine();
		const h = harness({ voice: scenario.voice, engine, env: scenario.env });
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
	const h = harness({ voice: true, engine });
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
	const h = harness({ voice: true, engine });
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

test("the dictation shortcut while reading stops the reading, then starts a hands-free turn that is sent", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	await settleReply(pi, ui.ctx, "Te estoy leyendo esto.");
	await until(() => readings.length === 1);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	assert.equal(readings[0]!.options.signal.aborted, true, "the reading stops at once");
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [HANDS_FREE]);
	await speak(h, 0, "hola");
	await pressed;
	assert.deepEqual(pi.sent, [{ content: "hola", options: undefined }]);
	assert.equal(ui.editor(), "", "nothing is pasted");
});

test("a background run lets the reading finish; a typed message stops it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera respuesta.");
	await until(() => readings.length === 1);
	await pi.fire("agent_start", ui.ctx);
	assert.equal(readings[0]!.options.signal.aborted, false, "a background notice does not cut the reading");
	await pi.fire("input", ui.ctx, { type: "input", text: "esto lo escribí", source: "interactive" });
	assert.equal(readings[0]!.options.signal.aborted, true, "the user's own message does");
});

test("a second settled reply waits for the reading in progress, and only the newest waits", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera respuesta.");
	await until(() => readings.length === 1);
	await settleReply(pi, ui.ctx, "Segunda respuesta.");
	await settleReply(pi, ui.ctx, "Tercera respuesta.");
	await tick();
	assert.equal(readings.length, 1, "nothing interrupts the first reading");
	assert.equal(readings[0]!.options.signal.aborted, false);
	readings[0]!.finish("done");
	await until(() => readings.length === 2);
	assert.equal(readings[1]!.text, "Tercera respuesta.", "the newest reply is read next");
	readings[1]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(readings.length, 2);
	assert.equal(ui.terminal.subscribes - ui.terminal.unsubscribes, 0);
});

test("Esc on a reading also drops the reply waiting behind it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera respuesta.");
	await until(() => readings.length === 1);
	await settleReply(pi, ui.ctx, "Segunda respuesta.");
	ui.type(ESC);
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(readings.length, 1);
});

test("an engine failure is reported once with its fixed message", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
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

test("the menu turns voice on and off for this session only and persists the choice", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ engine, installed: true });
	h.voice.sessions = ["session-other"];
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) });
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Voice in this session (off): turn on"));
	assert.ok(!ui.selects[0]!.options.some((option) => /Read replies aloud|Conversation mode/.test(option)), "the old global switches are gone");
	assert.deepEqual(h.voice.writes, [["session-other", "session-alpha"]]);
	assert.deepEqual(ui.notices.at(-1), { message: "Voice is on in this session: replies are read aloud, and alt+m starts a hands-free conversation. Esc skips a reading.", type: "info" });
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Una respuesta.");
	await until(() => readings.length === 1);
	const again = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	await run(pi, again);
	assert.deepEqual(h.voice.writes.at(-1), ["session-other"], "other sessions keep their voice");
	assert.equal(readings[0]!.options.signal.aborted, true, "turning it off stops the reading");
	assert.deepEqual(again.notices.at(-1), { message: "Voice is off in this session.", type: "info" });
});

test("turning voice on without the Windows voice, or without a session id, is refused and nothing is saved", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) });
	await run(pi, ui);
	assert.deepEqual(h.voice.writes, []);
	assert.deepEqual(ui.notices.at(-1), { message: "Spoken replies need the Windows voice (Windows or WSL).", type: "warning" });
	const { engine } = fakeEngine();
	const anonymous = harness({ installed: true, engine });
	const anonymousPi = register(anonymous);
	const noId = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) }, "tui", true, "");
	await run(anonymousPi, noId);
	assert.deepEqual(anonymous.voice.writes, []);
	assert.deepEqual(noId.notices.at(-1), { message: "Voice needs a saved session; this one has no id.", type: "warning" });
});

test("a session whose voice is off reads nothing, even when other sessions have voice on", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ engine });
	h.voice.sessions = ["session-other"];
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Esto no se lee acá.");
	await tick();
	assert.equal(readings.length, 0);
});

test("a reading waits for the shared turn, then reads; Esc while waiting skips it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ engine, voice: true, turnHeld: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera.");
	await until(() => h.turn.waiting.length === 1);
	assert.equal(readings.length, 0, "nothing is read while another session reads");
	assert.equal(ui.statuses.at(-1), "Waiting to read · esc skip");
	h.turn.waiting.shift()!();
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.turn.released === 1);
	h.turn.held = true;
	await settleReply(pi, ui.ctx, "Segunda.");
	await until(() => h.turn.waiting.length === 1);
	ui.type(ESC);
	await until(() => ui.statuses.at(-1) === undefined);
	assert.equal(readings.length, 1, "the skipped reply is never read");
	assert.equal(h.turn.acquired, 1);
});

test("Stop reading is offered only while a reply is being read, and stops it", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
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
	const h = harness({ voice: true, engine });
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

const HANDS_FREE = { endOfSpeechMs: 2500, noSpeechMs: 8000 };

// One spoken turn in a voice session: alt+m, speech, end of speech, sent.
async function talk(pi: ReturnType<typeof fakePi>, h: Harness, ctx: unknown, text: string) {
	const index = h.sessions.length;
	const pressed = pi.shortcuts.get("alt+m")!.handler(ctx);
	await until(() => h.sessions.length === index + 1);
	await speak(h, index, text);
	await pressed;
}

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

test("without conversation mode the toggle also ends on silence: it records with the dictation endpoint and pastes", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.endpoints, [{ endOfSpeechMs: 2500, noSpeechMs: 8000 }]);
	assert.deepEqual(h.warms, [false], "dictation that pastes keeps its single-use worker");
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	h.sessions[0]!.result.resolve({ text: "pegado", truncated: false });
	await pressed;
	assert.equal(ui.editor(), "draft: pegado");
	assert.equal(pi.counts.sends, 0);
});

test("a dictation that hears nothing stops by itself, pastes nothing and says so", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	// With the endpoint the worker gives up after 8 s without speech and answers
	// no speech; the run ends without a second press.
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.reject(new VoiceSessionError("no-speech"));
	await pressed;
	assert.equal(ui.editor(), "draft: ", "nothing is pasted");
	assert.deepEqual(ui.notices.at(-1), { message: "No speech was heard; nothing was pasted.", type: "info" });
});

test("a pause after speech ends a dictation by itself, with no second press", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	// The endpointer stopped the recording on its own: transcribing, then finished.
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "dictado solo", truncated: false });
	await pressed;
	assert.equal(ui.editor(), "draft: dictado solo");
	assert.deepEqual(h.cues.filter((name) => name !== "warm"), ["open", "close"], "the microphone cues still mark the capture");
	assert.deepEqual(h.events.filter((entry) => entry.event === "cue").map((entry) => entry.mode), ["dictation", "dictation"], "a pasting dictation logs its own mode");
	assert.equal(h.events.some((entry) => entry.event === "cue" && "sinceReadingMs" in entry), false, "nothing was read in this session");
});

test("in conversation mode the toggle records hands-free and sends the transcript instead of pasting it", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
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
	assert.equal(ui.editor(), "", "nothing is pasted");
	assert.equal(ui.statuses.at(-1), undefined);
});

test("in conversation mode the toggle key sends at once, and a busy agent gets it as a follow-up", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext({}, "tui", true, "session-alpha", () => false);
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
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

test("after a reply to a spoken turn is read, the microphone reopens hands-free in the focused pane, and the next answer is sent", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "¿seguís?");
	await settleReply(pi, ui.ctx, "¿Querés que siga?");
	await until(() => readings.length === 1);
	assert.equal(h.sessions.length, 1, "the microphone stays closed while the reply is read");
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 2);
	assert.deepEqual(h.endpoints, [HANDS_FREE, HANDS_FREE]);
	await speak(h, 1, "sí, seguí");
	await until(() => pi.sent.length === 2);
	assert.deepEqual(pi.sent.at(-1), { content: "sí, seguí", options: undefined });
});

test("a reply to a typed message is read but does not reopen the microphone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta a algo escrito.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(h.sessions.length, 0);
	assert.equal(h.focus.asks, 0, "herdr is not even asked");
});

test("in a pane that is not focused the reply is read but the microphone stays closed", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	h.focus.focused = false;
	await settleReply(pi, ui.ctx, "Te respondo aunque estés en otro panel.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.focus.asks === 1);
	await tick();
	assert.equal(h.sessions.length, 1, "no second recording");
	assert.deepEqual(ui.notices.at(-1), { message: "Conversation paused in this pane. Press alt+m to talk.", type: "info" });
});

test("a reply with nothing readable still reopens the microphone after a spoken turn", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "mostrame el código");
	await settleReply(pi, ui.ctx, "```\nsolo código\n```");
	await until(() => h.sessions.length === 2);
	assert.equal(readings.length, 0);
});

test("Esc skips the reading of a spoken turn and reopens the microphone, so the user can correct what they heard", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await settleReply(pi, ui.ctx, "Una respuesta larga que no hace falta escuchar entera.");
	await until(() => readings.length === 1);
	ui.type(ESC);
	assert.equal(readings[0]!.options.signal.aborted, true, "the reading stops at once");
	await until(() => h.sessions.length === 2);
	assert.equal(ui.editor(), "", "Esc never reaches the editor");
});

test("Esc on the reading of a typed turn stops it and leaves the microphone closed", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	ui.type(ESC);
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(h.sessions.length, 0);
});

test("a reading that fails does not reopen the microphone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.fail(new SpeechEngineError("failed"));
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(h.sessions.length, 1);
});

test("hearing no speech pauses the conversation with one notice and does not reopen", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 2);
	h.sessions[1]!.started.resolve();
	await until(() => h.sessions[1]!.state === "recording");
	h.sessions[1]!.emit("transcribing");
	h.sessions[1]!.emit("finished");
	h.sessions[1]!.result.reject(new VoiceSessionError("no-speech"));
	await until(() => ui.notices.length === 1);
	assert.deepEqual(ui.notices, [{ message: "Conversation paused: no speech was heard. Press alt+m to talk.", type: "info" }]);
	await tick();
	assert.equal(h.sessions.length, 2);
	assert.equal(pi.sent.length, 1);
});

test("Esc while listening in conversation mode pauses it without sending", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
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

// --- the natural voice download (S6) ----------------------------------------------------

const NATURAL = /^Download natural voice \(Kokoro, about \d+ MB\)$/;

test("the natural voice is offered once the voice runtime is installed and Kokoro is not", async () => {
	for (const scenario of [
		{ name: "runtime and no Kokoro", installed: true, kokoro: "missing" as const, offered: true },
		{ name: "Kokoro installed", installed: true, kokoro: "installed" as const, offered: false },
		{ name: "no runtime yet", installed: false, kokoro: "missing" as const, offered: false },
	]) {
		const h = harness({ installed: scenario.installed, kokoro: scenario.kokoro });
		const pi = register(h);
		const ui = fakeContext();
		await run(pi, ui);
		assert.equal(ui.selects[0]!.options.some((option) => NATURAL.test(option)), scenario.offered, scenario.name);
	}
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Download natural voice (Kokoro, about 355 MB)"));
});

test("downloading the natural voice asks first, names sizes and licenses, and declining fetches nothing", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(NATURAL), confirm: () => false });
	await run(pi, ui);
	assert.equal(ui.confirms.length, 1);
	assert.equal(ui.confirms[0]!.title, "Download the natural voice?");
	for (const expected of [/model\.onnx/, /espeak-ng-data/, /Apache-2\.0/, /GPL-3\.0-or-later/, /355 MB/, /Spanish and English/]) {
		assert.match(ui.confirms[0]!.message, expected);
	}
	assert.deepEqual(h.kokoro.installs, []);
	assert.deepEqual(ui.notices.at(-1), { message: "Natural voice download skipped; nothing was downloaded.", type: "info" });
});

test("an accepted natural voice download installs it with a cancel signal and reports success", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(NATURAL), confirm: () => true });
	await run(pi, ui);
	assert.equal(h.kokoro.installs.length, 1);
	assert.ok(h.kokoro.installs[0]!.signal instanceof AbortSignal);
	assert.equal(h.kokoro.state, "installed");
	assert.deepEqual(ui.notices.at(-1), { message: "The natural voice is installed. Spoken replies now use Kokoro.", type: "info" });
	assert.equal(ui.open(), false, "the progress overlay is closed");
});

test("a failed natural voice download reports the installer's fixed message", async () => {
	const h = harness({ installed: true, kokoroInstall: async () => { throw new VoiceInstallError("integrity", "detail that must not leak"); } });
	const pi = register(h);
	const ui = fakeContext({ select: pick(NATURAL), confirm: () => true });
	await run(pi, ui);
	assert.deepEqual(ui.notices.at(-1), { message: "A downloaded file did not match its pinned size or digest and was discarded.", type: "error" });
	assert.ok(!ui.notices.some((notice) => /detail that must not leak/.test(notice.message)));
});

test("stopping a hands-free recording with the shortcut before speaking pauses without claiming nothing was heard", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	h.sessions[0]!.result.reject(new VoiceSessionError("no-speech"));
	await pressed;
	assert.deepEqual(ui.notices.at(-1), { message: "Conversation paused. Press alt+m to talk.", type: "info" });
	assert.equal(pi.counts.sends, 0);
});

test("the default reading turn takes and releases the shared turn file in the voice home", async () => {
	const { mkdtempSync, existsSync, rmSync, mkdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const scratchRoot = join(import.meta.dirname, "..", "tmp");
	mkdirSync(scratchRoot, { recursive: true });
	const home = mkdtempSync(join(scratchRoot, "voice-command-turn-"));
	try {
		const { engine, readings } = fakeEngine();
		const h = harness({ voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
		delete h.deps.readingTurn;
		const pi = register(h);
		const ui = fakeContext();
		await pi.fire("session_start", ui.ctx);
		await settleReply(pi, ui.ctx, "Con el turno real.");
		await until(() => readings.length === 1);
		assert.equal(existsSync(join(home, "voice", "reading-turn.json")), true, "the turn is held while reading");
		readings[0]!.finish("done");
		await until(() => !existsSync(join(home, "voice", "reading-turn.json")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the kept-alive dictation worker is released when voice is turned off and when the session ends", async () => {
	const { engine } = fakeEngine();
	const h = harness({ engine, installed: true, voice: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	await pi.fire("session_start", ui.ctx);
	const atStart = h.warmReleases;
	await run(pi, ui);
	assert.equal(h.warmReleases, atStart + 1, "turning voice off releases it");
	await pi.fire("session_shutdown", ui.ctx);
	assert.equal(h.warmReleases, atStart + 2, "ending the session releases it");
});

test("a reply waiting for its turn is not read once voice was turned off in the meantime", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ engine, voice: true, turnHeld: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Esto no se tiene que leer.");
	await until(() => h.turn.waiting.length === 1);
	// Another Pi process turns voice off for this session while the reply waits.
	h.voice.sessions = [];
	h.turn.waiting.shift()!();
	await until(() => h.turn.released === 1);
	assert.equal(readings.length, 0, "nothing is read after consent was withdrawn");
	assert.equal(ui.statuses.at(-1), undefined);
});

// --- the Miro voice download (Piper) --------------------------------------------------

const MIRO = /^Download Miro voice \(Piper, about \d+ MB\)$/;

test("the Miro voice is offered once the voice runtime is installed and Miro is not", async () => {
	for (const scenario of [
		{ name: "runtime and no Miro", installed: true, miro: "missing" as const, offered: true },
		{ name: "Miro installed", installed: true, miro: "installed" as const, offered: false },
		{ name: "no runtime yet", installed: false, miro: "missing" as const, offered: false },
	]) {
		const h = harness({ installed: scenario.installed, miro: scenario.miro });
		const pi = register(h);
		const ui = fakeContext();
		await run(pi, ui);
		assert.equal(ui.selects[0]!.options.some((option) => MIRO.test(option)), scenario.offered, scenario.name);
	}
});

test("downloading Miro asks first with its non-commercial license, and an accepted download installs it", async () => {
	const declined = harness({ installed: true });
	const declinedPi = register(declined);
	const no = fakeContext({ select: pick(MIRO), confirm: () => false });
	await run(declinedPi, no);
	assert.equal(no.confirms[0]!.title, "Download the Miro voice?");
	for (const expected of [/es_ES-miro-high\.onnx/, /CC BY-NC-SA 4\.0/, /non-commercial/, /\d+ MB/]) assert.match(no.confirms[0]!.message, expected);
	assert.deepEqual(declined.miro.installs, []);
	assert.deepEqual(no.notices.at(-1), { message: "Miro voice download skipped; nothing was downloaded.", type: "info" });
	const h = harness({ installed: true });
	const pi = register(h);
	const yes = fakeContext({ select: pick(MIRO), confirm: () => true });
	await run(pi, yes);
	assert.equal(h.miro.installs.length, 1);
	assert.ok(h.miro.installs[0]!.signal instanceof AbortSignal);
	assert.deepEqual(yes.notices.at(-1), { message: "The Miro voice is installed. Spanish replies now use it.", type: "info" });
});

test("a hands-free turn sends whatever is in the draft, such as a pasted image path, together with the transcript, then clears the draft", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("  /tmp/pi-clipboard-1234.png\nmirá esta captura  ");
	await talk(pi, h, ui.ctx, "¿qué ves acá?");
	assert.deepEqual(pi.sent, [{ content: "/tmp/pi-clipboard-1234.png\nmirá esta captura\n\n¿qué ves acá?", options: undefined }]);
	assert.equal(ui.editor(), "", "the draft is cleared once it was sent");
});

test("a hands-free turn with a blank draft sends only the transcript and leaves the draft alone", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("   ");
	await talk(pi, h, ui.ctx, "hola");
	assert.deepEqual(pi.sent, [{ content: "hola", options: undefined }]);
	assert.equal(ui.editor(), "   ");
});

test("a hands-free turn that hears nothing keeps the draft unsent", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("/tmp/pi-clipboard-1234.png");
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.reject(new VoiceSessionError("no-speech"));
	await pressed;
	assert.equal(pi.counts.sends, 0);
	assert.equal(ui.editor(), "/tmp/pi-clipboard-1234.png");
});

// --- microphone cues ----------------------------------------------------------------

test("a rising cue plays when the microphone really starts recording and a falling one when it stops", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	assert.deepEqual(h.cues, ["warm"], "a voice session wakes the player at start");
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	assert.deepEqual(h.cues, ["warm"], "nothing plays while the microphone is still opening");
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	assert.deepEqual(h.cues, ["warm", "open"]);
	h.sessions[0]!.emit("transcribing");
	assert.deepEqual(h.cues, ["warm", "open", "close"]);
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "hola", truncated: false });
	await pressed;
	assert.deepEqual(h.cues, ["warm", "open", "close"], "the close cue plays once");
});

test("Esc while recording plays the falling cue, and a capture that never recorded plays none", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	ui.type(ESC);
	await pressed;
	assert.deepEqual(h.cues, ["warm", "open", "close"]);
	const second = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 2);
	ui.type(ESC);
	await second;
	assert.deepEqual(h.cues, ["warm", "open", "close"], "cancelled before recording: no cue");
});

test("dictation that pastes plays the cues too, a session without voice does not wake the player early, and the player is released with the session", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	assert.deepEqual(h.cues, []);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	void pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	h.sessions[0]!.result.resolve({ text: "pegado", truncated: false });
	await pressed;
	assert.deepEqual(h.cues, ["open", "close"]);
	await pi.fire("session_shutdown", ui.ctx);
	assert.equal(h.cues.at(-1), "dispose");
});

test("turning voice on wakes the cue player", async () => {
	const { engine } = fakeEngine();
	const h = harness({ engine, installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) });
	await run(pi, ui);
	assert.ok(h.cues.includes("warm"));
});

test("after a spoken turn, a background reply waits its turn, and the microphone reopens once both were read", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "bajá las voces");
	await settleReply(pi, ui.ctx, "Las estoy bajando.");
	await until(() => readings.length === 1);
	// A background job finishing wakes the agent while the first reply is read.
	await settleReply(pi, ui.ctx, "Ya bajaron, te las hago sonar.");
	await tick();
	assert.equal(readings[0]!.options.signal.aborted, false);
	readings[0]!.finish("done");
	await until(() => readings.length === 2);
	assert.equal(h.sessions.length, 1, "no microphone between the two readings");
	readings[1]!.finish("done");
	await until(() => h.sessions.length === 2);
	assert.deepEqual(h.endpoints.at(-1), HANDS_FREE);
});

test("typing a message ends the spoken turn, so its reply does not reopen the microphone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await pi.fire("input", ui.ctx, { type: "input", text: "esto lo escribí", source: "interactive" });
	await settleReply(pi, ui.ctx, "Respuesta a lo escrito.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(h.sessions.length, 1);
});

// --- diagnostics ----------------------------------------------------------------------

test("a cue player that plays and answers with nothing never breaks the microphone state", async () => {
	const { engine } = fakeEngine();
	const played: string[] = [];
	const h = harness({ installed: true, engine, voice: true, cues: { play: (name) => { played.push(name); return undefined as unknown as Promise<never>; }, warm: () => {}, dispose: () => {} } });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	h.sessions[0]!.emit("transcribing");
	assert.deepEqual(played, ["open", "close"], "both cues still reach the player");
	assert.equal(h.events.some((entry) => entry.event === "cue"), false, "nothing is claimed about a cue that reported nothing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "hola", truncated: false });
	await pressed;
});

test("each microphone cue logs its name, whether it played and how long it took", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	assert.equal(h.events.some((entry) => entry.event === "cue"), false, "nothing is logged before the cue settles");
	h.sessions[0]!.started.resolve();
	await until(() => h.events.some((entry) => entry.event === "cue"));
	h.sessions[0]!.emit("transcribing");
	await until(() => h.events.filter((entry) => entry.event === "cue").length === 2);
	const cues = h.events.filter((entry) => entry.event === "cue");
	assert.deepEqual(cues.map((entry) => [entry.name, entry.outcome, entry.ms, entry.session]), [["open", "done", 12, "session-alpha"], ["close", "done", 12, "session-alpha"]]);
	assert.deepEqual(cues.map((entry) => entry.mode), ["conversation", "conversation"], "the cue event names the mode it belongs to");
	assert.equal(cues.some((entry) => "sinceReadingMs" in entry), false, "nothing was read in this session");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "hola", truncated: false });
	await pressed;
});

test("a conversation turn plays the Alt+M cues through the same player and logs them as conversation", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 2);
	await speak(h, 1, "sigo");
	await until(() => h.events.filter((entry) => entry.event === "cue").length === 4);
	// Same player, same tones, same order as a pasting dictation.
	assert.deepEqual(h.cues.filter((name) => name !== "warm"), ["open", "close", "open", "close"]);
	assert.deepEqual(h.warms, [true, true], "both captures of the conversation keep the warm session");
	const cues = h.events.filter((entry) => entry.event === "cue");
	assert.deepEqual(cues.map((entry) => [entry.name, entry.mode]), [["open", "conversation"], ["close", "conversation"], ["open", "conversation"], ["close", "conversation"]]);
	assert.equal("sinceReadingMs" in cues[0]!, false, "the first capture follows no reading");
	assert.equal(typeof cues[2]!.sinceReadingMs, "number", "the reopen cue records how long after the reading it played");
	assert.ok((cues[2]!.sinceReadingMs as number) >= 0);
});

test("each reading and every microphone reopen decision is logged with its reason", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	h.focus.focused = false;
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.events.some((entry) => entry.event === "mic.reopen"));
	const names = h.events.map((entry) => entry.event);
	for (const expected of ["turn.sent", "reply.settled", "reading.start", "reading.end"]) assert.ok(names.includes(expected), expected);
	assert.deepEqual(h.events.find((entry) => entry.event === "reading.end")!.outcome, "done");
	const reopen = h.events.find((entry) => entry.event === "mic.reopen")!;
	assert.equal(reopen.result, "skipped");
	assert.equal(reopen.reason, "not-focused");
	assert.equal(reopen.session, "session-alpha");
	assert.ok(!JSON.stringify(h.events).includes("Respuesta."), "no reply text is logged");
});
