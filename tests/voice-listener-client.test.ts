import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createSessionListenerLink, cutListenerReading, ensureListener, LISTENER_DICTATE_TIMEOUT_MS, ListenerDeliveryError, listenerReadingTurn, sessionDisplayLabel, SESSION_LABEL_MAX, VoiceListenerClient, type ListenerSession, type SessionDictation } from "../lib/voice-listener-client.ts";
import { VoiceSessionError, type VoiceSessionErrorCode, type VoiceSessionState } from "../lib/voice-session.ts";
import type { VoiceOverlay } from "../lib/voice-overlay.ts";
import { listenerPaths, readListenerLock, takeListenerLock, VoiceListener, type ListenerDictation, type ListenerDictationRequest } from "../lib/voice-listener.ts";
import { encodeListenerFrame, type ListenerFrame } from "../lib/voice-listener-protocol.ts";

// The session side of the one voice listener (S6, slice A): join the running
// listener, start it once when it is not there, survive a stale socket or a
// dead locker, and reconnect after a restart. Every socket is bound in a
// scratch voice home in the system temporary directory, except one test that runs the real
// scripts/voice-listener.mjs entry point; every child is stopped before the
// test ends and the real ~/.pi/gentle-ai/voice is never touched.

const dirs: string[] = [];
const children: ChildProcess[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "voice-client-"));
	dirs.push(dir);
	return dir;
};
after(() => {
	for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

// A listener that was killed with SIGKILL leaves its socket behind: the path
// exists, it is a socket, and nobody accepts on it.
async function leaveStaleSocket(path: string): Promise<void> {
	const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => console.log('bound'))", path], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("exit", () => reject(new Error("the socket helper exited before binding")));
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
	assert.equal(lstatSync(path).isSocket(), true, "the killed listener left its socket");
}

const session = (sessionId: string, voiceOn = true, paneId = "w1:p1") => ({ sessionId, paneId, voiceOn });

test("two sessions starting at once get one listener and both join it", async () => {
	const dir = scratch();
	let starts = 0;
	let server: VoiceListener | undefined;
	const start = async () => {
		starts += 1;
		server = new VoiceListener({ dir });
		await server.listen();
	};
	const [first, second] = await Promise.all([
		ensureListener({ dir, session: session("s-1"), start }),
		ensureListener({ dir, session: session("s-2"), start }),
	]);
	assert.equal(starts, 1, "the second session joins instead of starting a microphone owner");
	assert.equal(first.client.connected, true);
	assert.equal(second.client.connected, true);
	assert.equal(server?.clientCount, 2);
	first.client.close();
	second.client.close();
	await server?.close();
});

test("a stale socket from a killed listener is cleared and a fresh one started", async () => {
	const dir = scratch();
	await leaveStaleSocket(listenerPaths(dir).socket);
	let starts = 0;
	let server: VoiceListener | undefined;
	const { client, started } = await ensureListener({
		dir,
		session: session("s-1"),
		start: async () => {
			starts += 1;
			server = new VoiceListener({ dir });
			await server.listen();
		},
	});
	assert.equal(started, true);
	assert.equal(starts, 1);
	assert.equal(client.connected, true);
	client.close();
	await server?.close();
});

test("a regular file where the socket belongs is refused and left alone", async () => {
	const dir = scratch();
	mkdirSync(dir, { recursive: true });
	writeFileSync(listenerPaths(dir).socket, "not a socket");
	let starts = 0;
	await assert.rejects(
		ensureListener({ dir, session: session("s-1"), start: () => { starts += 1; } }),
		/unsafe_path/,
	);
	assert.equal(starts, 0, "nothing is spawned on an unsafe path");
	assert.equal(readFileSync(listenerPaths(dir).socket, "utf8"), "not a socket");
});

test("a lock held by a live session is waited on and never removed", async () => {
	const dir = scratch();
	takeListenerLock(listenerPaths(dir), { pid: process.pid, socket: listenerPaths(dir).socket });
	let starts = 0;
	await assert.rejects(
		ensureListener({ dir, session: session("s-1"), start: () => { starts += 1; }, waitMs: 80 }),
		/voice_listener_busy/,
	);
	assert.equal(starts, 0);
	assert.equal(readListenerLock(listenerPaths(dir))?.pid, process.pid);
});

test("a lock left by a dead process does not stop voice", async () => {
	const dir = scratch();
	takeListenerLock(listenerPaths(dir), { pid: 999_999, now: 0 });
	let server: VoiceListener | undefined;
	const { client, started } = await ensureListener({
		dir,
		session: session("s-1"),
		start: async () => {
			server = new VoiceListener({ dir });
			await server.listen();
		},
	});
	assert.equal(started, true, "a dead locker costs one retry, never a stuck voice");
	assert.equal(client.connected, true);
	client.close();
	await server?.close();
});

test("the client asks, hears the events and gets a bye when the listener stops", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir });
	await server.listen();
	const client = new VoiceListenerClient({ dir, session: session("s-1") });
	const frames: ListenerFrame[] = [];
	client.onFrame((frame) => frames.push(frame));
	assert.equal(await client.connect(), "asleep", "hello answers with the current state");
	const snapshot = await client.request({ type: "status" });
	assert.equal(snapshot.type, "snapshot");
	assert.deepEqual((snapshot as { sessions: string[] }).sessions, ["s-1"]);
	await client.request({ type: "wake" });
	await waitFor(() => frames.some((frame) => frame.type === "state" && frame.state === "listening"));
	await server.close();
	await waitFor(() => frames.some((frame) => frame.type === "bye"));
	await waitFor(() => !client.connected);
	client.close();
});

