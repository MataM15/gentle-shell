import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import gentleVoice from "../extensions/gentle-voice.ts";
import { VoiceInstallError, type VoiceInstallProgress, type VoiceInstallResult } from "../lib/voice-install.ts";
import { VoiceSessionError, type VoiceSessionState, type VoiceTranscript } from "../lib/voice-session.ts";
import { createReadingTurn, CONVERSATION_ENDPOINT, HELD_REPLY_POLL_MS, HELD_REPLY_STALE_MS, VOICE_COMMAND_NAME, type VoiceCommandDeps, type VoiceDictation } from "../lib/voice-command.ts";
import { listenerPaths, VoiceListener, type ListenerDictation, type ListenerDictationRequest, type ListenerSpotFactory } from "../lib/voice-listener.ts";
import { createSessionListenerLink, VoiceListenerClient } from "../lib/voice-listener-client.ts";
import { createVoiceReceiver } from "../lib/shell-voice-state.ts";
import { encodeListenerFrame, parseListenerFrameLine } from "../lib/voice-listener-protocol.ts";
import type { PaneFocus } from "../lib/voice-presence.ts";
import type { CuePlayer } from "../lib/voice-cues.ts";
import type { PushToTalkTimers } from "../lib/voice-push-to-talk.ts";
import type { VoiceSpeechChunk } from "../lib/voice-speech-events.ts";
import { createRetrySpeechEngine, createWindowsSpeechEngine, SpeechEngineError, type SpeechEngine, type SpeechOptions, type SpeechOutcome } from "../lib/voice-speech.ts";

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
	focus: { state: PaneFocus; asks: number };
	turn: { held: boolean; waiting: Array<() => void>; acquired: number; released: number; cut?: () => void; levels: VoiceSpeechChunk[] };
	// The readings this session cut elsewhere when its voice was turned off.
	readCuts: string[];
	warmReleases: number;
	cues: string[];
	events: Array<{ event: string } & Record<string, unknown>>;
	kokoro: { state: "installed" | "missing"; installs: Array<{ signal: AbortSignal }> };
	miro: { state: "installed" | "missing"; installs: Array<{ signal: AbortSignal }> };
	clock: ReturnType<typeof manualClock>;
}

function harness(overrides: { platform?: string; arch?: string; installed?: boolean; install?: (kind: "runtime" | "model", options: { signal: AbortSignal; onProgress(progress: VoiceInstallProgress): void }) => Promise<VoiceInstallResult>; env?: NodeJS.ProcessEnv; pushToTalk?: boolean; voice?: boolean; focus?: PaneFocus; holdPollMs?: number; holdStaleMs?: number; turnHeld?: boolean; engine?: SpeechEngine; kokoro?: "installed" | "missing"; kokoroInstall?: () => Promise<void>; miro?: "installed" | "missing"; cues?: CuePlayer } = {}): Harness {
	const calls: string[] = [];
	const sessions: FakeSession[] = [];
	const endpoints: Harness["endpoints"] = [];
	const warms: Harness["warms"] = [];
	const installs: Harness["installs"] = [];
	// The toggle store is always faked: no test reads or writes the real config home.
	const settings = { enabled: overrides.pushToTalk ?? false, reads: 0, writes: [] as boolean[] };
	// Spoken replies are faked too: no test reaches PowerShell or the config home.
	const voice: Harness["voice"] = { sessions: overrides.voice ? ["session-alpha"] : [], writes: [] };
	const focus: Harness["focus"] = { state: overrides.focus ?? "focused", asks: 0 };
	const turn: Harness["turn"] = { held: overrides.turnHeld ?? false, waiting: [], acquired: 0, released: 0, levels: [] };
	const harnessRef = { warmReleases: 0, cues: [] as string[], readCuts: [] as string[], events: [] as Array<{ event: string } & Record<string, unknown>> };
	const kokoro: Harness["kokoro"] = { state: overrides.kokoro ?? "missing", installs: [] };
	const miro: Harness["miro"] = { state: overrides.miro ?? "missing", installs: [] };
	const clock = manualClock();
	const state = overrides.installed ? "installed" : "missing";
	const install = overrides.install ?? (async (kind) => ({ kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false }));
	const deps: VoiceCommandDeps = {
		env: overrides.env ?? {},
		startListener: () => { throw new Error("listener start not configured in test"); },
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
		// Both questions go to the same fake herdr; the reading gate also uses the
		// third answer, "unknown" (S12).
		paneFocused: async () => { focus.asks++; return focus.state === "focused"; },
		paneFocus: async () => { focus.asks++; return focus.state; },
		// A held reply is polled quickly here; the window stays the real one unless a
		// test needs it to run out.
		holdPollMs: overrides.holdPollMs ?? 5,
		holdStaleMs: overrides.holdStaleMs ?? HELD_REPLY_STALE_MS,
		releaseWarm: async () => { harnessRef.warmReleases++; },
		log: (event, fields) => { harnessRef.events.push({ event, ...fields }); },
		cues: overrides.cues ?? { play: (name) => { harnessRef.cues.push(name); return Promise.resolve({ name, outcome: "done" as const, ms: 12 }); }, warm: () => { harnessRef.cues.push("warm"); }, dispose: () => { harnessRef.cues.push("dispose"); } },
		// The shared reading turn, faked: free unless a test holds it. The listener
		// hands its cut back through the hooks, so a test can cut like it does.
		readingTurn: (signal, hooks) => new Promise((resolve) => {
			const take = () => {
				turn.acquired++;
				turn.cut = () => hooks?.onCut?.("cut");
				// The granted turn also carries the loudness sink the listener draws.
				resolve(Object.assign(() => { turn.released++; }, { levels: (chunk: VoiceSpeechChunk) => turn.levels.push(chunk) }));
			};
			if (!turn.held) return take();
			const wait = () => { turn.held = false; take(); };
			turn.waiting.push(wait);
			signal.addEventListener("abort", () => resolve(undefined), { once: true });
		}),
		readCut: (sessionId) => { harnessRef.readCuts.push(sessionId); },
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

test("a toggle dictation records through the listener and this session only pastes the transcript", async () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-command-listener-"));
	const calls: string[] = [];
	const dictation = (request: ListenerDictationRequest): ListenerDictation => ({
		start: async () => { calls.push("start"); request.onStateChange("recording"); },
		stop: async () => { calls.push("stop"); request.onStateChange("transcribing"); request.onStateChange("finished"); return { text: "hola desde el listener", truncated: false }; },
		cancel: async () => { calls.push("cancel"); request.onStateChange("finished"); },
	});
	const server = new VoiceListener({ dir, dictation, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	await server.listen();
	try {
		const h = harness({ installed: true, env: { HERDR_PANE_ID: "w1:p1" } });
		// No session worker: the microphone lives in the listener from slice C on.
		delete (h.deps as { createSession?: unknown }).createSession;
		h.deps.listener = createSessionListenerLink({ dir, session: () => ({ sessionId: "session-alpha", paneId: "w1:p1", voiceOn: true }) });
		const pi = register(h);
		const ui = fakeContext();
		const done = press(pi, ui);
		await until(() => /recording/i.test(ui.statuses.at(-1) ?? ""), 400);
		await press(pi, ui);
		await done;
		assert.equal(ui.editor(), "draft: hola desde el listener", "the transcript reaches the focused session's draft");
		assert.deepEqual(calls, ["start", "stop"]);
		assert.equal(h.sessions.length, 0, "the session starts no worker of its own");
		assert.ok(!h.calls.some((call) => call.startsWith("session:")), "no local capture is created");
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), [], "the listener plays the cues, not the session");
		assert.equal(pi.counts.sends, 0, "the transcript is pasted, never submitted");
		h.deps.listener.close();
	} finally {
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("moving focus during transcription pastes only into the session that dictated", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-owner-"));
	const dir = join(home, "voice");
	const gate = deferred<void>();
	let focused = "w1:p1";
	const server = new VoiceListener({
		dir, focus: { focusedPaneId: async () => ({ focused }) },
		dictation: (request) => ({
			start: async () => request.onStateChange("recording"),
			stop: async () => { request.onStateChange("transcribing"); await gate.promise; request.onStateChange("finished"); return { text: "mi dictado", truncated: false }; },
			cancel: async () => request.onStateChange("finished"),
		}),
	});
	const first = harness({ installed: true, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	const second = harness({ installed: true, env: { HERDR_PANE_ID: "w1:p2", GENTLE_PI_CONFIG_HOME: home } });
	delete first.deps.createSession; delete second.deps.createSession;
	const piFirst = register(first); const piSecond = register(second);
	const uiFirst = fakeContext({}, "tui", true, "session-alpha");
	const uiSecond = fakeContext({}, "tui", true, "session-beta");
	await server.listen();
	try {
		await piFirst.fire("session_start", uiFirst.ctx);
		await piSecond.fire("session_start", uiSecond.ctx);
		await until(() => server.sessionIds.length === 2);
		const done = press(piFirst, uiFirst);
		await until(() => /recording/i.test(uiFirst.statuses.at(-1) ?? ""));
		await press(piFirst, uiFirst);
		await until(() => /transcrib/i.test(uiFirst.statuses.at(-1) ?? ""));
		focused = "w1:p2";
		gate.resolve();
		await done;
		assert.equal(uiFirst.editor(), "draft: mi dictado");
		assert.equal(uiSecond.editor(), "draft: ");
		assert.deepEqual(piFirst.sent, []);
		assert.deepEqual(piSecond.sent, []);
	} finally {
		gate.resolve();
		await piFirst.fire("session_shutdown", uiFirst.ctx);
		await piSecond.fire("session_shutdown", uiSecond.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a voice-off shortcut inserts its own finished transcript when focus fails", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-requester-"));
	const dir = join(home, "voice");
	const events: Array<{ event: string } & Record<string, unknown>> = [];
	const server = new VoiceListener({
		dir, focus: { focusedPaneId: async () => ({ failed: true }) },
		dictation: (request) => ({
			start: async () => request.onStateChange("recording"),
			stop: async () => { request.onStateChange("transcribing"); request.onStateChange("finished"); return { text: "dictado guardado", truncated: false }; },
			cancel: async () => request.onStateChange("finished"),
		}),
		log: (event, fields) => events.push({ event, ...fields }),
	});
	const h = harness({ installed: true, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	const pi = register(h);
	const ui = fakeContext();
	await server.listen();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => server.sessionIds.includes("session-alpha"));
		const done = press(pi, ui);
		await until(() => /recording/i.test(ui.statuses.at(-1) ?? ""));
		await press(pi, ui);
		await done;
		assert.equal(ui.editor(), "draft: dictado guardado");
		assert.deepEqual(pi.sent, []);
		assert.deepEqual(h.voice.sessions, []);
		assert.deepEqual(events.filter((entry) => entry.event === "transcript.delivered").map(({ sessionId, fallback }) => ({ sessionId, fallback })), [{ sessionId: "session-alpha", fallback: undefined }]);
		assert.equal(events.find((entry) => entry.event === "capture.end")?.phase, "delivered");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

for (const registration of ["passive-off", "turned-off", "voice-on"] as const) test(`a focused ${registration} session inserts a transcript received from another capture`, async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-received-"));
	const dir = join(home, "voice");
	const serverEvents: Array<{ event: string } & Record<string, unknown>> = [];
	const result = deferred<void>();
	const server = new VoiceListener({
		dir,
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
		dictation: (request) => ({
			start: async () => request.onStateChange("recording"),
			stop: async () => { request.onStateChange("transcribing"); await result.promise; request.onStateChange("finished"); return { text: "texto de otra sesión", truncated: true }; },
			cancel: async () => request.onStateChange("finished"),
		}),
		log: (event, fields) => serverEvents.push({ event, ...fields }),
	});
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: registration !== "passive-off", engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	const actor = new VoiceListenerClient({ dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true } });
	const actorFrames: Array<{ type: string; phase?: string }> = [];
	actor.onFrame((frame) => { if (frame.type === "capture" || frame.type === "transcript") actorFrames.push(frame); });
	await server.listen();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => server.sessionIds.includes("session-alpha"));
		if (registration === "turned-off") {
			await run(pi, ui);
			await until(() => !server.voiceSessions.includes("session-alpha"));
		}
		await actor.connect();
		assert.equal((await actor.request({ type: "dictate", mode: "dictation" })).type, "ok");
		const stopping = actor.request({ type: "stop" });
		stopping.catch(() => {});
		await until(() => actorFrames.some((frame) => frame.type === "capture" && frame.phase === "transcribing"));
		actor.close();
		await assert.rejects(stopping);
		await until(() => server.clientCount === 1);
		result.resolve();
		await until(() => h.events.some((entry) => entry.event === "transcript.received"));
		assert.equal(ui.editor(), "draft: texto de otra sesión");
		assert.deepEqual(h.events.filter((entry) => entry.event === "transcript.received"), [{ event: "transcript.received", session: "session-alpha", pasted: true, chars: "texto de otra sesión".length, truncated: true }]);
		assert.deepEqual(actorFrames, [{ type: "capture", phase: "recording" }, { type: "capture", phase: "transcribing" }]);
		assert.deepEqual(serverEvents.filter((entry) => entry.event === "transcript.delivered").map(({ sessionId, fallback }) => ({ sessionId, fallback })), [{ sessionId: "session-alpha", fallback: "focus" }]);
		assert.equal(serverEvents.find((entry) => entry.event === "capture.end")?.phase, "elsewhere");
		assert.deepEqual(pi.sent, []);
		assert.equal(h.voice.sessions.includes("session-alpha"), registration === "voice-on");
	} finally {
		result.resolve();
		actor.close();
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

// A protocol peer for session registration, independent of the concurrently
// edited listener. It speaks only hello, session-voice and command frames.
function registrationPeer(dir: string, holdFirstWelcome = false) {
	const frames: Array<Record<string, unknown>> = [];
	const connections = new Map<Socket, { sessionId: string; voiceOn: boolean }>();
	const sockets = new Set<Socket>();
	const heldWelcomes: Array<() => void> = [];
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => { sockets.delete(socket); connections.delete(socket); });
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk) => {
			buffered += chunk;
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				buffered = buffered.slice(newline + 1);
				frames.push(frame);
				if (frame.type === "hello") {
					connections.set(socket, { sessionId: String(frame.sessionId), voiceOn: frame.voiceOn === true });
					const welcome = () => {
						if (!socket.destroyed) socket.write(encodeListenerFrame({ type: "welcome", id: String(frame.id), listenerPid: process.pid, proto: 1, state: "asleep" }));
					};
					if (holdFirstWelcome && frames.filter((entry) => entry.type === "hello").length === 1) heldWelcomes.push(welcome);
					else welcome();
				} else if (frame.type === "session-voice") {
					const session = connections.get(socket);
					if (session) session.voiceOn = frame.voiceOn === true;
				}
			}
		});
	});
	return {
		frames,
		releaseWelcomes: () => { for (const welcome of heldWelcomes.splice(0)) welcome(); },
		voiceSessions: () => [...connections.values()].filter((session) => session.voiceOn).map((session) => session.sessionId),
		broadcastOff: () => {
			for (const [socket, session] of connections) {
				session.voiceOn = false;
				socket.write(encodeListenerFrame({ type: "command", command: "voice-off" }));
			}
		},
		listen: async () => {
			mkdirSync(dir, { recursive: true });
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listenerPaths(dir).socket, resolve); });
		},
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