test("the client reconnects with backoff and keeps its session id", async () => {
	const dir = scratch();
	let server = new VoiceListener({ dir });
	await server.listen();
	const client = new VoiceListenerClient({ dir, session: session("s-1"), backoffMs: [10] });
	await client.connect();
	await server.close();
	await waitFor(() => !client.connected);
	server = new VoiceListener({ dir });
	await server.listen();
	await waitFor(() => client.connected);
	const snapshot = await client.request({ type: "status" });
	assert.equal(snapshot.type, "snapshot");
	assert.deepEqual((snapshot as { sessions: string[] }).sessions, ["s-1"], "the registry keeps the session across a client restart");
	client.close();
	await server.close();
});

test("the real entry point owns the socket and the lock and cleans both up on shutdown", async () => {
	const home = scratch();
	const dir = join(home, "voice");
	const script = join(import.meta.dirname, "..", "scripts", "voice-listener.mjs");
	assert.ok(existsSync(script));
	const { client, started } = await ensureListener({
		dir,
		session: session("s-1"),
		start: () => {
			const child = spawn(process.execPath, ["--experimental-strip-types", script], {
				env: { ...process.env, GENTLE_PI_CONFIG_HOME: home },
				stdio: "ignore",
			});
			children.push(child);
		},
	});
	assert.equal(started, true);
	const snapshot = (await client.request({ type: "status" })) as { listenerPid: number };
	assert.notEqual(snapshot.listenerPid, process.pid, "the daemon is its own process");
	assert.equal(readListenerLock(listenerPaths(dir))?.pid, snapshot.listenerPid);
	const child = children.at(-1)!;
	const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
	child.kill("SIGTERM");
	assert.equal(await exited, 0);
	await waitFor(() => !existsSync(listenerPaths(dir).socket), 3_000);
	assert.equal(existsSync(listenerPaths(dir).lock), false);
	client.close();
});

// --- the reading turn through the listener (slice B) -------------------------

test("a session reads through the listener, another waits for the turn, and a cut reaches the reader", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir, readTailMs: 5 });
	await server.listen();
	const cuts: string[] = [];
	const reading = await listenerReadingTurn({
		dir,
		session: session("s-1"),
		chars: 40,
		signal: new AbortController().signal,
		onCut: (reason) => cuts.push(reason),
	});
	assert.ok(reading && reading.kind === "granted", "the free turn is granted");
	assert.equal(server.readingSession, "s-1");

	// The second session waits for the turn instead of failing: it is granted
	// once the first one ends.
	const waiting = listenerReadingTurn({ dir, session: session("s-2"), chars: 5, signal: new AbortController().signal, pollMs: 5, maxWaitMs: 2_000 });
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(await cutListenerReading({ dir, session: session("s-3") }), true, "any session can cut what is speaking");
	assert.deepEqual(cuts, ["cut"], "the reader is told to stop");
	await waitFor(() => server.readingSession !== "s-1", 1_000);
	const granted = await waiting;
	assert.ok(granted && granted.kind === "granted");
	granted.release("skipped");
	reading.release("done");
	await server.close();
});

test("the reading turn sends the played loudness to the listener and survives a chunk the wire would refuse", async () => {
	const dir = scratch();
	const levels: number[] = [];
	const states: string[] = [];
	const overlay: VoiceOverlay = {
		show: (snapshot) => {
			states.push(snapshot.state);
		},
		level: (value) => {
			levels.push(value);
		},
		dispose: () => {},
	};
	const server = new VoiceListener({ dir, overlay, readTailMs: 5 });
	await server.listen();
	const reading = await listenerReadingTurn({ dir, session: session("s-1"), chars: 20, signal: new AbortController().signal });
	assert.ok(reading && reading.kind === "granted", "the free turn is granted");
	assert.deepEqual(states, ["listening", "reading"], "the voice-on hello wakes the listener before the overlay draws the reading");

	reading.levels({ frameMs: 50, durationMs: 200, levels: [0.25, 0.5, 0.75] });
	await waitFor(() => levels.length === 3, 2_000);
	assert.deepEqual(levels, [0.25, 0.5, 0.75], "the loudness reaches the overlay as it is");

	// The wire refuses a malformed frame by closing the connection, so the client
	// sanitizes instead: the reading never dies over a value it cannot draw.
	reading.levels({ frameMs: 0, durationMs: 0, levels: [Number.NaN, -1, 4] });
	await waitFor(() => levels.length === 6, 2_000);
	assert.deepEqual(levels.slice(3), [0, 0, 1], "a value the meter cannot draw is silence");
	assert.equal(server.readingSession, "s-1", "the turn is still held after the malformed chunk");

	reading.release("done");
	await waitFor(() => server.readingSession === undefined, 2_000);
	reading.levels({ frameMs: 50, durationMs: 50, levels: [1] });
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(levels.length, 6, "a released reading sends nothing");
	await server.close();
});

test("the listener's voice frames reach the session, and only a wake says it was one (S7, L10)", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir });
	await server.listen();
	const heard: Array<[string, boolean]> = [];
	const link = createSessionListenerLink({ dir, session: () => session("s-1"), onVoice: (command, wake) => heard.push([command, wake]) });
	assert.equal(await link.ensure(), true);
	// Another session turns its own voice on: the listener tells every session, and
	// none of them starts listening for it.
	const other = new VoiceListenerClient({ dir, session: session("s-2", false, "w1:p2") });
	await other.connect();
	await other.request({ type: "set-voice", voiceOn: true });
	await waitFor(() => heard.length === 1);
	assert.deepEqual(heard, [["voice-on", false]], "a plain voice on is not a wake");
	// Voice off reaches every session too.
	await other.request({ type: "set-voice", voiceOn: false });
	await waitFor(() => heard.length === 2);
	assert.deepEqual(heard.at(-1), ["voice-off", false], "voice off is the other frame a session acts on");
	other.close();
	link.close();
	await server.close();
});