for (const voiceOn of [false, true]) nodeTest(`a connected ${voiceOn ? "voice-on" : "voice-off"} session restarts a vanished listener`, { timeout: 12_000 }, async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-restart-"));
	const dir = join(home, "voice");
	const { engine } = fakeEngine();
	const h = harness({ voice: voiceOn, engine, env: { GENTLE_PI_CONFIG_HOME: home, HERDR_PANE_ID: "w1:p1" } });
	delete h.deps.createSession;
	let server = new VoiceListener({ dir });
	let starts = 0;
	h.deps.startListener = async () => { starts++; server = new VoiceListener({ dir }); await server.listen(); };
	await server.listen();
	const pi = register(h);
	const ui = fakeContext();
	const clients: VoiceListenerClient[] = [];
	const connect = VoiceListenerClient.prototype.connect;
	const emit = Server.prototype.emit;
	let releaseWelcome: (() => void) | undefined;
	const waitFor = async (check: () => boolean, message: string) => {
		const deadline = performance.now() + 8_000;
		while (!check() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(check(), message);
	};
	VoiceListenerClient.prototype.connect = function () { clients.push(this); return connect.call(this); };
	// Hold the welcome to exercise the gap between server registration and the
	// client actually joining, rather than assuming those happen at the same time.
	Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
		if (event === "connection") {
			const socket = args[0] as Socket;
			const write = socket.write.bind(socket);
			socket.write = ((chunk: string) => {
				if (!releaseWelcome && parseListenerFrameLine(chunk)?.type === "welcome") {
					releaseWelcome = () => { if (!socket.destroyed) write(chunk); };
					return true;
				}
				return write(chunk);
			}) as typeof socket.write;
		}
		return emit.call(this, event, ...args);
	} as typeof Server.prototype.emit;
	try {
		await pi.fire("session_start", ui.ctx);
		await waitFor(() => server.sessionIds.includes("session-alpha"), "the listener never registered the session");
		assert.ok(releaseWelcome, "the server registered a hello before sending welcome");
		assert.equal(clients[0]?.connected, false, "registration alone does not mean the session joined");
		Server.prototype.emit = emit;
		releaseWelcome();
		await waitFor(() => clients[0]?.connected === true, "the client never completed its initial join");
		assert.equal(starts, 0, "startup joins the existing listener");
		await server.close();
		await waitFor(() => starts > 0 && clients[0]?.connected === true && server.sessionIds.includes("session-alpha"), "the connected session did not restart and rejoin");
		assert.deepEqual(server.voiceSessions, voiceOn ? ["session-alpha"] : []);
		assert.equal(server.clientCount, 1);
		assert.equal(starts, 1);
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		VoiceListenerClient.prototype.connect = connect;
		Server.prototype.emit = emit;
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a voice-off startup keeps one display connection to a healthy listener", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-passive-stable-"));
	const events: Array<{ event: string } & Record<string, unknown>> = [];
	const server = new VoiceListener({
		dir: join(home, "voice"),
		dictation: () => { throw new Error("unexpected capture"); },
		log: (event, fields) => events.push({ event, ...fields }),
	});
	await server.listen();
	const h = harness({ installed: true, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => pi.emitted.some((event) => event.channel === "gentle-ai:voice-display"));
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.equal(events.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length, 1);
		assert.equal(events.filter((entry) => entry.event === "listener.client-closed" && entry.sessionId === "session-alpha").length, 0);
		assert.equal(server.clientCount, 1);
		assert.deepEqual(h.voice.writes, []);
		assert.deepEqual(h.cues, []);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

for (const voiceOn of [false, true]) test(`RC-R1: a ${voiceOn ? "voice-on" : "passive"} reload rejoins after a hello storm and hears focused wake`, async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-rate-reload-"));
	const dir = join(home, "voice");
	let clock = 10_000;
	let heard: ((command: string | undefined) => void) | undefined;
	const requests: ListenerDictationRequest[] = [];
	const events: Array<{ event: string } & Record<string, unknown>> = [];
	const server = new VoiceListener({
		dir, now: () => clock,
		keyword: { model: { root: "/fake", files: {} }, keywords: [{ tokens: "on", command: "voice-on" }], boost: 2, threshold: 0.25, maxActivePaths: 16, trailingBlanks: 2 },
		spot: () => {
			let settle!: (command: string | undefined) => void;
			const waiting = new Promise<string | undefined>((resolve) => { settle = resolve; });
			heard = settle;
			return { start: async () => {}, heard: () => waiting, stop: async () => settle(undefined), cancel: async () => settle(undefined) };
		},
		dictation: (request) => {
			requests.push(request);
			return { start: async () => request.onStateChange("recording"), stop: async () => ({ text: "hola", truncated: false }), cancel: async () => request.onStateChange("finished") };
		},
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
		log: (event, fields) => events.push({ event, ...fields }),
	});
	await server.listen();
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: voiceOn, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	let pi = register(h);
	let ui = fakeContext();
	const connect = VoiceListenerClient.prototype.connect;
	const clients = new Set<VoiceListenerClient>();
	let refusals = 0;
	try {
		for (let i = 0; i < 5; i++) {
			const previous = new VoiceListenerClient({ dir, session: { sessionId: "session-alpha", paneId: "w1:p1", voiceOn: false } });
			await previous.connect();
			previous.close();
		}
		await pi.fire("session_start", ui.ctx);
		await until(() => events.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length === 6, 1_000);
		await pi.fire("session_shutdown", ui.ctx);
		await until(() => server.clientCount === 0, 1_000);
		pi = register(h);
		ui = fakeContext();
		VoiceListenerClient.prototype.connect = function () {
			if (!clients.has(this)) this.onFrame((frame) => { if (frame.type === "error" && frame.code === "rate-limit") refusals++; });
			clients.add(this);
			return connect.call(this);
		};
		await pi.fire("session_start", ui.ctx);
		await until(() => refusals >= 1, 1_000);
		assert.deepEqual(server.sessionIds, [], "the reload was refused while blocked");
		assert.equal(events.filter((entry) => entry.event === "listener.reconnect-throttled").length, 1);
		clock += 2_000;
		await until(() => server.sessionIds.includes("session-alpha") && [...clients].some((client) => client.connected), 3_500);
		assert.equal(server.clientCount, 1, "the live reload automatically re-registers once");
		assert.equal(refusals, 1, "the retry after the block does not cause a refusal storm");
		assert.equal(events.filter((entry) => entry.event === "listener.reconnect-throttled").length, 2, "the accepted seventh hello starts only the next episode");
		assert.equal(requests.length, 0);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
		assert.ok(heard);
		heard!("voice-on");
		await until(() => requests.length === 1, 1_000);
		assert.equal(requests[0]!.mode, "conversation");
		assert.deepEqual(h.voice.sessions, ["session-alpha"]);
		assert.equal(pi.counts.sends, 0);
	} finally {
		VoiceListenerClient.prototype.connect = connect;
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a passive session backs off when a listener repeatedly rejects its display subscription", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-passive-reject-"));
	const dir = join(home, "voice");
	mkdirSync(dir, { recursive: true });
	const sockets = new Set<Socket>();
	const hellos: Array<Record<string, unknown>> = [];
	let rejects = 0;
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk: string) => {
			buffered += chunk;
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const frame = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				buffered = buffered.slice(newline + 1);
				if (frame.type === "hello") {
					hellos.push(frame);
					socket.write(encodeListenerFrame({ type: "welcome", id: String(frame.id), listenerPid: process.pid, proto: 1, state: "asleep" }));
				} else if (frame.type === "display") {
					rejects++;
					socket.end(encodeListenerFrame({ type: "error", code: "bad-frame" }));
				}
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(listenerPaths(dir).socket, resolve));
	const h = harness({ installed: true, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => rejects >= 2, 1_000);
		await new Promise((resolve) => setTimeout(resolve, 850));
		assert.equal(hellos.length, 2, `expected two hellos over roughly 1.1 seconds, got ${hellos.length}`);
		assert.equal(rejects, 2);
		assert.ok(hellos.every((hello) => hello.sessionId === "session-alpha" && hello.voiceOn === false));
		assert.deepEqual(h.voice.writes, []);
		assert.deepEqual(h.cues, []);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});