test("a connection the listener replaced never reconnects to evict its replacement (S6)", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir });
	await server.listen();
	const stale = new VoiceListenerClient({ dir, session: session("s-1") });
	await stale.connect();
	const fresh = new VoiceListenerClient({ dir, session: session("s-1") });
	await fresh.connect();
	await waitFor(() => server.clientCount === 1, 2_000);
	// A reload keeps the same session id, and the connection it left behind came
	// back on its own every 250 ms to evict the one that replaced it, for ever.
	await new Promise((resolve) => setTimeout(resolve, 800));
	assert.equal(server.clientCount, 1, "the replaced connection stayed gone");
	await assert.rejects(stale.request({ type: "status" }), "and it refuses to come back");
	await assert.rejects(stale.connect());
	assert.equal(server.clientCount, 1, "the session keeps the one connection it has");
	fresh.close();
	await server.close();
});

test("a reading held on its own connection survives the session's connection joining and reconnecting (S6)", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir, readTailMs: 5 });
	await server.listen();
	const cuts: string[] = [];
	const reading = await listenerReadingTurn({ dir, session: session("s-1"), chars: 20, signal: new AbortController().signal, onCut: (reason) => cuts.push(reason) });
	assert.ok(reading && reading.kind === "granted", "the free turn is granted");
	// The session's own, long-lived connection: the one that carries captures, the
	// wake and the voice frames. It joins while the reply is being read, and each
	// hello used to evict the reading's connection, which released the reading.
	const link = createSessionListenerLink({ dir, session: () => session("s-1") });
	assert.equal(await link.ensure(), true, "the session joins while its reply is read");
	await waitFor(() => server.clientCount === 2, 2_000);
	assert.deepEqual(cuts, [], "the reading is not released by the hello of its own session");
	assert.equal(server.readingSession, "s-1", "the turn is still held");

	// A reconnect, as after a listener restart: still one reading, no churn.
	link.close();
	await waitFor(() => server.clientCount === 1, 2_000);
	assert.equal(await link.ensure(), true);
	await waitFor(() => server.clientCount === 2, 2_000);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.deepEqual(cuts, [], "and it survives the reconnect");
	assert.equal(server.readingSession, "s-1");

	reading.release("done");
	await waitFor(() => server.readingSession === undefined, 2_000);
	link.close();
	await server.close();
});

test("a listener that cannot be reached reports itself unavailable instead of failing", async () => {
	const dir = scratch();
	const turn = await listenerReadingTurn({
		dir,
		session: session("s-1"),
		signal: new AbortController().signal,
		start: () => {
			throw new Error("the listener could not start");
		},
		waitMs: 60,
	});
	assert.deepEqual(turn, { kind: "unavailable" }, "the session falls back to its own turn");
});

test("a cut on a listener that is not running does nothing and starts nothing", async () => {
	const dir = scratch();
	assert.equal(await cutListenerReading({ dir, session: session("s-1") }), false);
	assert.equal(existsSync(listenerPaths(dir).lock), false, "a cut never spawns a listener");
});

// --- capture through the listener (slice C) ----------------------------------

// The same fake worker the listener tests use: recording, transcribing, finished.
function fakeCapture(options: { text?: string; error?: VoiceSessionErrorCode; delayMs?: number } = {}) {
	const calls: string[] = [];
	const factory = (request: ListenerDictationRequest): ListenerDictation => {
		const notify = request.onStateChange;
		return {
			start: async () => {
				calls.push("start");
				if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
				notify("recording");
			},
			stop: async () => {
				calls.push("stop");
				notify("transcribing");
				notify("finished");
				if (options.error) throw new VoiceSessionError(options.error);
				return { text: options.text ?? "hola", truncated: false };
			},
			cancel: async () => {
				calls.push("cancel");
				notify("finished");
			},
		};
	};
	return { calls, factory };
}

const focusedOn = (paneId: string) => ({ focusedPaneId: async () => ({ focused: paneId }) });
// The session's own capture, used when the listener cannot be reached.
const localCapture = () => {
	const calls: string[] = [];
	const dictation: SessionDictation = {
		state: "idle",
		owner: "session",
		start: async () => { calls.push("start"); },
		stop: async () => ({ text: "local", truncated: false }),
		cancel: async () => { calls.push("cancel"); },
	};
	return { calls, dictation };
};