for (const { initiallyOn, beforeWelcome } of [
	{ initiallyOn: false, beforeWelcome: false },
	{ initiallyOn: false, beforeWelcome: true },
	{ initiallyOn: true, beforeWelcome: false },
]) test(`menu voice ${initiallyOn ? "off" : "on"} ${beforeWelcome ? "before welcome" : "after joining"} updates its reconnect hello`, async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-registration-"));
	const dir = join(home, "voice");
	let peer = registrationPeer(dir, beforeWelcome);
	await peer.listen();
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: initiallyOn, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	const pi = register(h);
	const ui = fakeContext({ select: pick(initiallyOn ? /^Voice in this session \(on\): turn off$/ : /^Voice in this session \(off\): turn on$/) });
	// Inspect the actual client-side join, not just the peer's receipt of hello.
	const clients: VoiceListenerClient[] = [];
	const connect = VoiceListenerClient.prototype.connect;
	VoiceListenerClient.prototype.connect = function () { clients.push(this); return connect.call(this); };
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => peer.frames.some((frame) => frame.type === "hello") && clients.length > 0);
		if (beforeWelcome) assert.equal(clients[0]!.connected, false);
		else await until(() => clients[0]!.connected);
		await run(pi, ui);
		if (beforeWelcome) {
			await until(() => peer.frames.filter((frame) => frame.type === "hello").length === 2 && clients.some((client) => client.connected));
			await until(() => peer.voiceSessions().length === 1);
			assert.deepEqual(peer.frames.filter((frame) => frame.type === "hello").map((frame) => frame.voiceOn), [false, true], "an unjoined passive client is replaced by a fresh on hello");
			assert.deepEqual(peer.frames.filter((frame) => frame.type === "session-voice"), []);
			peer.releaseWelcomes();
		} else {
			await until(() => peer.frames.some((frame) => frame.type === "session-voice"));
			assert.deepEqual(peer.frames.filter((frame) => frame.type === "session-voice"), [{ schema: "gentle.voice-listener/v1", type: "session-voice", voiceOn: !initiallyOn }]);
		}
		assert.deepEqual(peer.voiceSessions(), initiallyOn ? [] : ["session-alpha"]);
		assert.deepEqual(h.voice.sessions, initiallyOn ? [] : ["session-alpha"]);
		assert.deepEqual(h.voice.writes, [initiallyOn ? [] : ["session-alpha"]]);
		assert.equal(peer.frames.some((frame) => frame.type === "set-voice"), false, "the menu never turns off other sessions");
		await peer.close();
		peer = registrationPeer(dir);
		await peer.listen();
		await until(() => peer.frames.some((frame) => frame.type === "hello"), 1_000);
		assert.equal(peer.frames.find((frame) => frame.type === "hello")?.voiceOn, !initiallyOn, "the restart uses current voice, not startup voice");
		assert.deepEqual(peer.voiceSessions(), initiallyOn ? [] : ["session-alpha"]);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		VoiceListenerClient.prototype.connect = connect;
		await peer.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a queued cut hello uses the current voice after the session turns back on", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-cut-"));
	const peer = registrationPeer(join(home, "voice"));
	await peer.listen();
	const gate = deferred<void>();
	let dialing = false;
	const connect = VoiceListenerClient.prototype.connect;
	VoiceListenerClient.prototype.connect = function () { dialing = true; return gate.promise.then(() => connect.call(this)); };
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.readCut;
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await run(pi, fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) }));
		await until(() => dialing);
		assert.deepEqual(h.voice.sessions, []);
		await run(pi, fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) }));
		assert.deepEqual(h.voice.sessions, ["session-alpha"]);
		gate.resolve();
		await until(() => peer.frames.some((frame) => frame.type === "hello"));
		const hello = peer.frames.find((frame) => frame.type === "hello")!;
		assert.equal(hello.role, "reading");
		assert.equal(hello.voiceOn, true, "the cut did not replay the old off value");
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		gate.resolve();
		await pi.fire("session_shutdown", ui.ctx);
		VoiceListenerClient.prototype.connect = connect;
		await peer.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a broadcast voice-off remains off after the listener restarts", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-broadcast-rejoin-"));
	const dir = join(home, "voice");
	let peer = registrationPeer(dir);
	await peer.listen();
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => peer.voiceSessions().includes("session-alpha"));
		peer.broadcastOff();
		await until(() => peer.frames.some((frame) => frame.type === "session-voice"));
		assert.deepEqual(h.voice.writes, [[]]);
		assert.deepEqual(peer.frames.filter((frame) => frame.type === "session-voice"), [{ schema: "gentle.voice-listener/v1", type: "session-voice", voiceOn: false }]);
		await peer.close();
		peer = registrationPeer(dir);
		await peer.listen();
		await until(() => peer.frames.some((frame) => frame.type === "hello"), 1_000);
		assert.equal(peer.frames.find((frame) => frame.type === "hello")?.voiceOn, false);
		assert.deepEqual(peer.voiceSessions(), []);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		await peer.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("menu off updates only its registration while another session remains on", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-session-only-"));
	const dir = join(home, "voice");
	const peer = registrationPeer(dir);
	await peer.listen();
	const other = new VoiceListenerClient({ dir, session: { sessionId: "other", voiceOn: true } });
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	h.voice.sessions.push("other");
	delete (h.deps as { createSession?: unknown }).createSession;
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	try {
		await other.connect();
		await pi.fire("session_start", ui.ctx);
		await until(() => peer.voiceSessions().length === 2);
		await run(pi, ui);
		await until(() => peer.frames.some((frame) => frame.type === "session-voice"));
		assert.deepEqual(peer.voiceSessions(), ["other"]);
		assert.deepEqual(h.voice.sessions, ["other"]);
		assert.equal(peer.frames.some((frame) => frame.type === "set-voice"), false);
	} finally {
		other.close();
		await pi.fire("session_shutdown", ui.ctx);
		await peer.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("turning voice on from the menu may ensure a listener absent at voice-off startup", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-enable-join-"));
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	let ensures = 0;
	h.deps.listener = { ensure: async () => { ensures++; return true; }, close: () => {}, dictate: () => { throw new Error("unexpected capture"); } };
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) });
	try {
		await pi.fire("session_start", ui.ctx);
		assert.equal(ensures, 0, "voice-off startup cannot start the listener");
		await run(pi, ui);
		await until(() => ensures === 1);
		assert.deepEqual(h.voice.sessions, ["session-alpha"]);
		assert.equal(pi.counts.sends, 0);
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		rmSync(home, { recursive: true, force: true });
	}
});

test("turning voice off while startup is probing cannot start a listener later", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-off-during-join-"));
	const gate = deferred<boolean>();
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	let probes = 0;
	let starts = 0;
	const link = createSessionListenerLink({
		dir: join(home, "voice"),
		session: () => ({ sessionId: "session-alpha", voiceOn: h.voice.sessions.includes("session-alpha") }),
		probe: () => { probes++; return gate.promise; },
		start: () => { starts++; },
		waitMs: 0,
	});
	h.deps.listener = link;
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => probes === 1);
		await run(pi, ui);
		gate.resolve(false);
		await tick();
		await tick();
		assert.equal(starts, 0, "the old on-state join cannot start a listener after off");
		assert.deepEqual(h.voice.writes, [[]]);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		gate.resolve(false);
		await pi.fire("session_shutdown", ui.ctx);
		rmSync(home, { recursive: true, force: true });
	}
});

test("a voice-on session joins at start without capture and receives a voice-off broadcast (S14, S6)", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-awake-"));
	const dir = join(home, "voice");
	const requests: ListenerDictationRequest[] = [];
	const hellos: Array<Record<string, unknown>> = [];
	const server = new VoiceListener({
		dir,
		dictation: (request) => { requests.push(request); throw new Error("unexpected capture"); },
		log: (event, fields) => { if (event === "listener.hello") hellos.push(fields ?? {}); },
	});
	let actor: VoiceListenerClient | undefined;
	let pi: ReturnType<typeof fakePi> | undefined;
	const ui = fakeContext();
	await server.listen();
	try {
		const { engine } = fakeEngine();
		const h = harness({ installed: true, voice: true, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
		delete (h.deps as { createSession?: unknown }).createSession;
		pi = register(h);
		await pi.fire("session_start", ui.ctx);
		await until(() => server.voiceSessions.includes("session-alpha"));
		assert.ok(hellos.some((hello) => hello.sessionId === "session-alpha" && hello.role === "session" && hello.voiceOn === true));
		assert.equal(requests.length, 0, "startup requests no capture");
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), [], "startup plays no cue");
		assert.deepEqual(h.voice.sessions, ["session-alpha"]);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");

		actor = new VoiceListenerClient({ dir, session: { sessionId: "other", voiceOn: false }, role: "reading" });
		await actor.connect();
		await actor.request({ type: "set-voice", voiceOn: false });
		await until(() => h.voice.sessions.length === 0);
		assert.deepEqual(h.voice.writes, [[]], "the broadcast turns the persisted setting off");
		assert.deepEqual(ui.notices.at(-1), { message: "Voice is off in this session.", type: "info" });
		assert.equal(requests.length, 0);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		actor?.close();
		await pi?.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a new session id on the same context replaces the old listener registration", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-new-session-"));
	const dir = join(home, "voice");
	const server = new VoiceListener({ dir, dictation: () => { throw new Error("unexpected capture"); } });
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
	h.voice.sessions.push("session-beta");
	delete (h.deps as { createSession?: unknown }).createSession;
	const pi = register(h);
	const ui = fakeContext();
	let id = "session-alpha";
	(ui.ctx.sessionManager as unknown as { getSessionId(): string }).getSessionId = () => id;
	await server.listen();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => server.sessionIds.includes("session-alpha"));
		id = "session-beta";
		await pi.fire("session_start", ui.ctx);
		await until(() => server.sessionIds.includes("session-beta"));
		assert.deepEqual(server.sessionIds, ["session-beta"], "only the new session remains registered");
		assert.deepEqual(server.voiceSessions, ["session-beta"]);
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), []);
		assert.deepEqual(h.voice.writes, []);
		assert.equal(ui.editor(), "draft: ");
		assert.equal(pi.counts.sends, 0);
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("T21-R1: closing a passive asleep display before offline local capture clears it and shows the microphone", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-passive-fallback-"));
	const dir = join(home, "voice");
	const server = new VoiceListener({ dir, dictation: () => { throw new Error("unexpected listener capture"); } });
	await server.listen();
	const h = harness({ installed: true, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete h.deps.createSession;
	const link = createSessionListenerLink({ dir, waitMs: 0, probe: async () => false, start: () => {}, session: () => ({ sessionId: "session-alpha", paneId: "w1:p1", voiceOn: false }) });
	let local: FakeSession | undefined;
	h.deps.listener = {
		ensure: () => link.ensure(), close: () => link.close(),
		dictate: request => link.dictate({ ...request, fallback: () => (local = Object.assign(new FakeSession(request.onStateChange), { owner: "session" as const })) }),
	};
	const pi = register(h);
	const ui = fakeContext();
	const observers = new Map<string, (value: unknown) => void>();
	const receiver = createVoiceReceiver({ on: (name, fn) => { observers.set(name, fn); return () => observers.delete(name); } }, () => "session-alpha", () => {});
	const bus = pi.pi.events as unknown as { emit(name: string, value: unknown): void };
	const emit = bus.emit;
	bus.emit = (name, value) => { emit(name, value); observers.get(name)?.(value); };
	const displays = () => pi.emitted.filter(event => event.channel === "gentle-ai:voice-display").map(event => event.data as { state: string });
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => receiver.model().state === "asleep");
		assert.equal(server.clientCount, 1, "a voice-off session passively subscribes");
		const done = press(pi, ui);
		await until(() => local !== undefined);
		assert.equal(displays().at(-1)?.state, "off", "retiring the passive socket clears its snapshot before fallback");
		local!.started.resolve();
		await until(() => local!.state === "recording");
		assert.equal(receiver.model().state, "listening", "the recording microphone remains visible");
		assert.deepEqual(h.cues.filter(name => name === "open" || name === "close"), ["open"]);
		await press(pi, ui);
		await until(() => local!.calls.includes("stop"));
		local!.result.resolve({ text: "hola local", truncated: false });
		await done;
		assert.equal(receiver.model().state, "off", "the retired asleep snapshot cannot reappear when capture ends");
		assert.equal(ui.editor(), "draft: hola local");
		assert.deepEqual(h.cues.filter(name => name === "open" || name === "close"), ["open", "close"]);
		assert.deepEqual(pi.sent, []);
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		receiver.dispose();
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("an unreachable listener at startup is logged and Alt+M still records locally (S10)", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-offline-"));
	const dir = join(home, "voice");
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	const link = createSessionListenerLink({ dir, waitMs: 0, start: () => {}, session: () => ({ sessionId: "session-alpha", paneId: "w1:p1", voiceOn: true }) });
	let local: FakeSession | undefined;
	h.deps.listener = {
		ensure: () => link.ensure(),
		close: () => link.close(),
		dictate: (request) => link.dictate({ ...request, fallback: () => (local = Object.assign(new FakeSession(request.onStateChange), { owner: "session" as const })) }),
	};
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => h.events.some((entry) => entry.event === "listener.join" && entry.result === "unavailable"));
		assert.equal(local, undefined, "startup does not capture locally");
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), []);
		assert.deepEqual(h.voice.sessions, ["session-alpha"]);
		assert.deepEqual(h.voice.writes, [], "a missing listener changes no saved voice setting");
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
		assert.equal(ui.notices.length, 0, "a missing listener does not interrupt the session");
		(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
		const done = press(pi, ui);
		await until(() => local !== undefined);
		local!.started.resolve();
		await until(() => local!.state === "recording");
		await press(pi, ui);
		await until(() => local!.calls.includes("stop"));
		local!.result.resolve({ text: "hola local", truncated: false });
		await done;
		assert.deepEqual(local!.calls, ["start", "stop"]);
		assert.deepEqual(pi.sent, [{ content: "hola local", options: undefined }]);
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), ["open", "close"]);
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		rmSync(home, { recursive: true, force: true });
	}
});

test("Alt+M cancellation retires a hanging startup join and the next press probes afresh", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-hung-join-"));
	const dir = join(home, "voice");
	const gate = deferred<boolean>();
	const hellos: string[] = [];
	const calls: string[] = [];
	const server = new VoiceListener({
		dir,
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
		log: (event, fields) => { if (event === "listener.hello") hellos.push(String(fields?.sessionId)); },
		dictation: (request) => ({
			start: async () => { calls.push("start"); request.onStateChange("recording"); },
			stop: async () => ({ text: "hola", truncated: false }),
			cancel: async () => { calls.push("cancel"); request.onStateChange("finished"); },
		}),
	});
	await server.listen();
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	let probes = 0;
	let firstStart: Promise<void> | undefined;
	const link = createSessionListenerLink({
		dir,
		session: () => ({ sessionId: "session-alpha", paneId: "w1:p1", voiceOn: true }),
		probe: () => ++probes === 1 ? gate.promise : Promise.resolve(true),
	});
	h.deps.listener = {
		ensure: () => link.ensure(),
		close: () => link.close(),
		dictate: (request) => {
			const actual = link.dictate(request);
			return {
				get state() { return actual.state; },
				get owner() { return actual.owner; },
				start: () => { const started = actual.start(); firstStart ??= started; return started; },
				stop: () => actual.stop(),
				cancel: () => actual.cancel(),
			};
		},
	};
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await until(() => probes === 1);
		const first = press(pi, ui);
		await until(() => firstStart !== undefined);
		ui.type(ESC);
		await first;
		const settled = await Promise.race([firstStart!.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 100))]);
		assert.equal(settled, "settled", "cancel settles the actual pending dictate.start");
		assert.deepEqual(calls, [], "the cancelled join opened no microphone");

		const retry = press(pi, ui);
		await until(() => calls.includes("start"));
		assert.equal(probes, 2, "retry probes before the old probe is released");
		gate.resolve(true);
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.deepEqual(hellos, ["session-alpha"], "the retired probe cannot send a stale hello");
		assert.equal(server.clientCount, 1);
		ui.type(ESC);
		await retry;
		assert.deepEqual(calls, ["start", "cancel"]);
		assert.equal(ui.editor(), "draft: ");
		assert.equal(pi.counts.sends, 0);
	} finally {
		gate.resolve(true);
		await pi.fire("session_shutdown", ui.ctx);
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

for (const outcome of ["success", "failure"] as const) test(`shutdown aborts a still-pending startup join before its late ${outcome}`, async () => {
	const gate = deferred<boolean>();
	const h = harness({ installed: true, voice: true });
	delete (h.deps as { createSession?: unknown }).createSession;
	let closed = 0;
	h.deps.listener = {
		ensure: () => gate.promise,
		close: () => { closed++; },
		dictate: () => { throw new Error("unexpected capture"); },
	};
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	let stopped = false;
	const shutdown = pi.fire("session_shutdown", ui.ctx).then(() => { stopped = true; });
	await tick();
	assert.equal(closed, 1, "the old link is closed immediately");
	const stoppedBeforeJoinSettled = stopped;
	if (outcome === "success") gate.resolve(true);
	else gate.reject(new Error("listener unreachable"));
	await shutdown;
	await tick();
	assert.equal(stoppedBeforeJoinSettled, true, "shutdown does not wait for the listener timeout");
	assert.ok(closed >= 1, "the old connection stays closed");
	assert.equal(h.events.some((entry) => entry.event === "listener.join"), false, "a dead session logs no late failure");
	assert.equal(pi.counts.sends, 0);
	assert.equal(ui.editor(), "draft: ");
});

test("a replaced startup connection sends no late hello or command to the new session", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-stale-"));
	const dir = join(home, "voice");
	mkdirSync(dir);
	const hellos: string[] = [];
	const server = createServer((socket) => {
		socket.on("error", () => {});
		socket.setEncoding("utf8");
		let buffered = "";
		socket.on("data", (chunk) => {
			buffered += chunk;
			let newline: number;
			while ((newline = buffered.indexOf("\n")) >= 0) {
				const hello = JSON.parse(buffered.slice(0, newline)) as { type: string; id: string; sessionId: string };
				buffered = buffered.slice(newline + 1);
				if (hello.type !== "hello") continue;
				hellos.push(hello.sessionId);
				const welcome = encodeListenerFrame({ type: "welcome", id: hello.id, listenerPid: process.pid, proto: 1, state: "asleep" });
				// Both frames arrive together, before the pending join can close itself.
				const stale = hello.sessionId === "session-alpha"
					? encodeListenerFrame({ type: "transcript", text: "stale" }) + encodeListenerFrame({ type: "command", command: "voice-off" })
					: "";
				socket.write(welcome + stale);
			}
		});
	});
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(listenerPaths(dir).socket, resolve); });
	const { engine } = fakeEngine();
	const h = harness({ installed: true, voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home, HERDR_PANE_ID: "w1:p1" } });
	h.voice.sessions.push("session-beta");
	delete (h.deps as { createSession?: unknown }).createSession;
	const pi = register(h);
	const old = fakeContext({}, "tui", true, "session-alpha");
	const next = fakeContext({}, "tui", true, "session-beta");
	try {
		// Replacement happens while the old link is still probing the socket, before
		// its client exists and the first close can reach it.
		const first = pi.fire("session_start", old.ctx);
		const second = pi.fire("session_start", next.ctx);
		await Promise.all([first, second]);
		await until(() => hellos.includes("session-beta"));
		assert.deepEqual(hellos, ["session-beta"], "the aborted old connection never sends its hello");
		assert.deepEqual(h.voice.sessions, ["session-alpha", "session-beta"], "the stale command cannot turn off the replacement");
		assert.deepEqual(h.voice.writes, []);
		assert.equal(h.events.some((entry) => entry.event === "transcript.received"), false, "the stale transcript is discarded");
		assert.deepEqual(next.notices, []);
		assert.equal(pi.counts.sends, 0);
		assert.equal(next.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", next.ctx);
		await new Promise<void>((resolve) => server.close(() => resolve()));
		rmSync(home, { recursive: true, force: true });
	}
});

test("voice-off startup with no listener does not ensure, spawn, capture, or change the session", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-off-no-listener-"));
	const h = harness({ installed: true, env: { GENTLE_PI_CONFIG_HOME: home } });
	delete (h.deps as { createSession?: unknown }).createSession;
	let ensures = 0;
	h.deps.listener = {
		ensure: async () => { ensures++; return false; },
		close: () => {},
		dictate: () => { throw new Error("unexpected capture"); },
	};
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		await tick();
		assert.equal(ensures, 0, "voice-off startup never starts a listener");
		assert.deepEqual(h.voice.writes, []);
		assert.deepEqual(h.cues, []);
		assert.equal(pi.counts.sends, 0);
		assert.equal(ui.editor(), "draft: ");
	} finally {
		await pi.fire("session_shutdown", ui.ctx);
		rmSync(home, { recursive: true, force: true });
	}
});

test("unsupported or non-shared session paths never join a listener at startup", async () => {
	for (const scenario of ["child", "rpc", "anonymous", "local-factory"] as const) {
		const h = harness({ installed: true, voice: true, env: scenario === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {} });
		if (scenario !== "local-factory") delete (h.deps as { createSession?: unknown }).createSession;
		let joins = 0;
		h.deps.listener = {
			ensure: async () => { joins++; return true; },
			close: () => {},
			dictate: () => { throw new Error("unexpected capture"); },
		};
		const pi = register(h);
		const ui = fakeContext({}, scenario === "rpc" ? "rpc" : "tui", true, scenario === "anonymous" ? "" : "session-alpha");
		await pi.fire("session_start", ui.ctx);
		assert.equal(joins, 0, scenario);
		assert.equal(pi.counts.sends, 0, scenario);
		assert.equal(ui.editor(), "draft: ", scenario);
		await pi.fire("session_shutdown", ui.ctx);
	}
});

test("a reload closes the connection it leaves behind, so its replacement keeps the microphone (S6)", async () => {
	const home = mkdtempSync(join(tmpdir(), "voice-command-reload-"));
	const dir = join(home, "voice");
	const requests: ListenerDictationRequest[] = [];
	const dictation = (request: ListenerDictationRequest): ListenerDictation => {
		requests.push(request);
		return { start: async () => request.onStateChange("recording"), stop: async () => ({ text: "hola", truncated: false }), cancel: async () => request.onStateChange("finished") };
	};
	const server = new VoiceListener({ dir, dictation, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const reached = async (check: () => boolean, ms = 2_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(check(), "condition not reached");
	};
	await server.listen();
	try {
		const env = { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home };
		const join = () => createSessionListenerLink({ dir, session: () => ({ sessionId: "session-alpha", paneId: "w1:p1", voiceOn: true }) });
		const first = harness({ installed: true, env });
		delete (first.deps as { createSession?: unknown }).createSession;
		first.deps.listener = join();
		const pi = register(first);
		const ui = fakeContext();
		await pi.fire("session_start", ui.ctx);
		const done = press(pi, ui);
		await reached(() => requests.length === 1);
		assert.equal(server.clientCount, 1, "the session is joined to the listener");
		await press(pi, ui);
		await done;

		// A reload keeps the session id: the connection the old instance owned goes
		// with it, so the new one is not evicted by a client nobody uses any more.
		await pi.fire("session_shutdown", ui.ctx);
		await reached(() => server.clientCount === 0, 2_000);

		const second = harness({ installed: true, env });
		delete (second.deps as { createSession?: unknown }).createSession;
		second.deps.listener = join();
		const reloaded = register(second);
		const next = fakeContext();
		await reloaded.fire("session_start", next.ctx);
		const again = press(reloaded, next);
		await reached(() => requests.length === 2);
		assert.equal(server.clientCount, 1, "the reloaded instance holds the one connection of its session");
		// Nothing ping-pongs: the connection settles and the dictation works.
		await new Promise((resolve) => setTimeout(resolve, 400));
		assert.equal(server.clientCount, 1, "no connection churn after the reload");
		await press(reloaded, next);
		await again;
		assert.equal(next.editor(), "draft: hola", "a dictation through the reloaded instance reaches the draft");
		second.deps.listener.close();
	} finally {
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
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

// --- only the focused pane reads aloud (S12) ---------------------------------------------

// A held reply is polled every few milliseconds here so a test never waits for
// the real interval; the ten-minute window stays the real one unless it is the
// subject.
test("the held window is ten minutes and the poll is a modest interval", async () => {
	assert.equal(HELD_REPLY_STALE_MS, 600_000);
	assert.ok(HELD_REPLY_POLL_MS >= 1_000 && HELD_REPLY_POLL_MS <= 2_000, `${HELD_REPLY_POLL_MS} ms`);
});

test("a reply in the focused pane is read at once and never held", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta al panel enfocado.");
	await until(() => readings.length === 1);
	assert.equal(readings[0]!.text, "Respuesta al panel enfocado.");
	assert.equal(h.events.some((entry) => entry.event === "reading.held"), false);
});

test("a reply from a pane without the focus is held, then read when that pane is focused", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused" });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Terminé lo que pediste.");
	await until(() => h.events.some((entry) => entry.event === "reading.held"));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 0, "nothing is read while the owner looks at another pane");
	const held = h.events.find((entry) => entry.event === "reading.held")!;
	assert.deepEqual([held.session, held.chars], ["session-alpha", "Terminé lo que pediste.".length]);
	assert.equal(JSON.stringify(h.events).includes("Terminé"), false, "the held text is never logged");
	assert.equal(ui.terminal.subscribes, 0, "no reading, so no Esc listener either");
	h.focus.state = "focused";
	await until(() => readings.length === 1);
	assert.equal(readings[0]!.text, "Terminé lo que pediste.", "the held reply is read when the pane comes back");
	assert.equal(ui.terminal.subscribes, 1, "it is an ordinary reading: esc skips it");
});

test("only the newest held reply is kept, and focusing reads that one", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused" });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Primera guardada.");
	await settleReply(pi, ui.ctx, "Segunda guardada.");
	await until(() => h.events.filter((entry) => entry.event === "reading.held").length === 2);
	assert.equal(readings.length, 0);
	h.focus.state = "focused";
	await until(() => readings.length === 1);
	assert.equal(readings[0]!.text, "Segunda guardada.", "the older held reply is gone");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 1, "and it is never read later");
});

test("a held reply older than ten minutes is dropped and never read", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused", holdStaleMs: 20 });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta que ya no importa.");
	await until(() => h.events.some((entry) => entry.event === "reading.dropped"));
	const dropped = h.events.find((entry) => entry.event === "reading.dropped")!;
	assert.deepEqual([dropped.session, dropped.reason], ["session-alpha", "stale"]);
	h.focus.state = "focused";
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 0, "the stale reply is not read on focus");
	assert.equal(JSON.stringify(h.events).includes("ya no importa"), false, "the dropped text is never logged");
});

test("a new message drops the held reply instead of reading it later", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused" });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta guardada.");
	await until(() => h.events.some((entry) => entry.event === "reading.held"));
	await pi.fire("input", ui.ctx, { type: "input", text: "sigo yo", source: "interactive" });
	h.focus.state = "focused";
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 0, "the owner moved on");
});

test("turning voice off drops the held reply", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused", installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta guardada.");
	await until(() => h.events.some((entry) => entry.event === "reading.held"));
	await run(pi, fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) }));
	assert.deepEqual(h.voice.sessions, [], "voice is off");
	h.focus.state = "focused";
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 0);
});

test("the end of the session drops the held reply and stops the poll", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unfocused" });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta guardada.");
	await until(() => h.events.some((entry) => entry.event === "reading.held"));
	await pi.fire("session_shutdown", ui.ctx);
	const asked = h.focus.asks;
	h.focus.state = "focused";
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(readings.length, 0);
	assert.equal(h.focus.asks, asked, "nothing polls for a session that is gone");
});

// A herdr that cannot answer never silences a reply: it keeps reading it, as it
// did before the focus decided anything.
test("a focus herdr cannot report keeps reading the reply at once", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine, focus: "unknown" });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta sin foco conocido.");
	await until(() => readings.length === 1);
	assert.equal(h.events.some((entry) => entry.event === "reading.held"), false);
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
	assert.equal(h.calls.some((call) => call.startsWith("session:")), false, "turning voice on from the menu opens no microphone");
	assert.equal(h.sessions.length, 0, "and nothing records: only a spoken wake starts a conversation");
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