test("a session dictates through the listener and reads its own transcript back", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "hola mundo" });
	const server = new VoiceListener({ dir, dictation: capture.factory, focus: focusedOn("w1:p1") });
	await server.listen();
	const link = createSessionListenerLink({ dir, session: () => session("s-1") });
	const states: VoiceSessionState[] = [];
	const dictation = link.dictate({ mode: "conversation", onStateChange: (state) => states.push(state), fallback: () => assert.fail("the listener is reachable") });
	await dictation.start();
	assert.equal(dictation.owner, "listener", "the listener owns the microphone, so it owns the cues");
	dictation.stop();
	assert.deepEqual(await dictation.stop(), { text: "hola mundo", truncated: false });
	assert.deepEqual(states, ["starting", "recording", "transcribing", "finished"]);
	assert.deepEqual(capture.calls, ["start", "stop"]);
	link.close();
	await server.close();
});

for (const outcome of ["resolve", "reject"] as const) test(`closing a pending startup probe prevents a late ${outcome} from replacing a new session`, async () => {
	const dir = scratch();
	const hellos: string[] = [];
	const server = new VoiceListener({ dir, log: (event, fields) => { if (event === "listener.hello") hellos.push(String(fields?.sessionId)); } });
	await server.listen();
	let release!: (value: boolean) => void;
	let reject!: (reason: Error) => void;
	let probed = false;
	const probe = new Promise<boolean>((resolve, fail) => { release = resolve; reject = fail; });
	probe.catch(() => {});
	const old = createSessionListenerLink({ dir, session: () => session("s-1"), probe: () => { probed = true; return probe; } });
	const joining = old.ensure();
	await new Promise((resolve) => setTimeout(resolve, 10));
	old.close();
	const beforeRelease = await Promise.race([joining, new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 80))]);
	const fresh = createSessionListenerLink({ dir, session: () => session("s-1") });
	try {
		assert.equal(await fresh.ensure(), true);
		if (outcome === "resolve") release(true);
		else reject(new Error("late probe failure"));
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.equal(probed, true, "the first join used the pending probe");
		assert.equal(beforeRelease, false, "close settles ensure before the probe answers");
		assert.equal(await joining, false);
		assert.deepEqual(hellos, ["s-1"], "the old probe sends no hello and cannot evict the replacement");
		assert.equal(server.clientCount, 1);
		assert.equal(await fresh.ensure(), true);
	} finally {
		fresh.close();
		old.close();
		await server.close();
	}
});

test("dictation reuses an in-flight startup join and sends exactly one hello", async () => {
	const dir = scratch();
	const capture = fakeCapture();
	const hellos: string[] = [];
	const server = new VoiceListener({ dir, dictation: capture.factory, focus: focusedOn("w1:p1"), log: (event, fields) => { if (event === "listener.hello") hellos.push(String(fields?.sessionId)); } });
	let release!: () => void;
	let starts = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const link = createSessionListenerLink({ dir, session: () => session("s-1"), start: async () => { starts++; await gate; }, waitMs: 1_000 });
	const joining = link.ensure();
	await waitFor(() => starts === 1);
	const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => assert.fail("the listener is reachable") });
	const recording = dictation.start();
	try {
		await server.listen();
		release();
		assert.equal(await joining, true);
		await recording;
		assert.deepEqual(hellos, ["s-1"]);
		assert.equal(starts, 1);
		assert.deepEqual(capture.calls, ["start"]);
		assert.deepEqual(await dictation.stop(), { text: "hola", truncated: false });
	} finally {
		link.close();
		await server.close();
	}
});