for (const reload of [false, true]) test(`a spoken wake reaches the focused session immediately after ${reload ? "reload" : "session start"} without Alt+M (S7, S11)`, async () => {
	const { engine, readings } = fakeEngine();
	const home = mkdtempSync(join(tmpdir(), "voice-command-wake-"));
	const dir = join(home, "voice");
	const requests: ListenerDictationRequest[] = [];
	const dictation = (request: ListenerDictationRequest): ListenerDictation => {
		requests.push(request);
		return {
			start: async () => request.onStateChange("recording"),
			stop: async () => {
				request.onStateChange("transcribing");
				request.onStateChange("finished");
				return { text: request.mode === "conversation" ? "sí, te escucho" : "un dictado", truncated: false };
			},
			cancel: async () => request.onStateChange("finished"),
		};
	};
	// Asleep keeps a spot-only capture open: hearing the wake word there is the only
	// way a session is ever woken by voice.
	let heard: ((command: string | undefined) => void) | undefined;
	let spotStarts = 0;
	const spot: ListenerSpotFactory = () => {
		spotStarts += 1;
		let settle!: (command: string | undefined) => void;
		const waiting = new Promise<string | undefined>((resolve) => (settle = resolve));
		heard = settle;
		return { start: async () => {}, heard: () => waiting, stop: async () => settle(undefined), cancel: async () => settle(undefined) };
	};
	const cueNames: string[] = [];
	const server = new VoiceListener({
		dir,
		dictation,
		spot,
		keyword: { model: { root: "/opt/gentle/voice/models/kws", files: {} }, keywords: [{ tokens: "▁G ENT LE ▁ VO IC E ▁ON", command: "voice-on" }], boost: 2, threshold: 0.25, maxActivePaths: 16, trailingBlanks: 2 },
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
		cues: {
			play: (name) => {
				cueNames.push(name);
				return Promise.resolve({ name, outcome: "done" as const, ms: 1 });
			},
			warm: () => {},
			dispose: () => {},
		},
	});
	// A listener round trip is a socket: it needs wall time, not just turns of the
	// event loop, so every wait here is bounded in milliseconds.
	const reached = async (check: () => boolean, ms = 2_000): Promise<void> => {
		const deadline = Date.now() + ms;
		while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(check(), "condition not reached");
	};
	await server.listen();
	try {
		const h = harness({ installed: true, engine, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
		// The microphone and the reading turn both live in the listener: the session
		// reaches it through its own link, as it does in production.
		delete (h.deps as { createSession?: unknown }).createSession;
		let pi = register(h);
		let ui = fakeContext();
		await pi.fire("session_start", ui.ctx);
		await reached(() => server.sessionIds.includes("session-alpha"));
		if (reload) {
			await pi.fire("session_shutdown", ui.ctx);
			await reached(() => server.clientCount === 0);
			pi = register(h);
			ui = fakeContext();
			await pi.fire("session_start", ui.ctx);
			await reached(() => server.sessionIds.includes("session-alpha"));
		}
		assert.deepEqual(h.voice.sessions, [], "voice starts off");
		assert.equal(requests.length, 0, "joining does not start a dictation");
		assert.deepEqual(cueNames, [], "joining plays no cue");
		assert.deepEqual(h.cues, [], "the session plays no cue");
		assert.equal(ui.editor(), "draft: ");
		assert.equal(pi.counts.sends, 0);
		(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
		await reached(() => spotStarts >= 1 && heard !== undefined);
		heard!("voice-on");

		// The wake leaves this session listening: the same hands-free conversation the
		// shortcut starts, so it records, transcribes and sends on its own.
		await reached(() => requests.length === 1);
		assert.equal(requests[0]!.mode, "conversation", "the wake starts the conversation, not a pasting dictation");
		assert.deepEqual(requests[0]!.endpoint, CONVERSATION_ENDPOINT, "with the endpointer the shortcut uses");
		assert.deepEqual(h.voice.sessions, ["session-alpha"], "the wake turned voice on for the session it woke");
		await reached(() => /conversation/i.test(ui.statuses.at(-1) ?? ""));
		assert.match(ui.statuses.at(-1) ?? "", /conversation/i, "the footer shows the same conversation the shortcut shows");
		assert.deepEqual(cueNames, ["open"], "one open cue, from the capture that really records");
		assert.deepEqual(h.cues.filter((name) => name === "open" || name === "close"), [], "the session claims no cue the listener plays");

		// The end of speech stops the recording and sends the transcript, exactly as it
		// does after alt+m: the conversation has no key press to stop it.
		requests[0]!.onStateChange("finished");
		await reached(() => pi.sent.length === 1);
		assert.deepEqual(pi.sent, [{ content: "sí, te escucho", options: undefined }]);
		assert.equal(ui.editor(), "", "a conversation sends, it never pastes");

		// And the microphone reopens after the reply is read, as in any conversation.
		await settleReply(pi, ui.ctx, "Te escucho.");
		await reached(() => readings.length === 1);
		assert.equal(requests.length, 1, "the microphone stays closed while the reply is read");
		readings[0]!.finish("done");
		await reached(() => requests.length === 2);
		assert.equal(requests[1]!.mode, "conversation", "the conversation keeps going after a reading");
	} finally {
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

// Use the real listener, session link and reading-turn client, but fake the
// worker and speaker. No audio or live voice settings are touched.
async function awakeConversationFixture(busy: boolean, installGate?: Promise<void>, localFocusGate?: Promise<void>, initiallyOn = true) {
	const { engine, readings } = fakeEngine();
	const home = mkdtempSync(join(tmpdir(), "voice-command-awake-on-"));
	const dir = join(home, "voice");
	const requests: ListenerDictationRequest[] = [];
	const listenerEvents: Array<{ event: string } & Record<string, unknown>> = [];
	const cueNames: string[] = [];
	let heard: ((command: string | undefined) => void) | undefined;
	let spotStarts = 0;
	const focus = { pane: "w1:p1" };
	const server = new VoiceListener({
		dir,
		dictation: (request) => {
			requests.push(request);
			return {
				start: async () => request.onStateChange("recording"),
				stop: async () => { request.onStateChange("transcribing"); request.onStateChange("finished"); return { text: "seguí por favor", truncated: false }; },
				cancel: async () => request.onStateChange("finished"),
			};
		},
		spot: () => {
			spotStarts++;
			let settle!: (command: string | undefined) => void;
			const waiting = new Promise<string | undefined>((resolve) => { settle = resolve; });
			heard = settle;
			return { start: async () => {}, heard: () => waiting, stop: async () => settle(undefined), cancel: async () => settle(undefined) };
		},
		keyword: { model: { root: "/fake/kws", files: {} }, keywords: [{ tokens: "ON", command: "voice-on" }], boost: 2, threshold: 0.25, maxActivePaths: 16, trailingBlanks: 2 },
		focus: { focusedPaneId: async () => ({ focused: focus.pane }) },
		cues: { play: async (name) => { cueNames.push(name); return { name, outcome: "done", ms: 1 }; }, warm: () => {}, dispose: () => {} },
		log: (event, fields) => listenerEvents.push({ event, ...fields }),
	});
	const reached = async (check: () => boolean, ms = 2_000) => {
		const deadline = Date.now() + ms;
		while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(check(), `condition not reached; listener=${JSON.stringify(listenerEvents)} session=${JSON.stringify(h.events)} notices=${JSON.stringify(ui.notices)}`);
	};
	await server.listen();
	const h = harness({ installed: true, engine, voice: initiallyOn, env: { HERDR_PANE_ID: "w1:p1", GENTLE_PI_CONFIG_HOME: home } });
	if (installGate) {
		const readStatus = h.deps.readStatus!;
		h.deps.readStatus = async (target) => { h.calls.push("install-gate"); await installGate; return readStatus(target); };
	}
	if (localFocusGate) h.deps.paneFocus = async () => { h.focus.asks++; await localFocusGate; return h.focus.state; };
	delete (h.deps as { createSession?: unknown }).createSession;
	delete (h.deps as { readingTurn?: unknown }).readingTurn;
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(off\): turn on$/) }, "tui", true, "session-alpha", () => !busy);
	// Pi emits an input event for a sent voice message. Exercise that event too:
	// it must not discard a reply that is waiting for this very capture.
	const api = pi.pi as unknown as { sendUserMessage(content: unknown, options?: unknown): void };
	const send = api.sendUserMessage.bind(api);
	api.sendUserMessage = (content, options) => { send(content, options); void pi.fire("input", ui.ctx, { source: "extension", text: content }); };
	await pi.fire("session_start", ui.ctx);
	await reached(() => server.sessionIds.includes("session-alpha") && spotStarts > 0 && heard !== undefined);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	return {
		h, pi, ui, requests, readings, listenerEvents, cueNames, reached, focus, server, dir,
		spotStarts: () => spotStarts,
		hearOn: () => heard!("voice-on"),
		close: async () => { await pi.fire("session_shutdown", ui.ctx); await server.close(); rmSync(home, { recursive: true, force: true }); },
	};
}

test("spoken-wake and reopened conversations stay with their initiating session after focus moves", async () => {
	const f = await awakeConversationFixture(false);
	const other = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true } });
	const otherTranscripts: string[] = [];
	other.onFrame((frame) => { if (frame.type === "transcript") otherTranscripts.push(frame.text); });
	try {
		await other.connect();
		f.hearOn();
		await f.reached(() => f.requests.length === 1);
		f.focus.pane = "w1:p2";
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 1);
		assert.equal(f.pi.sent[0]!.content, "seguí por favor");
		assert.deepEqual(otherTranscripts, []);
		f.focus.pane = "w1:p1";
		await settleReply(f.pi, f.ui.ctx, "Te escucho.");
		await f.reached(() => f.readings.length === 1);
		f.readings[0]!.finish("done");
		await f.reached(() => f.requests.length === 2);
		f.focus.pane = "w1:p2";
		f.requests[1]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 2);
		assert.deepEqual(f.pi.sent.map((entry) => entry.content), ["seguí por favor", "seguí por favor"]);
		assert.deepEqual(otherTranscripts, []);
	} finally {
		other.close();
		await f.close();
	}
});

test("the real listener sends this session's reading and its played levels to the display bus", async () => {
 const f=await awakeConversationFixture(false);
 const display=()=>f.pi.emitted.filter(e=>e.channel==='gentle-ai:voice-display').map(e=>e.data as {state:string;sessionId:string});
 const levels=()=>f.pi.emitted.filter(e=>e.channel==='gentle-ai:voice-level').map(e=>e.data as {source:string;rms:number});
 try {
  await settleReply(f.pi,f.ui.ctx,'Respuesta para esta sesión.');
  await f.reached(()=>f.readings.length===1 && display().some(e=>e.state==='reading'));
  assert.equal(display().at(-1)?.sessionId,'session-alpha');
  f.readings[0]!.options.onChunk!({frameMs:50,durationMs:100,levels:[0.1,0.2]});
  await f.reached(()=>levels().length===2);
  assert.deepEqual(levels().map(e=>[e.source,e.rms]),[['reading',0.1],['reading',0.2]]);
  f.readings[0]!.finish('done');
  await f.reached(()=>display().at(-1)?.state==='off');
  assert.deepEqual(f.pi.sent,[]);
 } finally { await f.close(); }
});

test("T21-R1: reloading the same session immediately clears its retired reading snapshot", async () => {
	const f = await awakeConversationFixture(false);
	const observers = new Map<string, (value: unknown) => void>();
	const receiver = createVoiceReceiver({ on: (name, fn) => { observers.set(name, fn); return () => observers.delete(name); } }, () => "session-alpha", () => {});
	const bus = f.pi.pi.events as unknown as { emit(name: string, value: unknown): void };
	const emit = bus.emit;
	bus.emit = (name, value) => { emit(name, value); observers.get(name)?.(value); };
	try {
		await settleReply(f.pi, f.ui.ctx, "Una respuesta de la sesión anterior.");
		await f.reached(() => f.readings.length === 1 && receiver.model().state === "reading");
		await f.pi.fire("session_start", f.ui.ctx);
		assert.equal(f.readings[0]!.options.signal.aborted, true, "reload cancels the old reading");
		assert.equal(receiver.model().state, "off", "the same session id cannot inherit the retired snapshot");
		assert.deepEqual(f.pi.sent, []);
	} finally {
		receiver.dispose();
		await f.close();
	}
});

// Both wakes share the unresolved install check, but belong to different links.
async function replaceAcceptedAwakeWake(f: Awaited<ReturnType<typeof awakeConversationFixture>>) {
	f.hearOn();
	await f.reached(() => f.h.calls.includes("install-gate") && f.h.events.filter((entry) => entry.event === "wake.conversation" && entry.result === "opened").length === 1);
	const spots = f.spotStarts();
	await f.pi.fire("session_start", f.ui.ctx);
	await f.reached(() => f.listenerEvents.filter((entry) => entry.event === "listener.hello" && entry.role === "session").length === 2 && f.spotStarts() > spots);
	f.hearOn();
	await f.reached(() => f.h.events.filter((entry) => entry.event === "wake.conversation" && entry.result === "opened").length === 2);
	assert.equal(f.h.calls.filter((call) => call === "install-gate").length, 1, "both runs share the pending install check");
}

test("T19-R3: a replaced wake cannot make the new wake skip fresh focus validation", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		await replaceAcceptedAwakeWake(f);
		assert.equal(f.h.focus.state, "focused", "the session's local focus still says focused");
		f.focus.pane = "w1:p2";
		gate.resolve();
		await f.reached(() => f.requests.length > 0 || f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.requests, [], "the listener must revalidate the new wake before capturing");
		assert.ok(f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.h.cues.filter((name) => name === "open" || name === "close"), []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.ui.editor(), "");
		assert.deepEqual(f.h.voice.sessions, ["session-alpha"]);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("T19-R3: an earlier cancelled wake cannot release a later wake on the same link", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	const reader = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true }, role: "reading" });
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		f.ui.type(ESC);
		await f.reached(() => f.ui.terminal.unsubscribes === 1);
		await reader.connect();
		// The reply cannot start until the first wake's cancellation reached the
		// listener. Its end gives the next wake a fresh spotter on the same link.
		let answer = await reader.request({ type: "read-begin", readingId: "barrier", chars: 1 });
		for (let attempt = 0; answer.type === "busy" && attempt < 100; attempt++) {
			answer = await reader.request({ type: "read-begin", readingId: "barrier", chars: 1 });
		}
		assert.equal(answer.type, "granted");
		const spots = f.spotStarts();
		assert.equal((await reader.request({ type: "read-end", readingId: "barrier", outcome: "done" })).type, "ok");
		await f.reached(() => f.spotStarts() > spots);
		f.hearOn();
		await f.reached(() => f.h.events.filter((entry) => entry.event === "wake.conversation" && entry.result === "opened").length === 2);
		assert.equal(f.h.calls.filter((call) => call === "install-gate").length, 1);
		f.focus.pane = "w1:p2";
		gate.resolve();
		await f.reached(() => f.requests.length > 0 || f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.requests, []);
		assert.ok(f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
	} finally {
		gate.resolve();
		reader.close();
		await f.close();
	}
});

test("T19-R3: an obsolete wake release leaves the new wake reserved until its own capture", async () => {
	const installGate = deferred<void>();
	const focusGate = deferred<void>();
	const f = await awakeConversationFixture(true, installGate.promise, focusGate.promise);
	const reader = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true }, role: "reading" });
	try {
		await replaceAcceptedAwakeWake(f);
		await reader.connect();
		installGate.resolve();
		await f.reached(() => f.h.focus.asks > 0);
		const answer = await reader.request({ type: "read-begin", readingId: "other-reply", chars: 10 });
		assert.equal(answer.type, "busy", "the new wake still reserves the listener after the old run settles");
		if (answer.type === "busy") {
			assert.equal(answer.reason, "capture");
			assert.equal(answer.holder, "session-alpha");
		}
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		focusGate.resolve();
		await f.reached(() => f.requests.length === 1);
		assert.deepEqual(f.cueNames, ["open"]);
		assert.equal(f.requests[0]!.mode, "conversation");
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 1);
		assert.deepEqual(f.pi.sent, [{ content: "seguí por favor", options: { deliverAs: "followUp" } }]);
	} finally {
		installGate.resolve();
		focusGate.resolve();
		reader.close();
		await f.close();
	}
});

async function connectedPassiveAwakeFixture(localFocusGate?: Promise<void>) {
	const clients: VoiceListenerClient[] = [];
	const connect = VoiceListenerClient.prototype.connect;
	VoiceListenerClient.prototype.connect = function () { clients.push(this); return connect.call(this); };
	try {
		const f = await awakeConversationFixture(true, undefined, localFocusGate, false);
		await f.reached(() => clients.some((client) => client.connected));
		return { ...f, passive: clients.find((client) => client.connected)! };
	} finally {
		VoiceListenerClient.prototype.connect = connect;
	}
}

test("T19-R3: a wake after passive voice-on keeps its reservation and rechecks focus", async () => {
	const focusGate = deferred<void>();
	const f = await connectedPassiveAwakeFixture(focusGate.promise);
	try {
		assert.deepEqual(f.h.voice.sessions, []);
		assert.deepEqual(f.listenerEvents.filter((entry) => entry.event === "listener.hello").map((entry) => entry.voiceOn), [false]);
		await run(f.pi, f.ui);
		await f.reached(() => f.listenerEvents.some((entry) => entry.event === "listener.voice" && entry.sessionId === "session-alpha" && entry.voiceOn === true));
		f.hearOn();
		await f.reached(() => f.h.focus.asks > 0 && f.h.events.some((entry) => entry.event === "wake.conversation" && entry.result === "opened"));
		assert.equal(f.h.focus.state, "focused");
		f.focus.pane = "w1:p2";
		focusGate.resolve();
		await f.reached(() => f.requests.length > 0 || f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.requests, [], "the wake must not become an ordinary capture on a replacement connection");
		assert.ok(f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.ui.editor(), "");
		assert.deepEqual(f.h.voice.sessions, ["session-alpha"]);
		assert.equal(f.listenerEvents.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length, 1, "voice-on upgrades the original connection in place");
		assert.equal(f.listenerEvents.some((entry) => entry.event === "listener.client-closed" && entry.sessionId === "session-alpha"), false);
	} finally {
		focusGate.resolve();
		await f.close();
	}
});

test("T19-R3: retiring a connection with an accepted wake logs its drop and releases it", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	const reader = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true }, role: "reading" });
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		await f.pi.fire("session_start", f.ui.ctx);
		await f.reached(() => f.listenerEvents.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length === 2);
		assert.equal(f.h.events.filter((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:stale").length, 1);
		await reader.connect();
		assert.equal((await reader.request({ type: "read-begin", readingId: "retired-wake", chars: 1 })).type, "granted");
		gate.resolve();
		await f.reached(() => f.h.calls.some((call) => call.startsWith("status:")));
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.ui.editor(), "");
	} finally {
		gate.resolve();
		reader.close();
		await f.close();
	}
});

test("T19-R3: a wake loses its reservation when its connection is replaced during preparation", async () => {
	const focusGate = deferred<void>();
	const f = await connectedPassiveAwakeFixture(focusGate.promise);
	const replacement = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-alpha", paneId: "w1:p1", voiceOn: true } });
	try {
		await run(f.pi, f.ui);
		await f.reached(() => f.listenerEvents.some((entry) => entry.event === "listener.voice" && entry.voiceOn === true));
		f.hearOn();
		await f.reached(() => f.h.focus.asks > 0);
		await replacement.connect();
		await f.reached(() => !f.passive.connected && f.listenerEvents.some((entry) => entry.event === "listener.client-closed" && entry.sessionId === "session-alpha"));
		focusGate.resolve();
		await f.reached(() => f.requests.length > 0 || f.h.events.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:stale"));
		assert.deepEqual(f.requests, [], "the retired connection's wake cannot be rerouted through a replacement");
		assert.ok(f.h.events.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:stale"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.ui.editor(), "");
		const answer = await replacement.request({ type: "read-begin", readingId: "after-disconnect", chars: 1 });
		assert.equal(answer.type, "granted", "the disconnected wake left no reservation");
	} finally {
		focusGate.resolve();
		replacement.close();
		await f.close();
	}
});

test("T19-R3: a wake delayed past retirement is logged and cannot reach the replacement", async () => {
	const onFrame = VoiceListenerClient.prototype.onFrame;
	let deliverWake: (() => void) | undefined;
	VoiceListenerClient.prototype.onFrame = function (handler) {
		return onFrame.call(this, (frame) => {
			if (frame.type === "command" && frame.command === "voice-on" && frame.wake === true) {
				deliverWake = () => handler(frame);
				return;
			}
			handler(frame);
		});
	};
	let f: Awaited<ReturnType<typeof connectedPassiveAwakeFixture>> | undefined;
	let reader: VoiceListenerClient | undefined;
	try {
		f = await connectedPassiveAwakeFixture();
		await run(f.pi, f.ui);
		await f.reached(() => f!.listenerEvents.some((entry) => entry.event === "listener.voice" && entry.voiceOn === true));
		f.hearOn();
		await f.reached(() => deliverWake !== undefined);
		assert.ok(f.listenerEvents.some((entry) => entry.event === "kws.hit" && entry.reason === "whole-utterance"));
		assert.equal(f.h.events.some((entry) => entry.event === "wake.conversation"), false, "the accepted frame is held before the session handles it");
		await f.pi.fire("session_start", f.ui.ctx);
		await f.reached(() => f!.listenerEvents.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length === 2);
		deliverWake!();
		assert.ok(f.h.events.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:stale"));
		reader = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true }, role: "reading" });
		await reader.connect();
		const answer = await reader.request({ type: "read-begin", readingId: "released-wake", chars: 1 });
		assert.equal(answer.type, "granted", "retiring the old connection releases its wake reservation");
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.ui.editor(), "");
	} finally {
		VoiceListenerClient.prototype.onFrame = onFrame;
		reader?.close();
		await f?.close();
	}
});

test("T19-R3: an upgraded passive connection still opens a focused awake conversation", async () => {
	const f = await connectedPassiveAwakeFixture();
	try {
		await run(f.pi, f.ui);
		await f.reached(() => f.listenerEvents.some((entry) => entry.event === "listener.voice" && entry.sessionId === "session-alpha" && entry.voiceOn === true));
		f.hearOn();
		await f.reached(() => f.requests.length === 1);
		assert.equal(f.listenerEvents.filter((entry) => entry.event === "listener.hello" && entry.sessionId === "session-alpha").length, 1, "the awake capture uses the upgraded connection");
		assert.equal(f.listenerEvents.some((entry) => entry.event === "listener.client-closed" && entry.sessionId === "session-alpha"), false);
		assert.equal(f.server.clientCount, 1);
		assert.equal(f.requests[0]!.mode, "conversation");
		assert.deepEqual(f.cueNames, ["open"]);
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 1);
		assert.deepEqual(f.pi.sent, [{ content: "seguí por favor", options: { deliverAs: "followUp" } }]);
	} finally {
		await f.close();
	}
});

test("T19-R1: global voice off while an awake wake checks installation drops it without capture or cue", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	const other = new VoiceListenerClient({ dir: f.dir, session: { sessionId: "session-beta", paneId: "w1:p2", voiceOn: true } });
	try {
		await other.connect();
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		assert.equal((await other.request({ type: "set-voice", voiceOn: false })).type, "ok");
		await f.reached(() => f.h.voice.sessions.length === 0);
		gate.resolve();
		await f.reached(() => f.requests.length > 0 || f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:voice-off"));
		assert.deepEqual(f.requests, []);
		assert.ok(f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:voice-off"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.equal(f.server.state, "asleep");
	} finally {
		gate.resolve();
		other.close();
		await f.close();
	}
});

test("T19-R1: a persisted voice-off observed locally during preparation is logged and dropped", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		f.h.voice.sessions = [];
		gate.resolve();
		await f.reached(() => f.ui.terminal.unsubscribes > 0);
		assert.ok(f.h.events.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:voice-off"));
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("T19-R1: focus moving while an awake wake checks installation drops it without capture or cue", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		f.focus.pane = "w1:p2";
		gate.resolve();
		await f.reached(() => f.requests.length > 0 || f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.requests, []);
		assert.ok(f.listenerEvents.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.deepEqual(f.h.voice.sessions, ["session-alpha"]);
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("T19-R1/R2: a locally unfocused wake releases its reservation and the reply waits for focus", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		await settleReply(f.pi, f.ui.ctx, "Respuesta al volver.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip"));
		f.h.focus.state = "unfocused";
		gate.resolve();
		await f.reached(() => f.h.events.some((entry) => entry.event === "wake.dropped" && entry.reason === "ignored:focus-changed"));
		await f.reached(() => f.h.events.some((entry) => entry.event === "reading.held"));
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.equal(f.readings.length, 0);
		f.h.focus.state = "focused";
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "Respuesta al volver.");
		f.readings[0]!.finish("done");
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("T19-R2: a reply ready before the first dictate request waits for the reserved wake capture", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		await settleReply(f.pi, f.ui.ctx, "La respuesta esperada.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip"));
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.deepEqual(f.requests, [], "the installation gate is before the first dictate request");
		assert.equal(f.readings.length, 0, "the accepted wake reserves the shared capture slot immediately");
		assert.equal(f.listenerEvents.some((entry) => entry.event === "reading.begin"), false);
		gate.resolve();
		await f.reached(() => f.requests.length === 1);
		assert.deepEqual(f.cueNames, ["open"]);
		assert.equal(f.readings.length, 0);
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "La respuesta esperada.");
		assert.ok(f.listenerEvents.findIndex((entry) => entry.event === "capture.end") < f.listenerEvents.findIndex((entry) => entry.event === "reading.begin"));
		assert.deepEqual(f.pi.sent, [{ content: "seguí por favor", options: { deliverAs: "followUp" } }]);
		assert.equal(f.ui.notices.some((notice) => notice.type === "error"), false);
		f.readings[0]!.finish("done");
	} finally {
		gate.resolve();
		await f.close();
	}
});