test("cancelling dictation during startup never opens a capture when the listener arrives", async () => {
	const dir = scratch();
	const capture = fakeCapture();
	const server = new VoiceListener({ dir, dictation: capture.factory, focus: focusedOn("w1:p1") });
	let release!: () => void;
	let starts = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const received: string[] = [];
	const link = createSessionListenerLink({ dir, session: () => session("s-1"), start: async () => { starts++; await gate; }, waitMs: 1_000, onTranscript: (text) => received.push(text) });
	const own = localCapture();
	const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => own.dictation });
	const recording = dictation.start();
	await waitFor(() => starts === 1);
	await dictation.cancel();
	try {
		await server.listen();
		release();
		await recording;
		assert.deepEqual(capture.calls, [], "the listener never opens the microphone");
		assert.deepEqual(own.calls, [], "the local fallback never opens the microphone");
		await server.deliverTranscript("from another session");
		await waitFor(() => received.length === 1, 200);
		assert.deepEqual(received, ["from another session"], "the cancelled start leaves no handler swallowing later transcripts");
	} finally {
		link.close();
		await server.close();
	}
});

test("a session with no listener keeps its own capture instead of losing voice", async () => {
	const dir = scratch();
	const link = createSessionListenerLink({ dir, session: () => session("s-1"), start: () => { throw new Error("the listener could not start"); }, waitMs: 50 });
	const own = localCapture();
	const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => own.dictation });
	await dictation.start();
	assert.equal(dictation.owner, "session", "the session plays its own cues again");
	assert.deepEqual(own.calls, ["start"], "the fallback records in the session as it did before");
	assert.equal(await link.ensure(), false);
	link.close();
});

test("a transcript that went to the focused session is reported instead of waited on", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir, dictation: fakeCapture({ text: "para el otro" }).factory, focus: focusedOn("w1:p2") });
	await server.listen();
	const received: Array<[string, boolean]> = [];
	const asker = createSessionListenerLink({ dir, session: () => session("s-1") });
	await asker.ensure();
	const focused = createSessionListenerLink({ dir, session: () => session("s-2", true, "w1:p2"), onTranscript: (text, truncated) => received.push([text, truncated]) });
	assert.equal(await focused.ensure(), true);
	const dictation = asker.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("the listener is reachable") });
	await dictation.start();
	dictation.stop();
	await assert.rejects(dictation.stop(), (error: unknown) => error instanceof ListenerDeliveryError && error.kind === "elsewhere");
	await waitFor(() => received.length === 1);
	assert.deepEqual(received, [["para el otro", false]], "the focused session receives what the other one recorded");
	asker.close();
	focused.close();
	await server.close();
});

test("a capture refused because another one is running fails the start instead of opening a second microphone", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir, dictation: fakeCapture({ text: "uno" }).factory, focus: focusedOn("w1:p1") });
	await server.listen();
	const first = createSessionListenerLink({ dir, session: () => session("s-1") });
	await first.ensure();
	const second = createSessionListenerLink({ dir, session: () => session("s-2", true, "w1:p2") });
	const recording = first.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("no fallback") });
	await recording.start();
	const refused = second.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("no second microphone") });
	await assert.rejects(refused.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
	recording.stop();
	await recording.stop();
	first.close();
	second.close();
	await server.close();
});

test("a session whose dictate was refused still receives the transcript the focus sends it", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir, dictation: fakeCapture({ text: "para el enfocado" }).factory, focus: focusedOn("w1:p2") });
	await server.listen();
	const asker = createSessionListenerLink({ dir, session: () => session("s-1", true, "w1:p1") });
	assert.equal(await asker.ensure(), true);
	const received: string[] = [];
	const focused = createSessionListenerLink({ dir, session: () => session("s-2", true, "w1:p2"), onTranscript: (text) => received.push(text) });
	assert.equal(await focused.ensure(), true);
	const recording = asker.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("the listener is reachable") });
	await recording.start();
	const refused = focused.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("no second microphone") });
	await assert.rejects(refused.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
	recording.stop();
	await assert.rejects(recording.stop(), (error: unknown) => error instanceof ListenerDeliveryError && error.kind === "elsewhere");
	await waitFor(() => received.length === 1);
	assert.deepEqual(received, ["para el enfocado"], "a refused start left no handler swallowing the focused transcript");
	asker.close();
	focused.close();
	await server.close();
});

test("a slow capture start never opens a second microphone in the session", async () => {
	assert.ok(LISTENER_DICTATE_TIMEOUT_MS >= 30_000, "a cold worker start fits inside the production dictate wait");
	const dir = scratch();
	const capture = fakeCapture({ text: "tarde", delayMs: 120 });
	const server = new VoiceListener({ dir, dictation: capture.factory, focus: focusedOn("w1:p1") });
	await server.listen();
	const link = createSessionListenerLink({ dir, session: () => session("s-1"), dictateTimeoutMs: 20 });
	const own = localCapture();
	const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => own.dictation });
	await assert.rejects(dictation.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "timeout");
	assert.deepEqual(own.calls, [], "a listener that may still own the capture is never duplicated");
	await waitFor(() => capture.calls.includes("cancel"));
	assert.deepEqual(capture.calls, ["start", "cancel"], "the listener is asked to let the capture go");
	link.close();
	await server.close();
});

test("a listener with no worker leaves the capture to the session", async () => {
	const dir = scratch();
	const server = new VoiceListener({ dir });
	await server.listen();
	const link = createSessionListenerLink({ dir, session: () => session("s-1") });
	const own = localCapture();
	const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => own.dictation });
	await dictation.start();
	assert.deepEqual([dictation.owner, ...own.calls], ["session", "start"], "an unsupported platform records in the session as before");
	link.close();
	await server.close();
});

// --- the session display label (T4, S5) -----------------------------------------------

test("a session label is the session name, or the working directory's, sanitized and short", () => {
	assert.equal(sessionDisplayLabel({ name: "voice work" }), "voice work");
	assert.equal(sessionDisplayLabel({ name: "  ", cwd: "/home/someone/proyectos/gentle-shell" }), "gentle-shell", "no name: the directory's");
	assert.equal(sessionDisplayLabel({ cwd: "/home/someone/proyectos/gentle-shell/" }), "gentle-shell", "a trailing separator is not a segment");
	assert.equal(sessionDisplayLabel({ cwd: "C:\\Users\\someone\\repo" }), "repo", "a Windows path keeps its last segment");
	assert.equal(sessionDisplayLabel({ name: "repo\u0007\u001b[31m title" }), "repo title", "control characters and escapes never reach a window");
	assert.equal(sessionDisplayLabel({ name: "  many   spaces  " }), "many spaces", "whitespace collapses");
	assert.equal(sessionDisplayLabel({}), undefined, "nothing to show");
	assert.equal(sessionDisplayLabel({ cwd: "///" }), undefined, "a path without a segment is nothing");
	const long = sessionDisplayLabel({ name: "x".repeat(500) });
	assert.equal(long?.length, SESSION_LABEL_MAX);
	assert.ok(SESSION_LABEL_MAX <= 256, "well inside the protocol's field bound");
});

test("the hello carries the display label the session sends", async () => {
	const written: Array<Record<string, unknown>> = [];
	class FakeSocket extends EventEmitter {
		destroyed = false;
		setEncoding() {}
		on(event: string, listener: (...args: unknown[]) => void) {
			return super.on(event, listener);
		}
		write(chunk: string) {
			const request = JSON.parse(chunk) as Record<string, unknown>;
			written.push(request);
			queueMicrotask(() => super.emit("data", encodeListenerFrame({ type: "welcome", id: request.id as string, listenerPid: 1, proto: 1, state: "asleep" })));
			return true;
		}
		destroy() {
			this.destroyed = true;
			return this;
		}
	}
	const socket = new FakeSocket();
	const session: ListenerSession = { sessionId: "s-1", paneId: "w1:p1", label: "gentle-shell", voiceOn: true };
	const client = new VoiceListenerClient({ dir: scratch(), session, dial: () => socket as unknown as Socket });
	queueMicrotask(() => socket.emit("connect"));
	assert.equal(await client.connect(), "asleep");
	assert.equal(written[0]!.type, "hello");
	assert.equal(written[0]!.label, "gentle-shell");
	client.close();
});