test("T19-R2: failed preparation releases the wake reservation and the waiting reply is read", async () => {
	const gate = deferred<void>();
	const f = await awakeConversationFixture(true, gate.promise);
	try {
		f.hearOn();
		await f.reached(() => f.h.calls.includes("install-gate"));
		await settleReply(f.pi, f.ui.ctx, "La respuesta tras el fallo.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip"));
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(f.readings.length, 0, "the reply waits even while installation is being checked");
		assert.deepEqual(f.requests, []);
		gate.reject(new Error("install check failed"));
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "La respuesta tras el fallo.");
		assert.deepEqual(f.requests, []);
		assert.deepEqual(f.cueNames, []);
		assert.deepEqual(f.pi.sent, []);
		assert.deepEqual(f.ui.notices.at(-1), { message: "Voice dictation is not installed. Run /gentle:voice to download it.", type: "warning" });
		f.readings[0]!.finish("done");
	} finally {
		gate.resolve();
		await f.close();
	}
});

for (const busy of [false, true]) test(`awake voice-on opens a hands-free spoken turn ${busy ? "while the agent is answering" : "while idle"} (S15, S2)`, async () => {
	const f = await awakeConversationFixture(busy);
	try {
		if (busy) await f.pi.fire("agent_start", f.ui.ctx);
		f.hearOn();
		await f.reached(() => f.requests.length === 1 || f.listenerEvents.some((entry) => entry.event === "kws.hit"));
		assert.deepEqual(f.listenerEvents.filter((entry) => entry.event === "kws.hit").map(({ command, reason }) => ({ command, reason })), [{ command: "voice-on", reason: "whole-utterance" }]);
		await f.reached(() => f.requests.length === 1);
		assert.equal(f.requests[0]!.mode, "conversation");
		assert.deepEqual(f.requests[0]!.endpoint, CONVERSATION_ENDPOINT);
		assert.deepEqual(f.cueNames, ["open"]);
		assert.deepEqual(f.h.voice.writes, [], "voice was already on");
		assert.ok(f.listenerEvents.some((entry) => entry.event === "capture.begin" && entry.sessionId === "session-alpha" && entry.mode === "conversation"));
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 1);
		assert.deepEqual(f.pi.sent, [{ content: "seguí por favor", options: busy ? { deliverAs: "followUp" } : undefined }]);
		assert.equal(f.ui.editor(), "");
		await settleReply(f.pi, f.ui.ctx, "Respuesta al turno hablado.");
		await f.reached(() => f.readings.length === 1);
		f.readings[0]!.finish("done");
		await f.reached(() => f.requests.length === 2);
		assert.equal(f.requests[1]!.mode, "conversation", "the sent transcript counts as spoken for reopen");
	} finally {
		await f.close();
	}
});

for (const source of ["shortcut", "awake voice-on"] as const) test(`a reply ready during ${source} capture waits, survives its spoken send and is read afterwards (S15, JD-A-002)`, async () => {
	const f = await awakeConversationFixture(true);
	try {
		// The shortcut covers the same existing path independently of the keyword;
		// the other case exercises the complete new spot-to-reading sequence.
		const pressed = source === "shortcut" ? f.pi.shortcuts.get("alt+m")!.handler(f.ui.ctx) : undefined;
		if (source === "awake voice-on") f.hearOn();
		await f.reached(() => f.requests.length === 1);
		await settleReply(f.pi, f.ui.ctx, "La respuesta que terminó mientras dictaba.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip"));
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(f.readings.length, 0, "the speaker never starts over the open microphone");
		assert.equal(f.listenerEvents.some((entry) => entry.event === "reading.begin"), false);
		f.requests[0]!.onStateChange("finished");
		await pressed;
		await f.reached(() => f.pi.sent.length === 1);
		assert.deepEqual(f.pi.sent, [{ content: "seguí por favor", options: { deliverAs: "followUp" } }]);
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "La respuesta que terminó mientras dictaba.");
		assert.ok(f.listenerEvents.findIndex((entry) => entry.event === "capture.end") < f.listenerEvents.findIndex((entry) => entry.event === "reading.begin"));
		f.readings[0]!.finish("done");
		await f.reached(() => f.requests.length === 2);
		assert.equal(f.requests[1]!.mode, "conversation");
	} finally {
		await f.close();
	}
});

test("a reply keeps waiting past the old two-minute limit while an awake voice-on capture remains open (S15)", async () => {
	const f = await awakeConversationFixture(true);
	const realNow = Date.now;
	try {
		f.hearOn();
		await f.reached(() => f.requests.length === 1);
		await settleReply(f.pi, f.ui.ctx, "Esperá hasta que termine de hablar.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip") && f.listenerEvents.some((entry) => entry.event === "listener.hello" && entry.role === "reading"));
		// The first read-begin has been refused for the open capture. Move the
		// clock, not the wall time, past the old two-minute reading deadline.
		await new Promise((resolve) => setTimeout(resolve, 230));
		Date.now = () => realNow() + 121_000;
		await new Promise((resolve) => setTimeout(resolve, 250));
		Date.now = realNow;
		assert.equal(f.readings.length, 0);
		assert.equal(f.ui.statuses.at(-1), "Waiting to read · esc skip", "the reply was not dropped at the old deadline");
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "Esperá hasta que termine de hablar.");
		f.readings[0]!.finish("done");
	} finally {
		Date.now = realNow;
		await f.close();
	}
});

test("a reply waiting for an awake voice-on capture stays held if its session loses focus (S12, S15)", async () => {
	const f = await awakeConversationFixture(true);
	try {
		f.hearOn();
		await f.reached(() => f.requests.length === 1);
		await settleReply(f.pi, f.ui.ctx, "No hablar fuera del foco.");
		await f.reached(() => f.ui.statuses.includes("Waiting to read · esc skip"));
		f.h.focus.state = "unfocused";
		f.requests[0]!.onStateChange("finished");
		await f.reached(() => f.pi.sent.length === 1);
		await f.reached(() => f.readings.length > 0 || f.h.events.some((entry) => entry.event === "reading.held"));
		assert.equal(f.readings.length, 0, "a delayed reading cannot speak in an unfocused session");
		assert.ok(f.h.events.some((entry) => entry.event === "reading.held"));
		f.h.focus.state = "focused";
		await f.reached(() => f.readings.length === 1);
		assert.equal(f.readings[0]!.text, "No hablar fuera del foco.");
		f.readings[0]!.finish("done");
	} finally {
		await f.close();
	}
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
	assert.equal(h.focus.asks, 1, "herdr is asked once, for the reading, and never for the microphone");
});

test("in a pane that lost the focus the reply is still read but the microphone stays closed", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await talk(pi, h, ui.ctx, "hola");
	await settleReply(pi, ui.ctx, "Te respondo aunque después mires otro panel.");
	await until(() => readings.length === 1);
	// The reply was read because the pane had the focus when it settled; the owner
	// moved to another pane while it was read.
	h.focus.state = "unfocused";
	readings[0]!.finish("done");
	await until(() => h.focus.asks === 2);
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

// --- spoken commands (S4, S10) and the dictated turn (S2) -------------------------------

test("saying \"Gentle Voice off\" turns voice off for the session, sends nothing and leaves the editor alone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("un borrador");
	await talk(pi, h, ui.ctx, "Gentle Voice off.");
	assert.equal(pi.counts.sends, 0, "the command is never sent to the model");
	assert.equal(ui.editor(), "un borrador", "the draft is untouched");
	assert.deepEqual(h.voice.sessions, [], "voice is off for this session");
	assert.ok(h.warmReleases >= 1, "the warm worker is closed");
	assert.deepEqual(ui.notices.at(-1), { message: "Voice is off in this session.", type: "info" });
	assert.deepEqual(h.events.filter((entry) => entry.event === "voice.command").map((entry) => [entry.name, entry.session]), [["voice-off", "session-alpha"]]);
	assert.equal(JSON.stringify(h.events).toLowerCase().includes("gentle voice off"), false, "the transcript is never logged");
	// The reply that follows is neither read nor does it reopen the microphone.
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => h.events.some((entry) => entry.event === "reply.settled"));
	await tick();
	assert.equal(readings.length, 0);
	assert.equal(h.sessions.length, 1);
});

test("the same command in a dictation that pastes never enters the editor", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	const pressed = pi.shortcuts.get("alt+m")!.handler(ui.ctx);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.resolve();
	await until(() => h.sessions[0]!.state === "recording");
	h.sessions[0]!.emit("transcribing");
	h.sessions[0]!.emit("finished");
	h.sessions[0]!.result.resolve({ text: "gentel voice of", truncated: false });
	await pressed;
	assert.equal(ui.editor(), "", "the command is not pasted");
	assert.equal(pi.counts.sends, 0);
	assert.deepEqual(ui.notices.at(-1), { message: "Voice is off in this session.", type: "info" });
	assert.deepEqual(h.events.filter((entry) => entry.event === "voice.command").map((entry) => entry.name), ["voice-off"]);
});

test("the phrase inside a longer sentence is sent as ordinary text and leaves voice on", async () => {
	const { engine } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	await talk(pi, h, ui.ctx, "quiero que digas gentle voice off cuando termines");
	assert.deepEqual(h.voice.sessions, ["session-alpha"], "voice stays on");
	assert.deepEqual(pi.sent, [{ content: "quiero que digas gentle voice off cuando termines", options: undefined }]);
	assert.equal(h.events.some((entry) => entry.event === "voice.command"), false);
});

test("a dictation the owner sends with Enter counts as a spoken turn, so its reply reopens the microphone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "revisá el repo", truncated: false });
	await done;
	assert.equal(ui.editor(), "revisá el repo", "the dictation is pasted, as always");
	// The owner sends it with Enter: Pi reports interactive input, not a spoken send.
	await pi.fire("input", ui.ctx, { type: "input", text: ui.editor(), source: "interactive" });
	assert.equal(h.events.find((entry) => entry.event === "input")!.dictated, true, "the submitted dictation is logged as such");
	await settleReply(pi, ui.ctx, "Ya lo revisé.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 2);
	assert.deepEqual(h.endpoints.at(-1), HANDS_FREE, "the microphone reopens hands-free");
});

test("a dictation the owner kept inside a longer message still counts as spoken", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "revisá el repo", truncated: false });
	await done;
	// The owner adds a line around the dictation and sends the whole thing.
	await pi.fire("input", ui.ctx, { type: "input", text: "por favor\nrevisá el repo", source: "interactive" });
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => h.sessions.length === 2);
	assert.deepEqual(h.endpoints.at(-1), HANDS_FREE, "the microphone reopens hands-free");
});

test("a dictation typed away makes the turn typed, so its reply does not reopen the microphone", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ installed: true, engine, voice: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	await pi.fire("session_start", ui.ctx);
	(ui.ctx.ui as unknown as { setEditorText(text: string): void }).setEditorText("");
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "revisá el repo", truncated: false });
	await done;
	await pi.fire("input", ui.ctx, { type: "input", text: "esto lo escribí", source: "interactive" });
	assert.equal(h.events.find((entry) => entry.event === "input")!.dictated, false);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(h.sessions.length, 1);
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
	assert.deepEqual(ui.notices.at(-1), { message: "The natural voice is installed. Spoken replies keep using the robot voices.", type: "info" });
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

test("a queued reading hello uses the current voice value, not the value when it was queued", async () => {
	const written: Array<Record<string, unknown>> = [];
	class FakeSocket extends EventEmitter {
		destroyed = false;
		setEncoding() {}
		write(chunk: string) {
			const frame = JSON.parse(chunk) as Record<string, unknown>;
			written.push(frame);
			queueMicrotask(() => this.emit("data", encodeListenerFrame({ type: "welcome", id: String(frame.id), listenerPid: 1, proto: 1, state: "asleep" })));
			return true;
		}
		destroy() { this.destroyed = true; return this; }
	}
	const socket = new FakeSocket();
	let client: VoiceListenerClient | undefined;
	let voiceOn = true;
	const turn = createReadingTurn({
		dir: VOICE_HOME,
		turn: async ({ dir, session }) => {
			client = new VoiceListenerClient({ dir, session, role: "reading", dial: () => socket as unknown as Socket });
			await client.connect();
			return undefined;
		},
	});
	const waiting = turn(new AbortController().signal, { sessionId: "session-alpha", voiceOn: () => voiceOn });
	try {
		await until(() => client !== undefined);
		voiceOn = false;
		socket.emit("connect");
		assert.equal(await waiting, undefined);
		assert.equal(written.length, 1);
		assert.equal(written[0]!.type, "hello");
		assert.equal(written[0]!.role, "reading");
		assert.equal(written[0]!.voiceOn, false);
	} finally {
		client?.close();
	}
});

test("the session passes its live voice source to a waiting reading", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const gate = deferred<void>();
	let source: (() => boolean) | undefined;
	h.deps.readingTurn = async (_signal, hooks) => { source = hooks?.voiceOn; await gate.promise; return undefined; };
	const pi = register(h);
	const ui = fakeContext();
	try {
		await pi.fire("session_start", ui.ctx);
		// Pi can supply a different context object for the same session event.
		const eventCtx = { ...ui.ctx };
		await settleReply(pi, eventCtx, "Una respuesta pendiente.");
		await until(() => source !== undefined);
		assert.equal(source!(), true);
		ui.type(ESC);
		assert.equal(source!(), true, "cancelling a reading does not turn session voice off");
		h.voice.sessions = [];
		assert.equal(source!(), false, "a voice change in another process is read fresh");
		assert.deepEqual(readings, []);
		assert.equal(pi.counts.sends, 0);
	} finally {
		gate.resolve();
		await pi.fire("session_shutdown", ui.ctx);
	}
});

test("the default reading turn asks the voice listener in the voice home instead of a turn file", async () => {
	const { existsSync } = await import("node:fs");
	const home = mkdtempSync(join(tmpdir(), "voice-command-turn-"));
	// The release tail is the listener's; shortened so the test does not wait it out.
	const server = new VoiceListener({ dir: join(home, "voice"), readTailMs: 5 });
	try {
		await server.listen();
		const { engine, readings } = fakeEngine();
		const h = harness({ voice: true, engine, env: { GENTLE_PI_CONFIG_HOME: home } });
		delete h.deps.readingTurn;
		const pi = register(h);
		const ui = fakeContext();
		await pi.fire("session_start", ui.ctx);
		await settleReply(pi, ui.ctx, "Con el turno del listener.");
		await until(() => readings.length === 1);
		assert.equal(server.state, "reading", "the listener owns the one reading turn");
		assert.equal(existsSync(join(home, "voice", "reading-turn.json")), false, "reading-turn.json is retired");
		readings[0]!.finish("done");
		await until(() => server.state !== "reading");
		assert.ok(h.events.some((event) => event.event === "reading.end"), "the reading reports its outcome as before");
	} finally {
		await server.close();
		rmSync(home, { recursive: true, force: true });
	}
});

test("a session that cannot reach the listener still reads through the local turn", async () => {
	const signal = new AbortController().signal;
	let asked = 0;
	let local = 0;
	let released = 0;
	// The listener route, as the listener answers it: granted, refused, or gone.
	const route = (answer: "granted" | "refused" | "unavailable") => async (options: { dir: string; session: { sessionId: string }; chars?: number }) => {
		asked += 1;
		assert.equal(options.session.sessionId, "session-alpha", "the listener is told which session reads");
		if (answer === "granted") return { kind: "granted" as const, release: () => { released += 1; }, levels: () => {} };
		return answer === "refused" ? undefined : { kind: "unavailable" as const };
	};
	const localTurn = async () => { local += 1; return () => { released += 1; }; };

	const fallback = createReadingTurn({ dir: "/nonexistent/voice", turn: route("unavailable"), local: localTurn });
	const release = await fallback(signal, { sessionId: "session-alpha", chars: 12 });
	assert.equal(asked, 1, "the listener is asked first");
	assert.equal(local, 1, "an unreachable listener is not a broken voice");
	assert.equal(typeof release, "function");
	release?.();
	assert.equal(released, 1);

	// A listener that refuses the turn is obeyed: nothing reads behind its back.
	assert.equal(await createReadingTurn({ dir: "/x", turn: route("refused"), local: localTurn })(signal, { sessionId: "session-alpha" }), undefined);
	assert.equal(local, 1, "a refusal is never replaced by a local reading");

	// A granted turn is the listener's release, and a session with no id reads
	// through the local turn without asking anybody.
	const granted = await createReadingTurn({ dir: "/x", turn: route("granted"), local: localTurn })(signal, { sessionId: "session-alpha" });
	assert.equal(typeof granted, "function");
	granted?.();
	assert.equal(released, 2);
	// A session with no id has no place in the listener registry: not even asked.
	const anonymous = await createReadingTurn({ dir: "/x", turn: route("granted"), local: localTurn })(signal, {});
	assert.equal(typeof anonymous, "function");
	anonymous?.();
	assert.equal(released, 3);
	assert.equal(asked, 3, "a session with no id never asks the listener");
});

test("a reading the listener releases elsewhere stops speaking at once", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ engine, voice: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Esto se corta en otra sesión.");
	await until(() => readings.length === 1);
	assert.equal(h.turn.released, 0, "the turn is held while the reply is read");
	// Another session turned voice off or cut the reading: the listener says so.
	h.turn.cut?.();
	await until(() => readings[0]!.options.signal.aborted);
	await until(() => ui.statuses.at(-1) === undefined);
	assert.equal(h.turn.released, 1, "the turn goes back to the listener");
});

test("turning voice off cuts a reading that another session is speaking", async () => {
	const { engine } = fakeEngine();
	const h = harness({ engine, installed: true, voice: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/^Voice in this session \(on\): turn off$/) });
	await pi.fire("session_start", ui.ctx);
	await run(pi, ui);
	assert.deepEqual(h.readCuts, ["session-alpha"], "the listener is told to cut whatever it is reading");
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
	assert.deepEqual(yes.notices.at(-1), { message: "The Miro voice is installed. Spoken replies keep using the robot voices.", type: "info" });
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
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	h.focus.state = "unfocused";
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

test("the reading log and the speech event name the voice that spoke, not the chain id", async () => {
	const { engine, readings } = fakeEngine();
	const voiced: SpeechEngine = { ...engine, voiceFor: (language) => (language === "en" ? "Microsoft David" : "Microsoft Raul") };
	const h = harness({ voice: true, engine: voiced, installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "All the tests are green and the build is done.");
	await until(() => readings.length === 1);
	assert.equal(readings[0]!.options.language, "en");
	assert.deepEqual(speechEvents(pi), [{ schema: VOICE_SPEECH_SCHEMA, phase: "start", engine: "Microsoft David" }], "the event names the voice, not raul-robot");
	const start = h.events.find((entry) => entry.event === "reading.start")!;
	assert.equal(start.voice, "Microsoft David");
	assert.equal(start.language, "en");
	readings[0]!.finish("done");
	await until(() => speechEvents(pi).length === 2);
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "Microsoft David", outcome: "done" });
	assert.equal(h.events.find((entry) => entry.event === "reading.end")!.voice, "Microsoft David");
});

test("a reading that fails after its one retry is logged with the voice and the failure code", async () => {
	const failures: string[] = [];
	const engine = createRetrySpeechEngine({
		id: "raul-robot",
		voiceFor: () => "Microsoft Raul",
		async speak() {
			failures.push("attempt");
			throw Object.assign(new Error("no voice"), { code: "no-voice" });
		},
	});
	const h = harness({ voice: true, engine, installed: true });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Listo, ya está.");
	await until(() => h.events.some((entry) => entry.event === "reading.end"));
	const retry = h.events.find((entry) => entry.event === "reading.retry")!;
	assert.deepEqual([retry.voice, retry.failure, retry.attempt], ["Microsoft Raul", "no-voice", 1], "the log says why the reply was read again");
	const end = h.events.find((entry) => entry.event === "reading.end")!;
	assert.equal(end.outcome, "error");
	assert.equal(end.voice, "Microsoft Raul");
	assert.equal(end.failure, "no-voice", "the log records the failure code, not the error class");
	assert.equal(failures.length, 2, "the voice is retried once and no other voice reads the reply");
	assert.equal(speechEvents(pi).filter((event) => event.phase === "end").length, 1);
});

// --- speech events (S2-S5) ------------------------------------------------------

// The reply-reading contract a consumer subscriptions to: one channel, one
// schema, one start before the reading, one chunk per chunk the player begins,
// one end per start.
const VOICE_SPEECH_CHANNEL = "gentle-ai:voice-speech";
const VOICE_SPEECH_SCHEMA = "gentle-pi.voice-speech/v1";

const speechEvents = (pi: ReturnType<typeof fakePi>) =>
	pi.emitted.filter((event) => event.channel === VOICE_SPEECH_CHANNEL).map((event) => event.data as Record<string, unknown>);

class FakeSpeechChild extends EventEmitter {
	readonly written: string[] = [];
	stdin = { write: (chunk: string) => { this.written.push(chunk); return true; }, end: () => {}, on: () => {} };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill() {
		return true;
	}
}

test("a reading publishes start before it speaks, its played chunks, and one end after it settles", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	assert.deepEqual(speechEvents(pi), [{ schema: VOICE_SPEECH_SCHEMA, phase: "start", engine: "fake" }], "started before the engine was asked to speak");
	readings[0]!.options.onChunk!({ frameMs: 50, durationMs: 300, levels: [1, 0.4] });
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "chunk", engine: "fake", frameMs: 50, durationMs: 300, levels: [1, 0.4] });
	readings[0]!.finish("done");
	await until(() => speechEvents(pi).length === 3);
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "fake", outcome: "done" });
	await tick();
	assert.equal(speechEvents(pi).length, 3, "exactly one end per start");
});

test("a played chunk goes to the event bus unchanged and to the listener's wave, in that order", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	readings[0]!.options.onChunk!({ frameMs: 50, durationMs: 300, levels: [1, 0.4] });
	assert.deepEqual(
		speechEvents(pi),
		[
			{ schema: VOICE_SPEECH_SCHEMA, phase: "start", engine: "fake" },
			{ schema: VOICE_SPEECH_SCHEMA, phase: "chunk", engine: "fake", frameMs: 50, durationMs: 300, levels: [1, 0.4] },
		],
		"the published payload is exactly the one it was before the listener saw it",
	);
	assert.deepEqual(h.turn.levels, [{ frameMs: 50, durationMs: 300, levels: [1, 0.4] }], "the same loudness, tapped for the overlay");
	readings[0]!.finish("done");
	await until(() => speechEvents(pi).length === 3);
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "fake", outcome: "done" });
});

test("a reading whose turn carries no listener still publishes its chunks and sends nothing", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	// The turn a session gets when the listener is unreachable: a plain release.
	h.deps.readingTurn = async () => () => { h.turn.released += 1; };
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	assert.doesNotThrow(() => readings[0]!.options.onChunk!({ frameMs: 50, durationMs: 100, levels: [0.2] }));
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "chunk", engine: "fake", frameMs: 50, durationMs: 100, levels: [0.2] });
	assert.deepEqual(h.turn.levels, [], "there is no listener route to send it to");
	readings[0]!.finish("done");
	await until(() => speechEvents(pi).some((event) => event.phase === "end"));
	assert.equal(h.turn.released, 1);
});

test("Esc and Stop reading each end the reading once, with the outcome the log records", async () => {
	for (const how of ["esc", "stop"] as const) {
		const { engine, readings } = fakeEngine();
		const h = harness({ voice: true, engine });
		const pi = register(h);
		const ui = fakeContext({ select: pick(/^Stop reading$/) });
		await pi.fire("session_start", ui.ctx);
		await settleReply(pi, ui.ctx, "Respuesta.");
		await until(() => readings.length === 1);
		await until(() => speechEvents(pi).some((event) => event.phase === "start"));
		if (how === "esc") ui.type(ESC);
		else await run(pi, ui);
		await until(() => speechEvents(pi).some((event) => event.phase === "end"));
		await tick();
		const outcome = how === "esc" ? "skipped" : "cancelled";
		assert.deepEqual(speechEvents(pi).filter((event) => event.phase === "end"), [{ schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "fake", outcome }], how);
		assert.equal(speechEvents(pi).filter((event) => event.phase === "start").length, 1, how);
		assert.equal(speechEvents(pi).filter((event) => event.phase === "chunk").length, 0, how);
		assert.equal(h.events.find((entry) => entry.event === "reading.end")!.outcome, outcome, how);
	}
});

test("a failed reading ends the event once with an error outcome", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Esto va a fallar.");
	await until(() => readings.length === 1);
	readings[0]!.fail(new SpeechEngineError("failed"));
	await until(() => ui.notices.length === 1);
	await until(() => speechEvents(pi).some((event) => event.phase === "end"));
	await tick();
	const ends = speechEvents(pi).filter((event) => event.phase === "end");
	assert.deepEqual(ends, [{ schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "fake", outcome: "error" }]);
	assert.equal(ui.notices.length, 1, "the failure is still reported once");
});

test("the Windows voice publishes only start and end, because the reply never reaches Node as audio", async () => {
	const child = new FakeSpeechChild();
	const engine = createWindowsSpeechEngine({ command: "/p/powershell.exe", spawn: () => child });
	const h = harness({ voice: true, engine });
	const pi = register(h);
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => speechEvents(pi).length === 1);
	assert.deepEqual(speechEvents(pi), [{ schema: VOICE_SPEECH_SCHEMA, phase: "start", engine: "windows" }]);
	child.emit("exit", 0, null);
	await until(() => speechEvents(pi).length === 2);
	assert.deepEqual(speechEvents(pi).at(-1), { schema: VOICE_SPEECH_SCHEMA, phase: "end", engine: "windows", outcome: "done" });
	assert.equal(speechEvents(pi).some((event) => event.phase === "chunk"), false, "a voice with no audio in Node reports no loudness");
});

test("an event listener that throws never stops the reading", async () => {
	const { engine, readings } = fakeEngine();
	const h = harness({ voice: true, engine });
	const pi = register(h);
	(pi.pi as unknown as { events: { emit(channel: string, data: unknown): void } }).events.emit = () => { throw new Error("listener failed"); };
	const ui = fakeContext();
	await pi.fire("session_start", ui.ctx);
	await settleReply(pi, ui.ctx, "Respuesta.");
	await until(() => readings.length === 1);
	assert.doesNotThrow(() => readings[0]!.options.onChunk!({ frameMs: 50, durationMs: 100, levels: [1] }));
	readings[0]!.finish("done");
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(ui.notices.length, 0, "the reading settles normally");
});
