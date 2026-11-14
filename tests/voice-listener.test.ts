import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after } from "node:test";
import {
	buildVoiceKeywordOption,
	createHerdrFocus,
	listenerLockStale,
	listenerPaths,
	parseHerdrAgents,
	readListenerLock,
	refreshListenerLock,
	releaseListenerLock,
	takeListenerLock,
	VoiceListener,
	type ListenerDictation,
	type ListenerDictationRequest,
	type ListenerFocus,
	type ListenerSpotFactory,
} from "../lib/voice-listener.ts";
import { KWS_MODEL_MANIFEST, KWS_SPOTTER_FILES } from "../lib/voice-artifacts.ts";
import { encodeListenerFrame, parseListenerFrameLine, VOICE_LISTENER_SCHEMA, type ListenerFrame, type ListenerLanguage, type ListenerRequest, type ListenerState } from "../lib/voice-listener-protocol.ts";
import type { CuePlayer } from "../lib/voice-cues.ts";
import type { VoiceOverlay, VoiceOverlaySnapshot } from "../lib/voice-overlay.ts";
import { VOICE_WORKER_SCHEMA, VoiceSessionError, type VoiceKeywordOption, type VoiceSessionErrorCode, type VoiceSessionState } from "../lib/voice-session.ts";
import { createWarmVoiceWorker } from "../lib/voice-warm.ts";

// One voice listener for every Pi session (S6, slice A): the single-instance
// lock, the unix-socket registry, the state edges, focus resolution and the
// rule that a transcript reaches the focused session only. Every socket lives
// in a scratch voice home under the system temp directory; the real voice home
// is never touched and no microphone is opened in this slice.

const scratchRoot = tmpdir();
const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-listener-"));
	dirs.push(dir);
	return dir;
};
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Client {
	socket: Socket;
	frames: ListenerFrame[];
	closed: Promise<void>;
	send(request: ListenerRequest): void;
	hello(sessionId: string, paneId?: string, voiceOn?: boolean, role?: "session" | "reading"): void;
}

async function connectClient(dir: string): Promise<Client> {
	const socket = createConnection(listenerPaths(dir).socket);
	const frames: ListenerFrame[] = [];
	let buffered = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffered += chunk;
		let newline: number;
		while ((newline = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, newline);
			buffered = buffered.slice(newline + 1);
			const frame = parseListenerFrameLine(line);
			assert.ok(frame, `a listener frame parses: ${line}`);
			frames.push(frame);
		}
	});
	const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => resolve());
		socket.once("error", reject);
	});
	const send = (request: ListenerRequest) => socket.write(encodeListenerFrame(request));
	return {
		socket,
		frames,
		closed,
		send,
		hello: (sessionId, paneId?, voiceOn = true, role?) => send({ type: "hello", proto: 1, sessionId, paneId, voiceOn, ...(role === undefined ? {} : { role }) }),
	};
}

const framesOf = (client: Client, type: ListenerFrame["type"]) => client.frames.filter((frame) => frame.type === type);

// The one frame matching a predicate, waited for: every reading request carries
// its own id, so a predicate never picks up the answer to an older request.
async function awaitFrame(client: Client, match: (frame: ListenerFrame) => boolean, ms = 2_000): Promise<ListenerFrame> {
	const deadline = Date.now() + ms;
	for (;;) {
		const found = client.frames.find(match);
		if (found) return found;
		if (Date.now() > deadline) throw new Error("timed out waiting for a listener frame");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Started {
	listener: VoiceListener;
	events: Array<{ event: string; fields?: Record<string, unknown> }>;
	client(): Promise<Client>;
}

async function startListener(
	dir: string,
	options: {
		idleMs?: number;
		asleepIdleMs?: number;
		focus?: ListenerFocus;
		readLeaseMs?: number;
		readTailMs?: number;
		dictation?: (request: ListenerDictationRequest) => ListenerDictation;
		cues?: CuePlayer;
		now?: () => number;
		overlay?: VoiceOverlay;
		language?: ListenerLanguage;
		keyword?: VoiceKeywordOption;
		spot?: ListenerSpotFactory;
	} = {},
): Promise<Started> {
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const listener = new VoiceListener({
		dir,
		idleMs: options.idleMs ?? 60_000,
		asleepIdleMs: options.asleepIdleMs ?? 600_000,
		readLeaseMs: options.readLeaseMs,
		readTailMs: options.readTailMs,
		dictation: options.dictation,
		keyword: options.keyword,
		spot: options.spot,
		cues: options.cues,
		now: options.now,
		overlay: options.overlay,
		language: options.language,
		log: (event, fields) => events.push({ event, fields }),
		focus: options.focus ?? { focusedPaneId: async () => ({ focused: undefined }) },
	});
	await listener.listen();
	return { listener, events, client: () => connectClient(dir) };
}

test("the lock is taken exclusively, refreshed by its owner and released only by its owner", () => {
	const dir = scratch();
	const paths = listenerPaths(dir);
	const lock = takeListenerLock(paths, { pid: 101, now: 1_000, socket: paths.socket });
	assert.ok(lock);
	assert.deepEqual(readListenerLock(paths), lock, "the body is the lock");
	assert.equal(takeListenerLock(paths, { pid: 202, now: 1_000 }), undefined, "a second start gets the flag wx back as EEXIST");
	assert.equal(refreshListenerLock(paths, { pid: 202, now: 2_000 }), false, "only the owner refreshes");
	assert.equal(refreshListenerLock(paths, { pid: 101, now: 2_000 }), true);
	assert.equal(readListenerLock(paths)?.heartbeatAt, 2_000);
	assert.equal(releaseListenerLock(paths, { pid: 202 }), false, "only the owner removes");
	assert.ok(existsSync(paths.lock));
	assert.equal(releaseListenerLock(paths, { pid: 101 }), true);
	assert.equal(existsSync(paths.lock), false);
	assert.equal(readListenerLock(paths), undefined);
});

test("a lock whose process is gone or whose heartbeat stopped is recoverable", () => {
	const lock = { schema: "gentle-pi.voice-listener-lock/v1", pid: 101, socket: "/tmp/x.sock", startedAt: 0, heartbeatAt: 1_000, version: 1 as const };
	assert.equal(listenerLockStale(lock, { now: 1_500, isAlive: () => true }), false, "a live process with a fresh heartbeat keeps its lock");
	assert.equal(listenerLockStale(lock, { now: 1_500, isAlive: () => false }), true, "a dead process never blocks voice");
	assert.equal(listenerLockStale(lock, { now: 9_000, isAlive: () => true }), true, "a stopped heartbeat is stale");
	assert.equal(readListenerLock(listenerPaths(scratch())), undefined, "no lock reads as none");
});

test("two listeners in one voice home: the second refuses and the first keeps serving", async () => {
	const dir = scratch();
	const started = await startListener(dir);
	const client = await started.client();
	client.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(client, "welcome").length === 1);
	const intruder = new VoiceListener({ dir });
	await assert.rejects(intruder.listen(), (error: Error) => /voice_listener_busy|EADDRINUSE/.test(error.message), "one process owns the microphone");
	client.send({ type: "status" });
	await waitFor(() => framesOf(client, "snapshot").length === 1);
	client.socket.destroy();
	await started.listener.close();
});

test("the first frame must be hello, and a bad line gets one error and a close", async () => {
	const started = await startListener(scratch());
	const early = await started.client();
	early.send({ type: "status" });
	await waitFor(() => framesOf(early, "error").length === 1);
	assert.equal((framesOf(early, "error")[0] as { code: string }).code, "bad-hello");
	await early.closed;

	const broken = await started.client();
	broken.hello("s-2", "w1:p2");
	await new Promise((resolve) => setTimeout(resolve, 20));
	broken.socket.write("this is not a frame\n");
	await waitFor(() => framesOf(broken, "error").length === 1);
	assert.equal((framesOf(broken, "error")[0] as { code: string }).code, "bad-frame");
	await broken.closed;
	await started.listener.close();
});

test("two clients both hear every state edge, and status names the sessions", async () => {
	const started = await startListener(scratch());
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", false);
	second.hello("s-2", "w1:p2", false);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	assert.equal((framesOf(first, "welcome")[0] as { state: string }).state, "asleep");

	first.send({ type: "wake" });
	await waitFor(() => framesOf(first, "state").length === 1 && framesOf(second, "state").length === 1);
	assert.deepEqual(framesOf(second, "state").map((frame) => (frame as { state: string }).state), ["listening"]);
	assert.deepEqual(framesOf(first, "ok").map((frame) => (frame as { state: string }).state), ["listening"]);

	second.send({ type: "status" });
	await waitFor(() => framesOf(second, "snapshot").length === 1);
	assert.deepEqual(framesOf(second, "snapshot")[0], {
		type: "snapshot",
		state: "listening",
		listenerPid: process.pid,
		clients: 2,
		sessions: ["s-1", "s-2"],
	});
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a session's own voice on still turns voice on without starting a recording (S7, S11)", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "no" });
	const started = await startListener(dir, { dictation: capture.factory, cues: cuePlayer() });
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1);

	client.send({ type: "set-voice", id: "v1", voiceOn: true });
	await waitFor(() => framesOf(client, "ok").length === 1);
	// The frame a session already knew, with no wake flag: a menu or a set-voice
	// voice on never starts a conversation the owner did not ask for.
	assert.deepEqual(framesOf(client, "command"), [{ type: "command", command: "voice-on" }]);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(capture.calls, [], "no microphone was opened");
	assert.equal(started.events.some((entry) => entry.event === "capture.begin"), false);
	assert.deepEqual(cueLog(started.events), [], "and no cue claims a microphone it does not hold");
	client.socket.destroy();
	await started.listener.close();
});

test("voice off from one session turns voice off everywhere (L10)", async () => {
	const started = await startListener(scratch());
	const first = await started.client();
	const second = await started.client();
	second.hello("s-2", "w1:p2", false);
	await waitFor(() => framesOf(second, "welcome").length === 1);
	first.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	first.send({ type: "wake" });
	await waitFor(() => framesOf(second, "state").length === 1);

	second.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => framesOf(first, "command").length === 1 && framesOf(second, "command").length === 1);
	assert.deepEqual(framesOf(first, "command")[0], { type: "command", command: "voice-off" });
	await waitFor(() => framesOf(first, "state").length === 2);
	assert.deepEqual(framesOf(first, "state").map((frame) => (frame as { state: string }).state), ["listening", "asleep"]);
	assert.deepEqual(framesOf(second, "ok"), [{ type: "ok", request: "set-voice" }]);
	assert.deepEqual(framesOf(first, "ok"), [{ type: "ok", request: "wake", state: "listening" }]);
	assert.equal(started.listener.state, "asleep");
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a transcript goes only to the session whose pane is focused", async () => {
	const started = await startListener(scratch(), { focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) } });
	const first = await started.client();
	const second = await started.client();
	const third = await started.client();
	first.hello("s-1", "w1:p1");
	second.hello("s-2", "w1:p2");
	third.hello("s-3", "w1:p3");
	await waitFor(() => framesOf(third, "welcome").length === 1);

	assert.equal(await started.listener.deliverTranscript("hola"), "s-2");
	await waitFor(() => framesOf(second, "transcript").length === 1);
	assert.deepEqual(framesOf(second, "transcript"), [{ type: "transcript", text: "hola" }]);
	assert.deepEqual(framesOf(first, "transcript"), [], "nobody else receives it, not even the requester");
	assert.deepEqual(framesOf(third, "transcript"), []);
	for (const client of [first, second, third]) client.socket.destroy();
	await started.listener.close();
});

test("nobody focused: one registered session still gets it, more than one drops it", async () => {
	const dir = scratch();
	const started = await startListener(dir, { focus: { focusedPaneId: async () => ({ focused: undefined }) } });
	const single = await started.client();
	single.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(single, "welcome").length === 1);
	assert.equal(await started.listener.deliverTranscript("solo"), "s-1", "outside herdr the only session counts as focused");
	await waitFor(() => framesOf(single, "transcript").length === 1);

	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(second, "welcome").length === 1);
	assert.equal(await started.listener.deliverTranscript("nadie"), undefined, "the listener never broadcasts speech");
	assert.ok(started.events.some((entry) => entry.event === "transcript.undelivered"), "dropping a transcript is logged");
	assert.deepEqual(framesOf(single, "transcript").map((frame) => (frame as { text: string }).text), ["solo"]);
	single.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("herdr failing delivers nothing instead of guessing", async () => {
	const started = await startListener(scratch(), { focus: createHerdrFocus({ env: {}, run: async () => { throw new Error("herdr down"); } }) });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(first, "welcome").length === 1);
	assert.equal(await started.listener.deliverTranscript("hola"), undefined, "a failed lookup is not an unfocused one: the only session would be a guess");
	assert.deepEqual(framesOf(first, "transcript"), []);
	assert.ok(started.events.some((entry) => entry.event === "transcript.undelivered"), "a dropped transcript is logged");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(second, "welcome").length === 1);
	assert.equal(await started.listener.deliverTranscript("hola"), undefined);
	assert.deepEqual(framesOf(second, "transcript"), []);
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("voice off from one session clears every session's flag so the asleep exit arms (L10)", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 600_000, asleepIdleMs: 40 });
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", true);
	second.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(framesOf(first, "bye"), [], "two sessions with voice keep the listener alive");
	first.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => framesOf(second, "bye").length === 1, 3_000);
	assert.deepEqual(framesOf(second, "bye")[0], { type: "bye", reason: "idle" }, "asleep with no session asking for voice idles out");
	await waitFor(() => !existsSync(listenerPaths(dir).socket), 3_000);
});

test("a frame naming an inherited property gets one error and the listener keeps serving", async () => {
	const started = await startListener(scratch());
	const attacker = await started.client();
	attacker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(attacker, "welcome").length === 1);
	attacker.socket.write(`${JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, type: "toString" })}\n`);
	await waitFor(() => framesOf(attacker, "error").length === 1);
	assert.equal((framesOf(attacker, "error")[0] as { code: string }).code, "bad-frame");
	await attacker.closed;
	const survivor = await started.client();
	survivor.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(survivor, "welcome").length === 1);
	survivor.socket.destroy();
	await started.listener.close();
});

test("a listener that lost the lock stops serving and leaves the replacement reachable", async () => {
	const dir = scratch();
	const paths = listenerPaths(dir);
	const old = new VoiceListener({ dir, pid: 111, heartbeatMs: 20 });
	await old.listen();
	const client = await connectClient(dir);
	client.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(client, "welcome").length === 1);
	// A starting listener found the lock stale, took it and bound its own socket.
	assert.equal(releaseListenerLock(paths, { pid: 111 }), true);
	const replacement = new VoiceListener({ dir, pid: 222, heartbeatMs: 20 });
	await replacement.listen();
	await waitFor(() => framesOf(client, "bye").length === 1, 3_000);
	assert.deepEqual(framesOf(client, "bye")[0], { type: "bye", reason: "error" }, "a fenced listener stops serving");
	await client.closed;
	assert.equal(old.clientCount, 0);
	await old.close("shutdown");
	assert.equal(readListenerLock(paths)?.pid, 222, "the fenced listener never removes the replacement's lock");
	const survivor = await connectClient(dir);
	survivor.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(survivor, "welcome").length === 1);
	assert.deepEqual(framesOf(survivor, "welcome")[0], { type: "welcome", listenerPid: 222, proto: 1, state: "asleep" });
	await replacement.close();
});

test("herdr agent list is read once per decision and a changed shape focuses nothing", async () => {
	const calls: string[][] = [];
	const agents = JSON.stringify({ result: { agents: [{ pane_id: "w1:p1", focused: false }, { pane_id: "w1:p2", focused: true, agent_status: "idle" }] } });
	const focus = createHerdrFocus({ env: {}, now: () => 0, ttlMs: 300, run: async (_command, args) => { calls.push(args); return agents; } });
	assert.deepEqual(await focus.focusedPaneId(), { focused: "w1:p2" });
	assert.deepEqual(await focus.focusedPaneId(), { focused: "w1:p2" });
	assert.equal(calls.length, 1, "one call serves everyone inside the cache window");
	assert.deepEqual(calls[0], ["agent", "list"]);
	assert.deepEqual(parseHerdrAgents(agents), [{ paneId: "w1:p1", focused: false, status: undefined }, { paneId: "w1:p2", focused: true, status: "idle" }]);
	assert.equal(parseHerdrAgents('{"result":{}}'), undefined);
	assert.equal(parseHerdrAgents('{"result":{"agents":[{"pane_id":1}]}}'), undefined);
	assert.deepEqual(await createHerdrFocus({ env: {}, run: async () => "not json" }).focusedPaneId(), { failed: true }, "a malformed answer is a failed lookup, not an unfocused one");
	const binary: string[] = [];
	await createHerdrFocus({ env: { HERDR_BIN_PATH: "/opt/herdr" }, run: async (command) => { binary.push(command); return agents; } }).focusedPaneId();
	assert.deepEqual(binary, ["/opt/herdr"]);
});

test("T19-R1: the wake recheck bypasses a still-valid herdr focus cache", async () => {
	let focused = "w1:p1";
	let calls = 0;
	const focus = createHerdrFocus({
		env: {}, now: () => 0, ttlMs: 300,
		run: async () => { calls++; return JSON.stringify({ result: { agents: [{ pane_id: focused, focused: true }] } }); },
	});
	assert.deepEqual(await focus.focusedPaneId(), { focused: "w1:p1" });
	focused = "w1:p2";
	assert.deepEqual(await focus.focusedPaneId(), { focused: "w1:p1" }, "ordinary callers keep the cache");
	assert.deepEqual(await focus.focusedPaneId({ fresh: true }), { focused: "w1:p2" });
	assert.equal(calls, 2);
});

test("a listener with no client exits after the idle window and takes its files with it", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 40 });
	await waitFor(() => !existsSync(listenerPaths(dir).socket), 3_000);
	assert.equal(existsSync(listenerPaths(dir).lock), false, "the lock goes with the process");
	assert.ok(started.events.some((entry) => entry.event === "listener.exit" && entry.fields?.reason === "idle"));
});

test("asleep with no session that has voice ends after ten minutes of its own window (L10)", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 600_000, asleepIdleMs: 40 });
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	await waitFor(() => framesOf(client, "bye").length === 1, 3_000);
	assert.deepEqual(framesOf(client, "bye")[0], { type: "bye", reason: "idle" });
	await client.closed;
	await waitFor(() => !existsSync(listenerPaths(dir).socket), 3_000);
});

test("a session with voice on keeps the listener alive past the asleep window", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 600_000, asleepIdleMs: 40 });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(started.listener.clientCount, 1, "a session that wants voice holds the listener");
	assert.deepEqual(framesOf(client, "bye"), []);
	client.socket.destroy();
	await started.listener.close();
});

test("a second hello for the same session replaces the old socket", async () => {
	const started = await startListener(scratch());
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(first, "welcome").length === 1);
	const second = await started.client();
	second.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(second, "welcome").length === 1);
	await first.closed;
	assert.equal(started.listener.clientCount, 1, "one session, one live socket");
	second.socket.destroy();
	await started.listener.close();
});

test("a reading held on its own connection coexists with the session's, and a reload still replaces its stale socket (S6)", async () => {
	const started = await startListener(scratch());
	// One session holds two connections: the long-lived one that carries captures,
	// voice and the wake, and the one a reply is read on. Each hello used to evict
	// the other, so the reading was released as "closed" and the speech stopped.
	const link = await started.client();
	link.hello("s-1", "w1:p1", true, "session");
	await waitFor(() => framesOf(link, "welcome").length === 1);
	const reading = await started.client();
	reading.hello("s-1", "w1:p1", true, "reading");
	await waitFor(() => framesOf(reading, "welcome").length === 1);
	assert.deepEqual(framesOf(link, "bye"), [], "the session's connection is not evicted by its own reading");
	assert.deepEqual(framesOf(reading, "bye"), []);

	reading.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 40 });
	assert.equal((await awaitFrame(reading, (frame) => "id" in frame && frame.id === "r1")).type, "granted");
	assert.equal(started.listener.state, "reading");

	// The same session joins again while the reply is read, as a reconnect after a
	// listener restart does: the reading keeps its turn.
	const reloaded = await started.client();
	reloaded.hello("s-1", "w1:p1", true, "session");
	await waitFor(() => framesOf(reloaded, "welcome").length === 1);
	await link.closed;
	assert.deepEqual(framesOf(link, "bye"), [{ type: "bye", reason: "replaced" }], "a stale connection of the same role is still replaced, and told why");
	assert.deepEqual(framesOf(reading, "bye"), [], "the reading keeps its connection");
	assert.equal(started.listener.state, "reading", "and its turn");
	assert.deepEqual(
		framesOf(reading, "reading").map((frame) => (frame as { change: string }).change),
		["granted"],
		"nothing released it",
	);
	assert.equal(started.listener.clientCount, 2, "the reloaded connection and the reading");
	assert.equal(started.events.filter((entry) => entry.event === "listener.client-closed").length, 1, "one stale socket closed, no churn");

	// The session is still named once, whatever it holds.
	reloaded.send({ type: "status" });
	await waitFor(() => framesOf(reloaded, "snapshot").length === 1);
	assert.deepEqual(framesOf(reloaded, "snapshot")[0], { type: "snapshot", state: "reading", listenerPid: process.pid, clients: 2, sessions: ["s-1"] });

	reading.socket.destroy();
	reloaded.socket.destroy();
	await started.listener.close();
});

test("the lock body records the socket and the start time of the run", async () => {
	const dir = scratch();
	const started = await startListener(dir);
	const lock = readListenerLock(listenerPaths(dir));
	assert.equal(lock?.pid, process.pid);
	assert.equal(lock?.socket, listenerPaths(dir).socket);
	assert.equal(lock?.version, 1);
	assert.equal(typeof lock?.startedAt, "number");
	assert.ok(readFileSync(listenerPaths(dir).lock, "utf8").includes(String(process.pid)));
	await started.listener.close();
});

test("a regular file where the socket belongs is refused, never unlinked", async () => {
	const dir = scratch();
	mkdirSync(dir, { recursive: true });
	writeFileSync(listenerPaths(dir).socket, "not a socket");
	const listener = new VoiceListener({ dir });
	await assert.rejects(listener.listen(), /unsafe_path/);
	assert.equal(readFileSync(listenerPaths(dir).socket, "utf8"), "not a socket");
});

// --- the reading turn (slice B) ----------------------------------------------
// The listener owns the one reading turn: a session asks, renews, ends, and any
// session can cut. A session that goes away loses its turn without waiting.

test("one reading turn at a time: the second session waits and is granted when the first ends", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);

	first.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 900 });
	assert.deepEqual(await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1"), { type: "granted", id: "a1", readingId: "read-1", state: "reading" });
	assert.equal(started.listener.state, "reading", "a reading is a state every session sees");
	assert.deepEqual(await awaitFrame(second, (frame) => frame.type === "reading" && frame.change === "granted"), { type: "reading", change: "granted", readingId: "read-1", session: "s-1" });

	second.send({ type: "read-begin", id: "b1", readingId: "read-2", chars: 10 });
	assert.deepEqual(await awaitFrame(second, (frame) => "id" in frame && frame.id === "b1"), { type: "busy", id: "b1", reason: "reading", holder: "s-1" });
	assert.equal(started.listener.state, "reading", "the second session never talks over the first");

	first.send({ type: "read-end", id: "a2", readingId: "read-1", outcome: "done" });
	assert.deepEqual(await awaitFrame(first, (frame) => "id" in frame && frame.id === "a2"), { type: "ok", id: "a2", request: "read-end", state: "reading" });
	await waitFor(() => started.listener.state === "listening");
	assert.ok(started.events.some((event: { event: string }) => event.event === "reading.release"));
	second.send({ type: "read-begin", id: "b2", readingId: "read-2", chars: 10 });
	assert.deepEqual(await awaitFrame(second, (frame) => "id" in frame && frame.id === "b2"), { type: "granted", id: "b2", readingId: "read-2", state: "reading" });
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a reading whose session stopped renewing loses the turn when its lease expires", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readLeaseMs: 60, readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);

	first.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 100 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1");
	// No heartbeat: a session that crashed must not mute voice forever.
	assert.deepEqual(await awaitFrame(first, (frame) => frame.type === "reading" && frame.change === "released"), { type: "reading", change: "released", readingId: "read-1", session: "s-1", reason: "lease" });
	assert.ok(started.events.some((event: { event: string }) => event.event === "reading.lease-expired"));
	await waitFor(() => started.listener.state === "listening");
	second.send({ type: "read-begin", id: "b1", readingId: "read-2", chars: 10 });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "b1")).type, "granted", "the turn is free again");
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a heartbeat keeps the reading turn, and ending it releases the cued state", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readLeaseMs: 300, readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(first, "welcome").length === 1);
	first.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 100 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1");
	// Half a lease later one heartbeat buys another full lease.
	await new Promise((resolve) => setTimeout(resolve, 150));
	first.send({ type: "read-heartbeat", id: "h1", readingId: "read-1" });
	assert.equal((await awaitFrame(first, (frame) => "id" in frame && frame.id === "h1")).type, "ok");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(started.listener.state, "reading", "a renewed reading is never cut by its lease");
	// A heartbeat for a reading this listener did not grant is refused.
	first.send({ type: "read-heartbeat", id: "h2", readingId: "read-9" });
	assert.deepEqual(await awaitFrame(first, (frame) => "id" in frame && frame.id === "h2"), { type: "busy", id: "h2", reason: "reading", holder: "s-1" });
	first.send({ type: "read-end", readingId: "read-1", outcome: "skipped" });
	await waitFor(() => started.listener.state === "listening");
	assert.ok(started.events.some((event: { event: string; fields?: Record<string, unknown> }) => event.event === "reading.release" && event.fields?.outcome === "skipped"));
	first.socket.destroy();
	await started.listener.close();
});

test("a cut ends the reading wherever it speaks and frees the turn", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	first.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 100 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1");
	second.send({ type: "read-cut", id: "c1" });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "c1")).type, "ok");
	assert.deepEqual(await awaitFrame(first, (frame) => frame.type === "reading" && frame.change === "released"), { type: "reading", change: "released", readingId: "read-1", session: "s-1", reason: "cut" });
	await waitFor(() => started.listener.state === "listening");
	second.send({ type: "read-begin", id: "b1", readingId: "read-2", chars: 10 });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "b1")).type, "granted");
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a cut naming another reading leaves the current one speaking", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	first.send({ type: "read-begin", id: "a1", readingId: "read-2", chars: 100 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1");
	// A late cut for a reading that already ended must not cut its successor.
	second.send({ type: "read-cut", id: "c1", readingId: "read-1" });
	assert.deepEqual(await awaitFrame(second, (frame) => "id" in frame && frame.id === "c1"), { type: "busy", id: "c1", reason: "reading", holder: "s-1" });
	assert.equal(started.listener.state, "reading");
	assert.equal(framesOf(first, "reading").filter((frame) => "change" in frame && frame.change === "released").length, 0);
	// The matching id still cuts it.
	second.send({ type: "read-cut", id: "c2", readingId: "read-2" });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "c2")).type, "ok");
	await waitFor(() => started.listener.state === "listening");
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a reader whose session went away releases the turn at once", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readTailMs: 5 });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	first.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 100 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "a1");
	first.socket.destroy();
	await waitFor(() => started.listener.state === "listening");
	second.send({ type: "read-begin", id: "b1", readingId: "read-2", chars: 10 });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "b1")).type, "granted", "a dead reader never holds the turn");
	second.socket.destroy();
	await started.listener.close();
});

test("a session with voice off cannot read while the listener is asleep, and a fresh listener still lets one read", async () => {
	const dir = scratch();
	const started = await startListener(dir, { readTailMs: 5 });
	const quiet = await started.client();
	quiet.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(quiet, "welcome").length === 1);
	quiet.send({ type: "read-begin", id: "a1", readingId: "read-1", chars: 10 });
	assert.deepEqual(await awaitFrame(quiet, (frame) => "id" in frame && frame.id === "a1"), { type: "busy", id: "a1", reason: "asleep" });
	assert.equal(started.listener.state, "asleep", "a refused reading changes no state");
	// A fresh listener is asleep too, and a session with voice on reads as it
	// always did: "asleep" is not a reading ban for a session that has voice.
	const voiced = await started.client();
	voiced.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(voiced, "welcome").length === 1);
	voiced.send({ type: "read-begin", id: "b1", readingId: "read-2", chars: 10 });
	assert.equal((await awaitFrame(voiced, (frame) => "id" in frame && frame.id === "b1")).type, "granted");
	quiet.socket.destroy();
	voiced.socket.destroy();
	await started.listener.close();
});

// --- capture and ASR inside the listener (slice C) ---------------------------

// A dictation that walks the edges the warm worker reports, in order: recording,
// transcribing (the stop), finished. `error` makes the stop reject the way the
// worker rejects a recording that heard nothing.
interface FakeCapture {
	readonly calls: string[];
	// Every request the listener made, so a test sees what it asked the worker for
	// and drives the levels the worker would have published.
	readonly requests: ListenerDictationRequest[];
	readonly factory: (request: ListenerDictationRequest) => ListenerDictation;
}

// `command` is what the worker reports when the capture it heard was a spoken
// command instead of speech (S4): the hidden ASR model emits one id, not words.
function fakeCapture(options: { text?: string; truncated?: boolean; error?: VoiceSessionErrorCode; command?: string } = {}): FakeCapture {
	const calls: string[] = [];
	const requests: ListenerDictationRequest[] = [];
	let notify: (state: VoiceSessionState) => void = () => {};
	return {
		calls,
		requests,
		factory: (request) => {
			requests.push(request);
			notify = request.onStateChange;
			return {
				start: async () => {
					calls.push("start");
					notify("recording");
				},
				stop: async () => {
					calls.push("stop");
					notify("transcribing");
					notify("finished");
					if (options.error) throw new VoiceSessionError(options.error);
					return { text: options.text ?? "hola", truncated: options.truncated === true, ...(options.command === undefined ? {} : { command: options.command }) };
				},
				cancel: async () => {
					calls.push("cancel");
					notify("finished");
				},
			};
		},
	};
}

interface ManualCapture {
	readonly requests: ListenerDictationRequest[];
	// One worker edge the real worker would report.
	state(state: VoiceSessionState): void;
	readonly factory: (request: ListenerDictationRequest) => ListenerDictation;
}

// A capture the test drives edge by edge: the worker reports nothing until the
// test says so, so a capture that was asked for but does not record yet is
// visible as such.
function manualCapture(options: { error?: VoiceSessionErrorCode } = {}): ManualCapture {
	const requests: ListenerDictationRequest[] = [];
	let notify: (state: VoiceSessionState) => void = () => {};
	return {
		requests,
		state: (state) => notify(state),
		factory: (request) => {
			requests.push(request);
			notify = request.onStateChange;
			return {
				start: async () => {},
				stop: async () => {
					notify("transcribing");
					notify("finished");
					if (options.error) throw new VoiceSessionError(options.error);
					return { text: "hola", truncated: false };
				},
				cancel: async () => {
					notify("finished");
				},
			};
		},
	};
}

const cuePlayer = (): CuePlayer => ({ play: async (name) => ({ name, outcome: "done", ms: 3 }), warm: () => {}, dispose: () => {} });
const phases = (client: Client) => client.frames.flatMap((frame) => (frame.type === "capture" ? [frame.phase] : []));
const states = (events: Array<{ event: string; fields?: Record<string, unknown> }>) => events.flatMap((entry) => (entry.event === "listener.state" ? [entry.fields?.state] : []));
const cueLog = (events: Array<{ event: string; fields?: Record<string, unknown> }>) => events.flatMap((entry) => (entry.event === "cue" ? [entry.fields] : []));

test("a dictation is recorded by the listener and its transcript goes to the focused session", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "hola mundo" });
	const started = await startListener(dir, {
		dictation: capture.factory,
		cues: cuePlayer(),
		focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
	});
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	const focused = await started.client();
	focused.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(focused, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1")).type, "ok");
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(cueLog(started.events).map((cue) => [cue?.name, cue?.mode]), [["open", "conversation"]]);

	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d2");
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "elsewhere"), { type: "capture", phase: "elsewhere", target: "s-2" });
	assert.deepEqual(framesOf(asker, "transcript"), [], "the session that asked earns nothing it was not focused for");
	assert.deepEqual(framesOf(focused, "transcript"), [{ type: "transcript", text: "hola mundo" }]);
	assert.deepEqual(phases(asker), ["recording", "transcribing", "elsewhere"]);
	assert.deepEqual(capture.calls, ["start", "stop"]);
	// The microphone closes when the recording does; a session that has voice
	// keeps the listener awake, so it stays listening rather than asleep.
	assert.deepEqual(states(started.events), ["listening", "transcribing", "listening"]);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
	asker.socket.destroy();
	focused.socket.destroy();
	await started.listener.close();
});

test("the focus is read when the recording ends, not when it starts", async () => {
	const dir = scratch();
	let focused: string | undefined = "w1:p1";
	const capture = fakeCapture({ text: "sigue acá" });
	const started = await startListener(dir, { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	const other = await started.client();
	other.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(asker, "welcome").length === 1 && framesOf(other, "welcome").length === 1);

	asker.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	// The owner moved to the other pane while the microphone was open.
	focused = "w1:p2";
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "elsewhere"), { type: "capture", phase: "elsewhere", target: "s-2" });
	assert.deepEqual(framesOf(other, "transcript"), [{ type: "transcript", text: "sigue acá" }]);
	asker.socket.destroy();
	other.socket.destroy();
	await started.listener.close();
});

test("a transcript with nobody focused, or with the lookup failed, is dropped instead of broadcast", async () => {
	for (const focus of [{ focusedPaneId: async () => ({ focused: undefined }) }, { focusedPaneId: async () => ({ failed: true as const }) }]) {
		const dir = scratch();
		const started = await startListener(dir, { dictation: fakeCapture().factory, focus });
		const clients = [await started.client(), await started.client(), await started.client()];
		clients.forEach((client, index) => client.hello(`s-${index + 1}`, `w1:p${index + 1}`));
		await waitFor(() => clients.every((client) => framesOf(client, "welcome").length === 1));
		clients[0].send({ type: "dictate", mode: "dictation" });
		await awaitFrame(clients[0], (frame) => frame.type === "capture" && frame.phase === "recording");
		clients[0].send({ type: "stop" });
		assert.deepEqual(await awaitFrame(clients[0], (frame) => frame.type === "capture" && frame.phase === "dropped"), { type: "capture", phase: "dropped" });
		for (const client of clients) assert.deepEqual(framesOf(client, "transcript"), []);
		assert.equal(started.events.filter((entry) => entry.event === "transcript.undelivered").length, 1);
		for (const client of clients) client.socket.destroy();
		await started.listener.close();
	}
});

test("one capture at a time, and none while a reading holds the microphone shut", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "uno" });
	const started = await startListener(dir, { dictation: capture.factory, readTailMs: 5, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const first = await started.client();
	first.hello("s-1", "w1:p1");
	const second = await started.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);

	first.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(first, (frame) => frame.type === "capture" && frame.phase === "recording");
	second.send({ type: "dictate", id: "b1", mode: "conversation" });
	assert.deepEqual(await awaitFrame(second, (frame) => "id" in frame && frame.id === "b1"), { type: "busy", id: "b1", reason: "capture", holder: "s-1" });
	second.send({ type: "stop", id: "b2" });
	assert.equal((await awaitFrame(second, (frame) => "id" in frame && frame.id === "b2")).type, "busy", "a stop from a session that owns no capture is refused");
	first.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(first, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	assert.deepEqual(framesOf(first, "transcript"), [{ type: "transcript", text: "uno" }]);

	// A reading shuts the microphone: it is off the air while it speaks.
	first.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 5 });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "r1");
	second.send({ type: "dictate", id: "b3", mode: "dictation" });
	assert.deepEqual(await awaitFrame(second, (frame) => "id" in frame && frame.id === "b3"), { type: "busy", id: "b3", reason: "reading", holder: "s-1" });
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
});

test("a cancelled capture ends without a transcript and without a stop", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "no debería" });
	const started = await startListener(dir, { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	asker.send({ type: "cancel", id: "c1" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "c1")).type, "ok");
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "cancelled"), { type: "capture", phase: "cancelled" });
	assert.deepEqual(capture.calls, ["start", "cancel"]);
	assert.deepEqual(framesOf(asker, "transcript"), []);
	assert.equal(started.listener.state, "listening", "the microphone is free again");
	asker.socket.destroy();
	await started.listener.close();
});

test("a cancel that arrives while the focus is read delivers nothing", async () => {
	const dir = scratch();
	let openFocus!: () => void;
	const gate = new Promise<void>((resolve) => (openFocus = resolve));
	const capture = fakeCapture({ text: "no debería" });
	const started = await startListener(dir, {
		dictation: capture.factory,
		focus: { focusedPaneId: async () => { await gate; return { focused: "w1:p2" }; } },
	});
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	const focused = await started.client();
	focused.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(asker, "welcome").length === 1 && framesOf(focused, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	// The stop is waiting on the focus lookup: the cancel arrives inside that window.
	asker.send({ type: "stop", id: "s1" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	asker.send({ type: "cancel", id: "c1" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "c1")).type, "ok");
	assert.deepEqual(framesOf(asker, "capture").at(-1), { type: "capture", phase: "cancelled" });
	openFocus();
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "s1");
	assert.deepEqual([...framesOf(asker, "transcript"), ...framesOf(focused, "transcript")], [], "a cancelled capture reaches nobody");
	asker.socket.destroy();
	focused.socket.destroy();
	await started.listener.close();
});

test("a capture that fails reports the worker's code and closes the microphone", async () => {
	const dir = scratch();
	const started = await startListener(dir, { dictation: fakeCapture({ error: "no-speech" }).factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
	assert.deepEqual(framesOf(asker, "transcript"), []);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
	assert.equal(started.listener.state, "listening");
	asker.socket.destroy();
	await started.listener.close();
});

test("a session that goes away mid-recording gives the microphone back", async () => {
	const dir = scratch();
	const capture = fakeCapture();
	const started = await startListener(dir, { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	const next = await started.client();
	next.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(asker, "welcome").length === 1 && framesOf(next, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	asker.socket.destroy();
	await waitFor(() => capture.calls.includes("cancel"));
	assert.equal(started.listener.state, "listening", "the next session keeps it awake");
	// The microphone is free again: the next session records instead of waiting.
	next.send({ type: "dictate", id: "n1", mode: "dictation" });
	assert.equal((await awaitFrame(next, (frame) => "id" in frame && frame.id === "n1")).type, "ok");
	next.socket.destroy();
	await started.listener.close();
});

// --- levels and the overlay port (slice D, T4) --------------------------------

const levelFrames = (client: Client) => client.frames.filter((frame) => frame.type === "level");

interface FakeOverlay {
	readonly snapshots: VoiceOverlaySnapshot[];
	readonly levels: number[];
	readonly overlay: VoiceOverlay;
	disposed(): number;
}

function fakeOverlay(): FakeOverlay {
	const snapshots: VoiceOverlaySnapshot[] = [];
	const levels: number[] = [];
	let disposed = 0;
	return {
		snapshots,
		levels,
		disposed: () => disposed,
		overlay: {
			show: (snapshot) => {
				snapshots.push(snapshot);
			},
			level: (value) => {
				levels.push(value);
			},
			dispose: () => {
				disposed += 1;
			},
		},
	};
}

test("levels reach only the sessions that asked for them, never more than twenty a second", async () => {
	const dir = scratch();
	let clock = 0;
	const capture = fakeCapture();
	const started = await startListener(dir, { dictation: capture.factory, now: () => clock });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	const watcher = await started.client();
	watcher.hello("s-2", "w1:p2");
	const leaving = await started.client();
	leaving.hello("s-3", "w1:p3");
	await waitFor(() => [asker, watcher, leaving].every((client) => framesOf(client, "welcome").length === 1));
	watcher.send({ type: "levels", id: "l1", on: true });
	await awaitFrame(watcher, (frame) => "id" in frame && frame.id === "l1");
	leaving.send({ type: "levels", id: "l2", on: true });
	await awaitFrame(leaving, (frame) => "id" in frame && frame.id === "l2");

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	const request = capture.requests.at(-1)!;
	assert.equal(request.levels, true, "a subscriber makes the listener ask the worker for levels");

	request.onLevel(0.02);
	await awaitFrame(watcher, (frame) => frame.type === "level");
	assert.deepEqual(levelFrames(watcher), [{ type: "level", rms: 0.02, at: 0 }]);
	assert.deepEqual(levelFrames(asker), [], "the session that records without asking receives none");

	// Whatever the worker publishes, the listener itself stays under 20 a second.
	for (let i = 0; i < 30; i++) request.onLevel(0.02);
	assert.equal(levelFrames(watcher).length, 1, "one message per 50 ms of audio at most");
	clock = 50;
	request.onLevel(0.03);
	await awaitFrame(watcher, (frame) => frame.type === "level" && frame.rms === 0.03);
	assert.equal(levelFrames(watcher).length, 2);

	// A session that closes stops receiving them; an unsubscribed one too.
	leaving.socket.destroy();
	await waitFor(() => started.listener.clientCount === 2);
	watcher.send({ type: "levels", id: "l3", on: false });
	await awaitFrame(watcher, (frame) => "id" in frame && frame.id === "l3");
	clock = 100;
	request.onLevel(0.04);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(levelFrames(watcher).length, 2, "unsubscribing stops the events for that session");
	assert.deepEqual(levelFrames(leaving), [
		{ type: "level", rms: 0.02, at: 0 },
		{ type: "level", rms: 0.03, at: 50 },
	], "a session that left receives nothing more");

	// Levels only while a capture records.
	watcher.send({ type: "levels", id: "l4", on: true });
	await awaitFrame(watcher, (frame) => "id" in frame && frame.id === "l4");
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d2");
	clock = 200;
	request.onLevel(0.05);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(levelFrames(watcher).length, 2, "levels only while a capture records");
	watcher.socket.destroy();
	asker.socket.destroy();
	await started.listener.close();
});

test("the worker is asked for levels only when an overlay or a subscriber needs them", async () => {
	const without = fakeCapture();
	const plain = await startListener(scratch(), { dictation: without.factory });
	const asker = await plain.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	assert.equal(without.requests[0]!.levels, false, "nothing needs levels, so the worker is not asked");
	asker.socket.destroy();
	await plain.listener.close();

	const overlay = fakeOverlay();
	const withOverlay = fakeCapture();
	const windowed = await startListener(scratch(), { dictation: withOverlay.factory, overlay: overlay.overlay });
	const second = await windowed.client();
	second.hello("s-2", "w1:p2");
	await waitFor(() => framesOf(second, "welcome").length === 1);
	second.send({ type: "dictate", id: "d2", mode: "conversation" });
	await awaitFrame(second, (frame) => "id" in frame && frame.id === "d2");
	assert.equal(withOverlay.requests[0]!.levels, true, "the overlay alone is enough");
	second.socket.destroy();
	await windowed.listener.close();
});

test("the overlay sees every state change, the owning session and the smoothed level", async () => {
	const dir = scratch();
	const overlay = fakeOverlay();
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, {
		dictation: capture.factory,
		now: () => 7,
		overlay: overlay.overlay,
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await waitFor(() => framesOf(asker, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	// Registration wakes voice idle without claiming the microphone; the worker's
	// recording edge is what first names a microphone owner (S10).
	assert.deepEqual(overlay.snapshots, [
		{ state: "listening", language: "es", recording: false },
		{ state: "listening", language: "es", recording: true, label: "repo", paneId: "w1:p1" },
	]);
	assert.deepEqual(framesOf(asker, "state"), [{ type: "state", state: "listening", language: "es", at: 7 }]);

	capture.requests.at(-1)!.onLevel(0.016);
	assert.deepEqual(overlay.levels, [0.6], "speech is a full bar, smoothed from empty");
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d2");
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered");
	assert.deepEqual(
		overlay.snapshots.map((snapshot) => [snapshot.state, snapshot.recording]),
		[
			["listening", false],
			["listening", true],
			["listening", false],
			["transcribing", false],
			["listening", false],
		],
		"every state change and every recording edge, nothing invented in between",
	);
	assert.deepEqual(overlay.snapshots.at(-1), { state: "listening", language: "es", recording: false }, "no session owns the microphone between captures");
	asker.socket.destroy();
	await started.listener.close();
	assert.equal(overlay.disposed(), 1, "the overlay is disposed with the listener");
});

test("the snapshot says recording only between the worker's report and the end of the recording (S10)", async () => {
	const dir = scratch();
	const overlay = fakeOverlay();
	const capture = manualCapture();
	const started = await startListener(dir, {
		dictation: capture.factory,
		overlay: overlay.overlay,
		now: () => 7,
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await waitFor(() => framesOf(asker, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	assert.deepEqual(
		overlay.snapshots,
		[{ state: "listening", language: "es", recording: false }],
		"a capture that has not reported recording yet is not a recording",
	);

	capture.state("recording");
	await waitFor(() => overlay.snapshots.length === 2);
	assert.deepEqual(
		overlay.snapshots.at(-1),
		{ state: "listening", language: "es", recording: true, label: "repo", paneId: "w1:p1" },
		"recording alone is a new snapshot, because the state did not change",
	);

	// Levels are the wave, never a claim about the microphone: they arrive after
	// the flag and add no snapshot of their own.
	capture.requests.at(-1)!.onLevel(0.016);
	await waitFor(() => overlay.levels.length === 1);
	assert.equal(overlay.snapshots.length, 2, "a level never redraws the state");

	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered");
	assert.deepEqual(
		overlay.snapshots.map((snapshot) => [snapshot.state, snapshot.recording]),
		[
			["listening", false],
			["listening", true],
			// The microphone closes before the state says what happens to the audio, so
			// no snapshot ever shows a closed microphone as recording.
			["listening", false],
			["transcribing", false],
			["listening", false],
		],
		"recording is true only while the worker records",
	);
	asker.socket.destroy();
	await started.listener.close();
});

test("every way a capture can end publishes recording false, and never turns it back on (S10)", async () => {
	for (const ending of ["stop", "cancel", "worker-error", "session-close"] as const) {
		const overlay = fakeOverlay();
		const capture = manualCapture({ error: ending === "worker-error" ? "worker-exited" : undefined });
		const started = await startListener(scratch(), { dictation: capture.factory, overlay: overlay.overlay, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
		const asker = await started.client();
		asker.hello("s-1", "w1:p1");
		await waitFor(() => framesOf(asker, "welcome").length === 1);

		asker.send({ type: "dictate", id: "d1", mode: "conversation" });
		await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
		capture.state("recording");
		await waitFor(() => overlay.snapshots.some((snapshot) => snapshot.recording));

		if (ending === "cancel") asker.send({ type: "cancel", id: "d2" });
		else if (ending === "session-close") asker.socket.destroy();
		else asker.send({ type: "stop", id: "d2" });

		const phase = ending === "cancel" ? "cancelled" : ending === "worker-error" ? "failed" : "delivered";
		if (ending === "session-close") await waitFor(() => started.listener.clientCount === 0);
		else await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === phase);

		assert.equal(overlay.snapshots.filter((snapshot) => snapshot.recording).length, 1, `${ending}: recording was claimed exactly once`);
		assert.equal(overlay.snapshots.at(-1)?.recording, false, `${ending}: the microphone is published closed when the capture ends`);
		if (ending !== "session-close") asker.socket.destroy();
		await started.listener.close();
		assert.equal(overlay.disposed(), 1, `${ending}: the overlay still closes with the listener`);
	}
});

test("a level is never read as the microphone recording (S10)", async () => {
	const overlay = fakeOverlay();
	const capture = manualCapture();
	const started = await startListener(scratch(), { dictation: capture.factory, overlay: overlay.overlay, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");

	// The worker is not recording, so a level it publishes anyway is no evidence.
	capture.requests.at(-1)!.onLevel(0.9);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(overlay.levels, [], "no wave is drawn before the recording is reported");
	assert.deepEqual(overlay.snapshots.map((snapshot) => snapshot.recording), [false], "and no recording is claimed");
	asker.socket.destroy();
	await started.listener.close();
});

test("the client's state frame is unchanged: the recording flag never reaches a session", async () => {
	const overlay = fakeOverlay();
	const capture = manualCapture();
	const started = await startListener(scratch(), { dictation: capture.factory, overlay: overlay.overlay, now: () => 7, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await waitFor(() => framesOf(asker, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	capture.state("recording");
	await waitFor(() => overlay.snapshots.some((snapshot) => snapshot.recording));
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered");

	assert.deepEqual(
		framesOf(asker, "state"),
		[
			{ type: "state", state: "listening", language: "es", at: 7 },
			{ type: "state", state: "transcribing", language: "es", paneId: "w1:p1", label: "repo", at: 7 },
			{ type: "state", state: "listening", language: "es", at: 7 },
		],
		"the wire protocol is untouched: one frame per state change, never one per recording edge",
	);
	for (const frame of framesOf(asker, "state")) assert.ok(!("recording" in frame), "no recording field on the client protocol");
	asker.socket.destroy();
	await started.listener.close();
});

test("an overlay that throws is logged once and never breaks the capture", async () => {
	const dir = scratch();
	let calls = 0;
	const overlay: VoiceOverlay = {
		show: () => {
			calls += 1;
			throw new Error("the window is gone");
		},
		level: () => {
			calls += 1;
			throw new Error("the window is gone");
		},
		dispose: () => {
			throw new Error("the window is gone");
		},
	};
	const capture = fakeCapture({ text: "hola mundo" });
	const started = await startListener(dir, { dictation: capture.factory, overlay, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	capture.requests.at(-1)!.onLevel(0.02);
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "hola mundo" }]);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"], "the cues are unaffected");
	const failures = started.events.filter((entry) => entry.event === "overlay.failed");
	assert.equal(failures.length, 1, "logged once");
	assert.equal(failures[0]!.fields, undefined, "the event name only: never a level, never a transcript");
	assert.equal(calls, 1, "a dead overlay is never called again");
	asker.socket.destroy();
	await started.listener.close();
});

test("an overlay whose promises reject is dropped the same way", async () => {
	const dir = scratch();
	let calls = 0;
	const overlay: VoiceOverlay = {
		show: async () => {
			calls += 1;
			throw new Error("the window is gone");
		},
		level: async () => {
			calls += 1;
			throw new Error("the window is gone");
		},
		dispose: async () => {},
	};
	const capture = fakeCapture({ text: "sigue" });
	const started = await startListener(dir, { dictation: capture.factory, overlay, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	capture.requests.at(-1)!.onLevel(0.02);
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "sigue" }]);
	asker.socket.destroy();
	await started.listener.close();
	const failures = started.events.filter((entry) => entry.event === "overlay.failed");
	assert.equal(failures.length, 1, "logged once");
	assert.equal(failures[0]!.fields, undefined);
	assert.equal(calls, 1, "a rejecting overlay is never called again");
});

// --- the reading's own loudness (T13, S5) --------------------------------------
// While a reply is read aloud the overlay draws the output, not the microphone:
// the session that holds the reading sends the loudness of each chunk its player
// began, and the listener hands it to the overlay one frame at a time.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One session that asked, was granted the turn, and is the only one accepted.
async function grantedReading(started: Started, sessionId = "s-1", readingId = "read-1"): Promise<Client> {
	const reader = await started.client();
	reader.hello(sessionId);
	await waitFor(() => framesOf(reader, "welcome").length === 1);
	reader.send({ type: "read-begin", id: "b1", readingId, chars: 40 });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "b1")).type, "granted");
	return reader;
}

test("the reading's loudness reaches the overlay as it is, one value per frame of audio, and stops when the reading ends", async () => {
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { overlay: overlay.overlay });
	const reader = await grantedReading(started);
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.3, 0.6, 0.1] });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v1"), { type: "ok", id: "v1", request: "read-levels", state: "reading" });
	assert.deepEqual(overlay.levels, [], "a level is drawn in audio time, never at the moment it arrives");
	const first = Date.now();
	await waitFor(() => overlay.levels.length === 3);
	assert.deepEqual(overlay.levels, [0.3, 0.6, 0.1], "raw output loudness: the window normalizes and smooths it");
	assert.ok(Date.now() - first >= 80, "three values of 50 ms each take at least 100 ms, not one burst");
	await sleep(120);
	assert.equal(overlay.levels.length, 3, "nothing is drawn past the last value of the chunk");

	// A narrower frame than the ceiling is still paced at the ceiling: twenty a
	// second, never faster.
	reader.send({ type: "read-levels", id: "v2", readingId: "read-1", frameMs: 10, levels: [0.2, 0.2, 0.2, 0.2, 0.2] });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v2");
	const paced = Date.now();
	await waitFor(() => overlay.levels.length === 8);
	assert.ok(Date.now() - paced >= 200, "five ten-millisecond frames take the same quarter second twenty a second allows");

	// Ending the reading stops whatever is still scheduled.
	reader.send({ type: "read-levels", id: "v3", readingId: "read-1", frameMs: 50, levels: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9] });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v3");
	await waitFor(() => overlay.levels.length >= 9);
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e1");
	const atEnd = overlay.levels.length;
	await sleep(200);
	assert.equal(overlay.levels.length, atEnd, "no level is delivered after the reading ended");
	reader.socket.destroy();
	await started.listener.close();
});

test("only the session holding this reading is accepted, and a new chunk replaces the one still scheduled", async () => {
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { overlay: overlay.overlay });
	const reader = await grantedReading(started);
	const other = await started.client();
	other.hello("s-2");
	await waitFor(() => framesOf(other, "welcome").length === 1);

	// A session that does not hold the turn changes nothing, and neither does the
	// holder naming another reading.
	other.send({ type: "read-levels", id: "x1", readingId: "read-1", frameMs: 50, levels: [0.9] });
	assert.deepEqual(await awaitFrame(other, (frame) => "id" in frame && frame.id === "x1"), { type: "busy", id: "x1", reason: "reading", holder: "s-1" });
	reader.send({ type: "read-levels", id: "x2", readingId: "read-9", frameMs: 50, levels: [0.9] });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "x2"), { type: "busy", id: "x2", reason: "reading", holder: "s-1" });
	await sleep(120);
	assert.deepEqual(overlay.levels, [], "a refused frame draws nothing");

	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 8 }, () => 0.1) });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v1");
	await waitFor(() => overlay.levels.length >= 1);
	reader.send({ type: "read-levels", id: "v2", readingId: "read-1", frameMs: 50, levels: [0.5, 0.5] });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v2");
	await waitFor(() => overlay.levels.includes(0.5));
	await sleep(220);
	assert.deepEqual(overlay.levels.slice(overlay.levels.indexOf(0.5)), [0.5, 0.5], "the new chunk replaced the rest of the old one");
	assert.ok(overlay.levels.length <= 4, "the replaced values are never drawn");
	other.socket.destroy();
	reader.socket.destroy();
	await started.listener.close();
});

test("a cut and an expired lease stop the scheduled levels at once", async () => {
	// A cut: another session takes the turn back while the wave is drawing.
	const cutOverlay = fakeOverlay();
	const cut = await startListener(scratch(), { overlay: cutOverlay.overlay });
	const reader = await grantedReading(cut);
	const cutter = await cut.client();
	cutter.hello("s-2");
	await waitFor(() => framesOf(cutter, "welcome").length === 1);
	reader.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => cutOverlay.levels.length >= 1);
	cutter.send({ type: "read-cut", id: "c1", readingId: "read-1" });
	await awaitFrame(cutter, (frame) => "id" in frame && frame.id === "c1");
	const afterCut = cutOverlay.levels.length;
	await sleep(200);
	assert.equal(cutOverlay.levels.length, afterCut, "a cut stops the levels at once");
	reader.socket.destroy();
	cutter.socket.destroy();
	await cut.listener.close();

	// A lease that is not renewed: the turn goes back and the wave with it.
	const leaseOverlay = fakeOverlay();
	const lease = await startListener(scratch(), { overlay: leaseOverlay.overlay, readLeaseMs: 150 });
	const silent = await grantedReading(lease);
	silent.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => leaseOverlay.levels.length >= 1);
	await waitFor(() => lease.events.some((entry) => entry.event === "reading.lease-expired"));
	const afterLease = leaseOverlay.levels.length;
	await sleep(200);
	assert.equal(leaseOverlay.levels.length, afterLease, "an expired lease stops the levels at once");
	silent.socket.destroy();
	await lease.listener.close();
});

test("a holder that disconnects and a listener that closes stop the scheduled levels", async () => {
	const goneOverlay = fakeOverlay();
	const gone = await startListener(scratch(), { overlay: goneOverlay.overlay });
	const reader = await grantedReading(gone);
	reader.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => goneOverlay.levels.length >= 1);
	reader.socket.destroy();
	await waitFor(() => gone.listener.readingSession === undefined);
	const afterGone = goneOverlay.levels.length;
	await sleep(200);
	assert.equal(goneOverlay.levels.length, afterGone, "the holder leaving stops the levels");
	await gone.listener.close();

	const closedOverlay = fakeOverlay();
	const closing = await startListener(scratch(), { overlay: closedOverlay.overlay });
	const last = await grantedReading(closing);
	last.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => closedOverlay.levels.length >= 1);
	await closing.listener.close();
	const afterClose = closedOverlay.levels.length;
	await sleep(200);
	assert.equal(closedOverlay.levels.length, afterClose, "a closing listener stops the levels");
	last.socket.destroy();
});

test("with no overlay attached the reading accepts its levels and schedules nothing", async () => {
	const started = await startListener(scratch());
	const reader = await grantedReading(started);
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.2, 0.2] });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v1"), { type: "ok", id: "v1", request: "read-levels", state: "reading" });
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e1"), { type: "ok", id: "e1", request: "read-end", state: "reading" });
	reader.socket.destroy();
	await started.listener.close();
});

test("an overlay that fails on a reading level is dropped once and the reading carries on", async () => {
	let calls = 0;
	const overlay: VoiceOverlay = {
		show: () => {},
		level: () => {
			calls += 1;
			throw new Error("the window is gone");
		},
		dispose: () => {},
	};
	const started = await startListener(scratch(), { overlay });
	const reader = await grantedReading(started);
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.2, 0.4, 0.6] });
	await waitFor(() => calls === 1);
	await sleep(150);
	assert.equal(calls, 1, "a dead overlay is never called again");
	const failures = started.events.filter((entry) => entry.event === "overlay.failed");
	assert.equal(failures.length, 1);
	assert.equal(failures[0]!.fields, undefined, "the event name only: never a level value");
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e1"), { type: "ok", id: "e1", request: "read-end", state: "reading" });
	reader.socket.destroy();
	await started.listener.close();
});

test("the microphone meter is untouched: a reading level is raw and a capture's is still smoothed", async () => {
	const dir = scratch();
	const overlay = fakeOverlay();
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, { dictation: capture.factory, overlay: overlay.overlay, readTailMs: 20, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const reader = await grantedReading(started);
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.5] });
	await waitFor(() => overlay.levels.length === 1);
	assert.deepEqual(overlay.levels, [0.5], "no normalization or smoothing on the listener side");
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e1");
	await waitFor(() => started.listener.readingSession === undefined, 2_000);

	reader.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d1");
	await awaitFrame(reader, (frame) => frame.type === "capture" && frame.phase === "recording");
	capture.requests.at(-1)!.onLevel(0.016);
	assert.deepEqual(overlay.levels, [0.5, 0.6], "the microphone level is still normalized and smoothed as before");
	reader.socket.destroy();
	await started.listener.close();
});

// --- the keyword spotter (T16, S7, S4, S10) -----------------------------------

// The listener hears spoken commands in every capture it starts, keeps a
// spot-only capture open while it is asleep, and wakes the focused session on
// "Gentle Voice on". Every capture here is a fake: no microphone, no model and
// no audio, and the keyword option only names what the fakes would receive.

const ON_LINE = "▁G ENT LE ▁ VO IC E ▁ON";
const OFF_LINE = "▁G ENT LE ▁ VO IC E ▁OF F";

const keywordOption = (): VoiceKeywordOption => ({
	model: {
		root: "/opt/gentle/voice/models/kws",
		files: {
			encoder: { name: KWS_SPOTTER_FILES.encoder, size: 4_807_159, sha256: "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678" },
			decoder: { name: KWS_SPOTTER_FILES.decoder, size: 277_985, sha256: "e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a" },
			joiner: { name: KWS_SPOTTER_FILES.joiner, size: 163_380, sha256: "eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c" },
			tokens: { name: KWS_SPOTTER_FILES.tokens, size: 5_006, sha256: "fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53" },
		},
	},
	keywords: [
		{ tokens: ON_LINE, command: "voice-on" },
		{ tokens: OFF_LINE, command: "voice-off" },
	],
	boost: 2,
	threshold: 0.25,
	maxActivePaths: 16,
	trailingBlanks: 2,
});

const installedPaths = () => {
	const root = join("/opt/gentle/voice", "models", KWS_MODEL_MANIFEST.id);
	return { encoder: join(root, KWS_SPOTTER_FILES.encoder), decoder: join(root, KWS_SPOTTER_FILES.decoder), joiner: join(root, KWS_SPOTTER_FILES.joiner), tokens: join(root, KWS_SPOTTER_FILES.tokens) };
};

test("the keyword option is built from the installed spotter, the pinned digests, the keyword file and the recommended tuning", async () => {
	const paths = installedPaths();
	const built = await buildVoiceKeywordOption({
		voiceHome: "/opt/gentle/voice",
		resolvePaths: async () => paths,
		readKeywords: async () => `# one line per spelling\nvoice-on: ${ON_LINE}\nvoice-off: ${OFF_LINE}\n`,
	});
	assert.ok("option" in built, JSON.stringify(built));
	assert.equal(built.option.model.root, dirname(paths.encoder), "the spotter loads its model from the installed component");
	for (const [role, path] of Object.entries(paths) as Array<[keyof typeof paths, string]>) {
		const pinned = KWS_MODEL_MANIFEST.files.find((file) => file.name === basename(path));
		assert.ok(pinned, `${path} is a pinned file`);
		assert.deepEqual(built.option.model.files[role], { name: pinned.name, size: pinned.size, sha256: pinned.sha256 }, `${role} keeps the pinned digest`);
	}
	assert.deepEqual(built.option.keywords, [
		{ tokens: ON_LINE, command: "voice-on" },
		{ tokens: OFF_LINE, command: "voice-off" },
	]);
	assert.deepEqual(
		{ boost: built.option.boost, threshold: built.option.threshold, maxActivePaths: built.option.maxActivePaths, trailingBlanks: built.option.trailingBlanks },
		{ boost: 2, threshold: 0.25, maxActivePaths: 16, trailingBlanks: 2 },
		"the tuning measured in odd/notes/voice-kws.md section 5",
	);
});

test("no keyword option when the spotter is not installed or the keyword file does not parse", async () => {
	const paths = installedPaths();
	assert.deepEqual(await buildVoiceKeywordOption({ voiceHome: "/v", resolvePaths: async () => undefined, readKeywords: async () => `voice-on: ${ON_LINE}` }), { reason: "not-installed" });
	for (const text of [`voice-on: ▁G ENT @voice-on`, "voice-louder: ▁G", "", "voice-on: "]) {
		assert.deepEqual(await buildVoiceKeywordOption({ voiceHome: "/v", resolvePaths: async () => paths, readKeywords: async () => text }), { reason: "keywords-invalid" }, text);
	}
});

interface FakeSpotting {
	readonly order: string[];
	readonly calls: string[];
	readonly starts: number;
	readonly factory: ListenerSpotFactory;
	// The command the open spot-only capture hears.
	hearing(command: string): void;
	// A rejected hit never closes the capture.
	rejectHit(command: string, reason: "lead" | "speech-after"): void;
	// The open spot-only capture dies, as a worker that exited does.
	dying(): void;
}

// A spot-only capture driven by the test: it records the calls the listener made,
// so a test proves the microphone was released before the next capture began.
function fakeSpotting(options: { order?: string[]; failStart?: boolean; stopGate?: Promise<void> } = {}): FakeSpotting {
	const calls: string[] = [];
	let onRejected: ((hit: { command: string; reason: "lead" | "speech-after" }) => void) | undefined;
	let pending: { resolve(command: string | undefined): void; reject(error: unknown): void } | undefined;
	let starts = 0;
	const log = (name: string) => {
		calls.push(name);
		options.order?.push(name);
	};
	const factory: ListenerSpotFactory = (onKeywordRejected) => {
		onRejected = onKeywordRejected;
		starts += 1;
		let settle!: (command: string | undefined) => void;
		let fail!: (error: unknown) => void;
		const heard = new Promise<string | undefined>((resolve, reject) => {
			settle = resolve;
			fail = reject;
		});
		heard.catch(() => {});
		pending = { resolve: settle, reject: fail };
		return {
			start: async () => {
				log("spot.start");
				if (options.failStart) throw new VoiceSessionError("no-input-device");
			},
			heard: () => heard,
			stop: async () => {
				log("spot.stop");
				if (options.stopGate) {
					await options.stopGate;
					log("spot.settled");
				}
				settle(undefined);
			},
			cancel: async () => {
				log("spot.cancel");
				settle(undefined);
			},
		};
	};
	return {
		calls,
		order: options.order ?? calls,
		get starts() {
			return starts;
		},
		factory,
		hearing: (command) => pending?.resolve(command),
		rejectHit: (command, reason) => onRejected?.({ command, reason }),
		dying: () => pending?.reject(new VoiceSessionError("worker-exited")),
	};
}

const waitForState = async (started: Started, state: ListenerState): Promise<void> => waitFor(() => started.listener.state === state);

test("a spoken voice off turns voice off everywhere and is never delivered as text (S4, L10)", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "gentle voice off", command: "voice-off" });
	const started = await startListener(dir, { keyword: keywordOption(), dictation: capture.factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1", true);
	const other = await started.client();
	other.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(asker, "welcome").length === 1 && framesOf(other, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1")).type, "ok");
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	assert.deepEqual(capture.requests[0]?.kws, keywordOption(), "the capture carries the keyword option");
	asker.send({ type: "stop", id: "d2" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d2")).type, "ok");

	// The messages a session gets for a capture with no speech, and nothing else.
	assert.deepEqual(phases(asker), ["recording", "transcribing", "failed"]);
	assert.deepEqual(framesOf(asker, "capture").at(-1), { type: "capture", phase: "failed", code: "no-speech" });
	// The command reaches every session, as a voice off from the menu does (L10).
	assert.deepEqual(framesOf(asker, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(framesOf(other, "command"), [{ type: "command", command: "voice-off" }]);
	await waitForState(started, "asleep");
	assert.deepEqual(states(started.events), ["listening", "transcribing", "asleep"]);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
	assert.deepEqual(started.listener.voiceSessions, [], "voice is off in every session, so the asleep exit is armed");
	// No transcript anywhere: the matcher in the session cannot fire for this capture.
	assert.deepEqual([...framesOf(asker, "transcript"), ...framesOf(other, "transcript")], []);
	// The event name and the command id only: never audio, never a transcript.
	const commands = started.events.filter((entry) => entry.event === "capture.command");
	assert.deepEqual(commands.map((entry) => entry.fields), [{ sessionId: "s-1", mode: "conversation", command: "voice-off" }]);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "whole-utterance" }]);
	assert.equal(JSON.stringify(started.events).includes("gentle voice off"), false, "no transcript reaches the log");
	asker.socket.destroy();
	other.socket.destroy();
	await started.listener.close();
});

test("any other command a capture ends with delivers nothing and changes nothing (S4)", async () => {
	const dir = scratch();
	const commands = ["voice-on", "cancel", "voice-louder"];
	const captures: FakeCapture[] = [];
	const started = await startListener(dir, {
		keyword: keywordOption(),
		dictation: (request) => {
			const capture = fakeCapture({ text: "", command: commands[captures.length] });
			captures.push(capture);
			return capture.factory(request);
		},
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	const asker = await started.client();
	asker.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	for (const [index, command] of commands.entries()) {
		asker.send({ type: "dictate", id: `d${index}`, mode: "conversation" });
		assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === `d${index}`)).type, "ok");
		asker.send({ type: "stop" });
		await waitFor(() => framesOf(asker, "capture").at(-1)?.type === "capture" && (framesOf(asker, "capture").at(-1) as { phase: string }).phase === "failed");
		assert.deepEqual(framesOf(asker, "capture").at(-1), { type: "capture", phase: "failed", code: "no-speech" }, command);
		assert.equal(started.listener.state, "listening", `${command} leaves voice as it was`);
	}
	assert.deepEqual(framesOf(asker, "command"), [], "no command reaches a session");
	assert.deepEqual(framesOf(asker, "transcript"), []);
	assert.equal(JSON.stringify(started.events).includes('"text"'), false);
	asker.socket.destroy();
	await started.listener.close();
});

test("asleep keeps a spot-only capture open, and the keyword wakes the focused session only (S7, L10)", async (t) => {
	const dir = scratch();
	const spot = fakeSpotting();
	const overlay = fakeOverlay();
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, {
		keyword: keywordOption(),
		spot: spot.factory,
		overlay: overlay.overlay,
		cues: cuePlayer(),
		dictation: capture.factory,
		focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
	});
	t.after(() => started.listener.close());
	// A fresh listener is asleep, so it listens for the keyword from the start.
	await waitFor(() => spot.starts === 1);
	const quiet = await started.client();
	quiet.hello("s-1", "w1:p1", true);
	const focused = await started.client();
	focused.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(quiet, "welcome").length === 1 && framesOf(focused, "welcome").length === 1);
	quiet.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => framesOf(quiet, "ok").length === 1);
	assert.equal(started.listener.state, "asleep");
	assert.equal(spot.starts, 1, "the spot capture that was already open keeps listening");

	spot.hearing("voice-on");
	await waitForState(started, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-2"], "only the focused session gets voice back");
	// The wake is addressed to the session it woke: broadcast, every session with
	// voice on would open its own conversation over one microphone (S7).
	assert.deepEqual(framesOf(focused, "command").at(-1), { type: "command", command: "voice-on", wake: true }, "the session that woke is told it was a wake");
	assert.deepEqual(
		framesOf(quiet, "command"),
		[
			{ type: "command", command: "voice-off" },
			{ type: "command", command: "voice-on" },
		],
		"a session that did not wake only learns that voice is on: no wake flag, nothing to start",
	);
	// The wake itself claims nothing: nothing records yet, so no cue plays, and the
	// window has no listening form to draw without a microphone.
	assert.deepEqual(cueLog(started.events), [], "the wake plays no cue of its own");
	assert.deepEqual(
		overlay.snapshots.at(-1),
		{ state: "listening", language: "es", recording: false },
		"the state the window gets, which it draws nothing for while nothing records",
	);
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(spot.calls, ["spot.start", "spot.start"], "the wake consumes the old spot capture and opens the awake one");
	const command = started.events.filter((entry) => entry.event.startsWith("kws."));
	assert.deepEqual(command.map((entry) => [entry.event, entry.fields]), [
		["kws.hit", { command: "voice-on", reason: "whole-utterance" }],
		["kws.wake", { sessionId: "s-2" }],
	]);

	// The microphone the wake session then opens is where the cue comes from: one
	// open cue, played by the listener because it is the one recording (S10).
	focused.send({ type: "dictate", id: "d1", mode: "conversation" });
	assert.equal((await awaitFrame(focused, (frame) => "id" in frame && frame.id === "d1")).type, "ok");
	assert.deepEqual(
		cueLog(started.events).map((entry) => [entry?.name, entry?.mode, entry?.sessionId]),
		[["open", "conversation", "s-2"]],
		"exactly one open cue, from the capture that records",
	);
	quiet.socket.destroy();
	focused.socket.destroy();
	await started.listener.close();
});

test("a wake with nobody focused, a failed lookup or an absent pane turns nothing on and keeps spotting (S7, L10)", async () => {
	for (const focus of [
		{ focusedPaneId: async () => ({ focused: undefined }) },
		{ focusedPaneId: async () => ({ failed: true as const }) },
		{ focusedPaneId: async () => ({ focused: "w9:p9" }) },
	]) {
		const dir = scratch();
		const spot = fakeSpotting();
		const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer(), focus });
		await waitFor(() => spot.starts === 1);
		const client = await started.client();
		client.hello("s-1", "w1:p1", false);
		await waitFor(() => framesOf(client, "welcome").length === 1);

		spot.hearing("voice-on");
		await waitFor(() => spot.starts === 2);
		assert.equal(started.listener.state, "asleep", "nothing turned on, so it stays asleep");
		assert.deepEqual(started.listener.voiceSessions, [], "no session was woken");
		assert.deepEqual(framesOf(client, "command"), []);
		assert.deepEqual(cueLog(started.events), [], "nothing woke, so no cue plays");
		assert.equal(started.events.some((entry) => entry.event === "capture.begin"), false, "and nothing starts a recording");
		client.socket.destroy();
		await started.listener.close();
	}
});

test("anything heard while asleep other than a wake changes nothing and keeps spotting (S7)", async () => {
	const dir = scratch();
	const spot = fakeSpotting();
	const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	await waitFor(() => spot.starts === 1);
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	for (const [index, command] of ["voice-off", "cancel", "voice-louder"].entries()) {
		spot.hearing(command);
		await waitFor(() => spot.starts === index + 2);
		assert.equal(started.listener.state, "asleep", command);
		assert.deepEqual(started.listener.voiceSessions, [], command);
	}
	assert.deepEqual(framesOf(client, "command"), [], "nothing is decided for the sessions");
	assert.deepEqual(cueLog(started.events), []);
	// The worker closes a spot capture itself once it hears a keyword, so the listener
	// only opens the next one: nothing is left recording behind it.
	assert.deepEqual(spot.calls, ["spot.start", "spot.start", "spot.start", "spot.start"]);
	client.socket.destroy();
	await started.listener.close();
});

test("a session that asks for a capture takes the microphone from the spotter, and spotting resumes afterwards (S7)", async () => {
	const dir = scratch();
	const order: string[] = [];
	const spot = fakeSpotting({ order });
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, {
		keyword: keywordOption(),
		spot: spot.factory,
		dictation: (request) => {
			order.push("capture");
			return capture.factory(request);
		},
		cues: cuePlayer(),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	await waitFor(() => spot.starts === 1);
	const asker = await started.client();
	asker.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(asker, "welcome").length === 1);

	asker.send({ type: "dictate", id: "d1", mode: "dictation" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1")).type, "ok");
	assert.deepEqual(order, ["spot.start", "spot.stop", "capture"], "the microphone is released before the recording begins");
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop"]);
	// The dictation heard no command: it is delivered as it always was.
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "transcript"), { type: "transcript", text: "hola" });
	// Asleep again once the microphone closes, so the spotter takes it back.
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(order, ["spot.start", "spot.stop", "capture", "spot.start"]);
	asker.socket.destroy();
	await started.listener.close();
});

test("spotting continues while a reply is read and afterwards (S14)", async (t) => {
	const dir = scratch();
	const spot = fakeSpotting();
	const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, readTailMs: 20, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	await waitFor(() => spot.starts === 1);
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(reader, "welcome").length === 1);

	reader.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 20 });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r1")).type, "granted");
	assert.deepEqual(spot.calls, ["spot.start"], "the spot capture remains open during the reading");
	assert.equal(spot.starts, 1);
	reader.send({ type: "read-end", id: "r2", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r2");
	await waitFor(() => started.listener.state !== "reading", 2_000);
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop", "spot.start"], "a fresh capture starts only after the reading's tail is retired");
	reader.socket.destroy();
	await started.listener.close();
});

test("a spotter that cannot start, or that dies, is logged once and voice carries on (S7)", async () => {
	const dir = scratch();
	const spot = fakeSpotting({ failStart: true });
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	assert.equal(started.listener.state, "listening", "voice can wake without a working spotter");
	// Voice works as it always did: a capture records, transcribes and delivers.
	client.send({ type: "dictate", id: "d1", mode: "dictation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d1")).type, "ok");
	client.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "transcript"), { type: "transcript", text: "hola" });
	// Leaving asleep and coming back never retries the spotter.
	client.send({ type: "wake", id: "w1" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "w1");
	client.send({ type: "sleep", id: "s1" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "s1");
	await waitFor(() => started.listener.state === "asleep");
	assert.equal(spot.starts, 1, "a spotter that failed once is never asked again");
	const failed = started.events.filter((entry) => entry.event === "kws.failed");
	assert.deepEqual(failed.map((entry) => entry.fields), [{ reason: "no-input-device" }], "only the fixed error code is logged");
	client.socket.destroy();
	await started.listener.close();

	// A spot capture that dies mid-listen is the same failure.
	const secondDir = scratch();
	const dying = fakeSpotting();
	const listener = await startListener(secondDir, { keyword: keywordOption(), spot: dying.factory, cues: cuePlayer() });
	await waitFor(() => dying.starts === 1);
	dying.dying();
	await waitFor(() => listener.events.some((entry) => entry.event === "kws.failed"));
	assert.equal(listener.listener.state, "asleep");
	assert.equal(dying.starts, 1);
	assert.deepEqual(listener.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "worker-exited" }]);
	await listener.listener.close();
});

test("without the keyword option the listener never opens a spot capture", async () => {
	const dir = scratch();
	const spot = fakeSpotting();
	const started = await startListener(dir, { spot: spot.factory, dictation: fakeCapture().factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	assert.equal(started.listener.state, "listening");
	assert.equal(spot.starts, 0, "no model means no awake spot capture");
	client.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => started.listener.state === "asleep");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(spot.starts, 0);
	assert.deepEqual(spot.calls, []);
	client.socket.destroy();
	await started.listener.close();
});

test("the ten minute asleep exit closes the spot capture with everything else (L10, S7)", async () => {
	const dir = scratch();
	const spot = fakeSpotting();
	const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, asleepIdleMs: 40 });
	await waitFor(() => spot.starts === 1);
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1);
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "bye", 3_000), { type: "bye", reason: "idle" });
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop"], "the microphone is released with the listener");
	await waitFor(() => !existsSync(listenerPaths(dir).lock));
	client.socket.destroy();
	await started.listener.close();
});

// A hands-free recording ends by itself: the worker hears the end of speech (or
// reaches its limit) and reports it. Nobody asks to stop, so the listener must
// collect the transcript on its own, or it waits for a stop that never comes
// while the session waits for a transcript that is never sent.
function selfEndingCapture(options: { text?: string; error?: VoiceSessionErrorCode; command?: string } = {}) {
	const calls: string[] = [];
	let notify: (state: VoiceSessionState) => void = () => {};
	return {
		calls,
		// The worker's own edges, as the warm worker reports them without a stop.
		endsByItself: (finished = true) => {
			notify("transcribing");
			if (finished) notify("finished");
		},
		dies: () => notify("finished"),
		factory: (request: ListenerDictationRequest): ListenerDictation => {
			notify = request.onStateChange;
			return {
				start: async () => {
					calls.push("start");
					notify("recording");
				},
				// The outcome is already known: stop only hands it over.
				stop: async () => {
					calls.push("stop");
					if (options.error) throw new VoiceSessionError(options.error);
					return { text: options.text ?? "hola", truncated: false, ...(options.command === undefined ? {} : { command: options.command }) };
				},
				cancel: async () => {
					calls.push("cancel");
				},
			};
		},
	};
}

test("a recording the worker ends by itself is transcribed and delivered without anyone asking to stop", async () => {
	const capture = selfEndingCapture({ text: "seguí con eso" });
	const cues = { player: cuePlayer() };
	const started = await startListener(scratch(), { dictation: capture.factory, cues: cues.player, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");

	capture.endsByItself();
	const transcript = await awaitFrame(asker, (frame) => frame.type === "transcript");
	assert.deepEqual(transcript, { type: "transcript", text: "seguí con eso" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered");
	assert.deepEqual(capture.calls, ["start", "stop"], "the listener collected it once, by itself");
	await waitFor(() => cueLog(started.events).length === 2);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
	await waitFor(() => started.listener.state === "listening");
	assert.deepEqual(states(started.events).slice(-2), ["transcribing", "listening"], "it never stays in transcribing");
	assert.equal(started.events.some((entry) => entry.event === "capture.end" && entry.fields?.phase === "delivered"), true);

	// A stop that arrives after that is answered, and the next capture starts.
	asker.send({ type: "stop", id: "s1" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "s1");
	asker.send({ type: "dictate", id: "d2", mode: "conversation" });
	const second = await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d2");
	assert.equal(second.type, "ok");
	asker.socket.destroy();
	await started.listener.close();
});

test("a stop that arrives while the listener is already collecting is answered once the outcome is known", async () => {
	const capture = selfEndingCapture({ text: "hola" });
	let releaseFocus!: () => void;
	const focusGate = new Promise<void>((resolve) => { releaseFocus = resolve; });
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => { await focusGate; return { focused: "w1:p1" }; } } });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "dictation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");

	capture.endsByItself();
	await waitFor(() => capture.calls.includes("stop"));
	asker.send({ type: "stop", id: "s1" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(asker.frames.some((frame) => "id" in frame && frame.id === "s1"), false, "not answered before the transcript went out");
	releaseFocus();
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "s1");
	const order = asker.frames.map((frame) => (frame.type === "transcript" ? "transcript" : "id" in frame && frame.id === "s1" ? "stop-answer" : "")).filter(Boolean);
	assert.deepEqual(order, ["transcript", "stop-answer"]);
	assert.deepEqual(capture.calls, ["start", "stop"], "collected once");
	asker.socket.destroy();
	await started.listener.close();
});

// S14: the background spotter is invisible and a voice-off hit reaches every session.
test("a voice-on hello or update wakes idle spotting; voice-off and a voice-off hello stay asleep", async (t) => {
	const spot = fakeSpotting();
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, overlay: overlay.overlay, cues: cuePlayer() });
	t.after(() => started.listener.close());
	await waitFor(() => spot.starts === 1);
	const first = await started.client();
	first.hello("s-1", "w1:p1", true);
	await awaitFrame(first, (frame) => frame.type === "welcome");
	await waitFor(() => started.listener.state === "listening");
	const second = await started.client();
	second.hello("s-2", "w1:p2", true);
	await awaitFrame(second, (frame) => frame.type === "welcome");
	assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"]);
	assert.equal(spot.starts, 1, "the already-open spot-only capture stays open");
	assert.deepEqual(cueLog(started.events), []);
	assert.ok(overlay.snapshots.every((snapshot) => !snapshot.recording));
	assert.deepEqual(overlay.levels, []);
	spot.hearing("voice-off");
	await waitFor(() => started.listener.state === "asleep" && framesOf(first, "command").length === 1 && framesOf(second, "command").length === 1);
	assert.deepEqual(framesOf(first, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(framesOf(second, "command"), [{ type: "command", command: "voice-off" }]);
	const quiet = await started.client();
	quiet.hello("s-3", "w1:p3", false);
	await awaitFrame(quiet, (frame) => frame.type === "welcome");
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	quiet.send({ type: "set-voice", id: "on", voiceOn: true });
	await awaitFrame(quiet, (frame) => "id" in frame && frame.id === "on");
	await waitFor(() => started.listener.state === "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-3"]);
	assert.deepEqual([...framesOf(first, "transcript"), ...framesOf(second, "transcript"), ...framesOf(quiet, "transcript")], []);
	assert.deepEqual(cueLog(started.events), []);
	assert.ok(overlay.snapshots.every((snapshot) => !snapshot.recording));
	first.socket.destroy();
	second.socket.destroy();
	quiet.socket.destroy();
});

test("awake spotting logs a voice-on without a focused session and still turns voice off everywhere", async (t) => {
	const spot = fakeSpotting();
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, overlay: overlay.overlay, cues: cuePlayer() });
	t.after(() => started.listener.close());
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", true);
	second.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	first.send({ type: "wake", id: "wake" });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "wake");
	await waitFor(() => spot.starts >= 1 && started.listener.state === "listening");
	const starts = spot.starts;
	spot.rejectHit("voice-off", "lead");
	spot.rejectHit("voice-off", "speech-after");
	spot.hearing("voice-on");
	await waitFor(() => spot.starts === starts + 1);
	assert.deepEqual(framesOf(first, "command"), []);
	assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"]);
	spot.hearing("voice-off");
	await waitFor(() => started.listener.state === "asleep" && framesOf(first, "command").length === 1 && framesOf(second, "command").length === 1);
	assert.deepEqual(framesOf(first, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(framesOf(second, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [
		{ command: "voice-off", reason: "rejected:lead" },
		{ command: "voice-off", reason: "rejected:speech-after" },
		{ command: "voice-on", reason: "ignored:no-focused-voice-session" },
		{ command: "voice-off", reason: "whole-utterance" },
	]);
	assert.deepEqual([...framesOf(first, "transcript"), ...framesOf(second, "transcript"), ...framesOf(first, "capture"), ...levelFrames(first)], []);
	assert.deepEqual(overlay.levels, []);
	assert.ok(overlay.snapshots.every((snapshot) => !snapshot.recording));
	assert.deepEqual(cueLog(started.events), []);
	first.socket.destroy();
	second.socket.destroy();
});

test("awake voice-on opens a conversation only for the focused voice-on session (S15)", async (t) => {
	const spot = fakeSpotting();
	const capture = fakeCapture({ text: "seguí por favor" });
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory, dictation: capture.factory,
		cues: cuePlayer(), overlay: overlay.overlay,
		focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
	});
	t.after(() => started.listener.close());
	const other = await started.client();
	const focused = await started.client();
	other.hello("s-1", "w1:p1", true);
	focused.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(other, "welcome").length === 1 && framesOf(focused, "welcome").length === 1 && spot.starts === 1);
	spot.hearing("voice-on");
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "whole-utterance" }]);
	assert.deepEqual(await awaitFrame(focused, (frame) => frame.type === "command"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(framesOf(other, "command"), [], "no other session starts a capture");
	assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"], "the hit does not change voice settings");
	focused.send({ type: "dictate", id: "d", mode: "conversation", endpoint: { endOfSpeechMs: 2500, noSpeechMs: 8000 } });
	assert.equal((await awaitFrame(focused, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	assert.equal(capture.requests[0]?.mode, "conversation");
	assert.deepEqual(capture.requests[0]?.endpoint, { endOfSpeechMs: 2500, noSpeechMs: 8000 });
	assert.ok(overlay.snapshots.some((snapshot) => snapshot.state === "listening" && snapshot.recording && snapshot.paneId === "w1:p2"));
	assert.deepEqual(cueLog(started.events).map((cue) => [cue?.name, cue?.sessionId]), [["open", "s-2"]]);
	assert.deepEqual(started.events.filter((entry) => entry.event === "capture.begin").map((entry) => entry.fields), [{ sessionId: "s-2", mode: "conversation", clients: 2 }]);
	focused.send({ type: "stop", id: "s" });
	await awaitFrame(focused, (frame) => "id" in frame && frame.id === "s");
	assert.deepEqual(framesOf(focused, "transcript"), [{ type: "transcript", text: "seguí por favor" }]);
	assert.deepEqual(framesOf(other, "transcript"), []);
});

test("T19-R1/R2: commands stay audible while an awake wake prepares, without replacing its reservation (S14)", async (t) => {
	const spot = fakeSpotting();
	const capture = fakeCapture();
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(() => started.listener.close());
	const owner = await started.client();
	const reader = await started.client();
	owner.hello("s-1", "w1:p1", true);
	reader.hello("s-2", "w1:p2", true, "reading");
	await waitFor(() => framesOf(owner, "welcome").length === 1 && framesOf(reader, "welcome").length === 1 && spot.starts === 1);
	spot.hearing("voice-on");
	await awaitFrame(owner, (frame) => frame.type === "command" && frame.wake === true);
	await waitFor(() => spot.starts === 2, 500);
	spot.hearing("voice-on");
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit" && entry.fields?.reason === "ignored:stale"));
	await waitFor(() => spot.starts === 3);
	assert.equal(framesOf(owner, "command").length, 1, "a repeated hit does not replace the first wake");
	reader.send({ type: "read-begin", id: "r", readingId: "reply", chars: 10 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r"), { type: "busy", id: "r", reason: "capture", holder: "s-1" });
	spot.hearing("voice-off");
	await awaitFrame(owner, (frame) => frame.type === "command" && frame.command === "voice-off");
	assert.ok(started.events.some((entry) => entry.event === "wake.dropped" && entry.fields?.reason === "ignored:voice-off"));
	owner.send({ type: "cancel", id: "c" });
	await awaitFrame(owner, (frame) => "id" in frame && frame.id === "c");
	await waitFor(() => spot.starts === 4);
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(cueLog(started.events), []);
});

test("T19-R1: an off-on change during the fresh focus check cannot revive the accepted wake", async (t) => {
	let release!: () => void;
	let checks = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting();
	const capture = fakeCapture();
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(),
		focus: { focusedPaneId: async () => { if (++checks > 1) await gate; return { focused: "w1:p1" }; } },
	});
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && spot.starts === 1);
	spot.hearing("voice-on");
	await awaitFrame(client, (frame) => frame.type === "command" && frame.wake === true);
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	await waitFor(() => checks === 2);
	await sendSessionVoice(client, false);
	await sendSessionVoice(client, true);
	release();
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	assert.deepEqual(framesOf(client, "capture"), [{ type: "capture", phase: "cancelled" }]);
	assert.ok(started.events.some((entry) => entry.event === "wake.dropped" && entry.fields?.reason === "ignored:voice-off"));
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(cueLog(started.events), []);
	assert.deepEqual(framesOf(client, "transcript"), []);
});

test("T19-R2: cancelling a wake during a pending focus check releases a different session's reading", async (t) => {
	let release!: () => void;
	let checks = 0;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting();
	const capture = fakeCapture();
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(),
		focus: { focusedPaneId: async () => { if (++checks > 1) await gate; return { focused: "w1:p1" }; } },
	});
	t.after(() => { release(); return started.listener.close(); });
	const owner = await started.client();
	const reader = await started.client();
	owner.hello("s-1", "w1:p1", true);
	reader.hello("s-2", "w1:p2", true, "reading");
	await waitFor(() => framesOf(owner, "welcome").length === 1 && framesOf(reader, "welcome").length === 1 && spot.starts === 1);
	spot.hearing("voice-on");
	await awaitFrame(owner, (frame) => frame.type === "command" && frame.wake === true);
	reader.send({ type: "read-begin", id: "r1", readingId: "reply", chars: 10 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r1"), { type: "busy", id: "r1", reason: "capture", holder: "s-1" });
	owner.send({ type: "dictate", id: "d", mode: "conversation" });
	await waitFor(() => checks === 2);
	owner.send({ type: "cancel", id: "c" });
	assert.equal((await awaitFrame(owner, (frame) => "id" in frame && frame.id === "c")).type, "ok");
	reader.send({ type: "read-begin", id: "r2", readingId: "reply", chars: 10 });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r2")).type, "granted", "a cancelled focus lookup cannot reserve the microphone indefinitely");
	release();
	assert.equal((await awaitFrame(owner, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(cueLog(started.events), []);
	assert.equal(started.listener.readingSession, "s-2");
});

test("awake voice-on with no focused voice-on session is ignored without changing state (S15)", async (t) => {
	for (const scenario of ["unknown", "failed", "absent", "off", "reader-only"] as const) {
		await t.test(scenario, async (st) => {
			const spot = fakeSpotting();
			const capture = fakeCapture();
			const overlay = fakeOverlay();
			const focus: ListenerFocus = { focusedPaneId: async () => scenario === "failed" ? { failed: true } : { focused: scenario === "unknown" ? undefined : scenario === "absent" ? "w9:p9" : "w1:p2" } };
			const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), overlay: overlay.overlay, focus });
			st.after(() => started.listener.close());
			const voiced = await started.client();
			voiced.hello("s-1", "w1:p1", true);
			const other = await started.client();
			other.hello("s-2", "w1:p2", scenario === "reader-only", scenario === "reader-only" ? "reading" : "session");
			await waitFor(() => framesOf(voiced, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
			const voiceBefore = [...started.listener.voiceSessions];
			spot.hearing("voice-on");
			await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
			assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "ignored:no-focused-voice-session" }]);
			await waitFor(() => spot.starts === 2);
			assert.deepEqual(started.listener.voiceSessions, voiceBefore);
			assert.equal(started.listener.state, "listening");
			assert.deepEqual([...framesOf(voiced, "command"), ...framesOf(other, "command"), ...framesOf(voiced, "transcript"), ...framesOf(other, "transcript")], []);
			assert.deepEqual(capture.calls, []);
			assert.deepEqual(cueLog(started.events), []);
			assert.ok(overlay.snapshots.every((snapshot) => !snapshot.recording));
		});
	}
});

test("a reading that starts while an awake voice-on focus lookup is pending wins (S14, JD-A-002)", async (t) => {
	let release!: () => void;
	let asked = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting();
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory,
		focus: { focusedPaneId: async () => { asked = true; await gate; return { focused: "w1:p1" }; } },
	});
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && spot.starts === 1);
	spot.hearing("voice-on");
	await waitFor(() => asked || started.events.some((entry) => entry.event === "kws.hit"));
	assert.equal(asked, true, "a voice-on hit resolves the focus");
	client.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "r")).type, "granted");
	release();
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "ignored:reading" }]);
	assert.deepEqual(framesOf(client, "command"), []);
	assert.equal(started.listener.readingSession, "s-1");
});

test("an awake voice-on focus result cannot revive an off session or open over a newer capture", async (t) => {
	for (const change of ["voice-off", "voice-off-last", "capture"] as const) {
		await t.test(change, async (st) => {
			let release!: () => void;
			let asked = false;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const spot = fakeSpotting();
			const capture = fakeCapture();
			const started = await startListener(scratch(), {
				keyword: keywordOption(), spot: spot.factory, dictation: capture.factory,
				focus: { focusedPaneId: async () => { asked = true; await gate; return { focused: "w1:p1" }; } },
			});
			st.after(() => { release(); return started.listener.close(); });
			const focused = await started.client();
			const other = await started.client();
			focused.hello("s-1", "w1:p1", true);
			other.hello("s-2", "w1:p2", change !== "voice-off-last");
			await waitFor(() => framesOf(focused, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
			spot.hearing("voice-on");
			await waitFor(() => asked);
			if (change !== "capture") {
				focused.send({ type: "session-voice", voiceOn: false });
				await waitFor(() => !started.listener.voiceSessions.includes("s-1"));
			} else {
				other.send({ type: "dictate", id: "d", mode: "conversation" });
				assert.equal((await awaitFrame(other, (frame) => "id" in frame && frame.id === "d")).type, "ok");
			}
			release();
			await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
			assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: change === "capture" ? "ignored:stale" : "ignored:no-focused-voice-session" }]);
			assert.deepEqual([...framesOf(focused, "command"), ...framesOf(other, "command")], []);
			assert.equal(capture.calls.filter((call) => call === "start").length, change === "capture" ? 1 : 0);
		});
	}
});

test("awake spotting is replaced by asleep spotting when the last session leaves or is rejected", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory });
	t.after(() => started.listener.close());
	const first = await started.client();
	first.hello("s-1", "w1:p1", true);
	await awaitFrame(first, (frame) => frame.type === "welcome");
	first.send({ type: "wake", id: "w" });
	await awaitFrame(first, (frame) => "id" in frame && frame.id === "w");
	first.socket.destroy();
	await waitFor(() => spot.starts === 2 && started.listener.clientCount === 0);
	assert.equal(started.listener.state, "asleep");
	const second = await started.client();
	second.hello("s-2", "w1:p2", true);
	await awaitFrame(second, (frame) => frame.type === "welcome");
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop", "spot.start"]);
	assert.deepEqual(framesOf(second, "transcript"), []);
	second.socket.write("not-json\n");
	await second.closed;
	await waitFor(() => spot.starts === 3);
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop", "spot.start", "spot.stop", "spot.start"]);
	assert.equal(started.listener.state, "asleep");
	assert.equal(started.listener.voiceSessions.length, 0, "rejecting the last client releases awake spotting too");
});

test("a reading-only hello with voice off registers without waking", async (t) => {
	const started = await startListener(scratch());
	t.after(() => started.listener.close());
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", false, "reading");
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	reader.send({ type: "status", id: "barrier" });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "barrier"), {
		type: "snapshot", id: "barrier", state: "asleep", listenerPid: process.pid, clients: 1, sessions: ["s-1"],
	});
	assert.deepEqual(started.listener.voiceSessions, []);
	reader.send({ type: "read-begin", id: "read", readingId: "read-1", chars: 5 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "read"), { type: "busy", id: "read", reason: "asleep" });
});

let sessionVoiceBarrier = 0;
async function sendSessionVoice(client: Client, voiceOn: boolean): Promise<void> {
	const id = `session-voice-barrier-${sessionVoiceBarrier++}`;
	client.socket.write(`${JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, type: "session-voice", voiceOn })}\n`);
	client.send({ type: "status", id });
	const answer = await awaitFrame(client, (frame) => frame.type === "error" || ("id" in frame && frame.id === id));
	assert.equal(answer.type, "snapshot", `session-voice must not close the link: ${JSON.stringify(answer)}`);
}

test("a session joining after a reader owns its voice and the reader cannot override it", async (t) => {
	const started = await startListener(scratch());
	t.after(() => started.listener.close());
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);

	const session = await started.client();
	session.hello("s-1", "w1:p1", false, "session");
	await awaitFrame(session, (frame) => frame.type === "welcome");
	session.send({ type: "status", id: "joined" });
	await awaitFrame(session, (frame) => "id" in frame && frame.id === "joined");
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	await sendSessionVoice(reader, true);
	assert.equal(started.listener.state, "asleep", "a reader update is not session authority");
	assert.deepEqual(started.listener.voiceSessions, []);
	await sendSessionVoice(session, true);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	const replacement = await started.client();
	replacement.hello("s-1", "w1:p1", false, "reading");
	await awaitFrame(replacement, (frame) => frame.type === "welcome");
	await reader.closed;
	assert.equal(started.listener.state, "listening", "a stale off hello cannot change an on session");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	await sendSessionVoice(replacement, false);
	assert.equal(started.listener.state, "listening", "a reader cannot turn an on session off either");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	await sendSessionVoice(session, false);
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.deepEqual([...framesOf(reader, "command"), ...framesOf(replacement, "command"), ...framesOf(session, "command")], []);
});

test("session-voice updates only its session across both connection roles, without a broadcast", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory });
	t.after(() => started.listener.close());
	const first = await started.client();
	const reading = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", true, "session");
	reading.hello("s-1", "w1:p1", true, "reading");
	second.hello("s-2", "w1:p2", true);
	await waitFor(() => [first, reading, second].every((client) => framesOf(client, "welcome").length === 1) && spot.starts === 1);
	await sendSessionVoice(first, false);
	assert.deepEqual(started.listener.voiceSessions, ["s-2"]);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual([...framesOf(first, "command"), ...framesOf(reading, "command"), ...framesOf(second, "command")], []);
	assert.deepEqual(spot.calls, ["spot.start"], "another session keeps awake spotting open");
	second.socket.destroy();
	await waitFor(() => started.listener.state === "asleep" && spot.starts === 2);
	assert.deepEqual(started.listener.voiceSessions, [], "the reading connection cannot retain a stale voice-on flag");
	assert.deepEqual(framesOf(first, "transcript"), []);
});

test("session-voice false on the last session waits for spot teardown before wake spotting", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting({ stopGate: gate });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) } });
	t.after(() => { release(); return started.listener.close(); });
	const first = await started.client();
	const focused = await started.client();
	first.hello("s-1", "w1:p1", true);
	focused.hello("s-2", "w1:p2", false);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(focused, "welcome").length === 1 && spot.starts === 1);
	await sendSessionVoice(first, false);
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop"]);
	assert.deepEqual([...framesOf(first, "command"), ...framesOf(focused, "command")], []);
	spot.hearing("voice-on");
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "ignored:stale" }]);
	assert.equal(spot.starts, 1, "the old microphone is still closing");
	release();
	await waitFor(() => spot.starts === 2);
	spot.hearing("voice-on");
	assert.deepEqual(await awaitFrame(focused, (frame) => frame.type === "command"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(started.listener.voiceSessions, ["s-2"]);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(framesOf(first, "command"), [{ type: "command", command: "voice-on" }]);
	assert.deepEqual([...framesOf(first, "transcript"), ...framesOf(focused, "transcript")], []);
	assert.deepEqual(cueLog(started.events), []);
});

test("session-voice true while asleep wakes idle without a cue or command", async (t) => {
	const spot = fakeSpotting();
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, overlay: overlay.overlay, cues: cuePlayer() });
	t.after(() => started.listener.close());
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1 && spot.starts === 1);
	await sendSessionVoice(client, true);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "command"), []);
	assert.deepEqual(cueLog(started.events), []);
	assert.deepEqual(spot.calls, ["spot.start"]);
	assert.deepEqual(overlay.snapshots.at(-1), { state: "listening", language: "es", recording: false });
});

test("session-voice before hello is rejected without changing voice", async (t) => {
	const started = await startListener(scratch());
	t.after(() => started.listener.close());
	const client = await started.client();
	client.socket.write(`${JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, type: "session-voice", voiceOn: true })}\n`);
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "error"), { type: "error", code: "bad-hello" });
	await client.closed;
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.equal(started.listener.state, "asleep");
});

test("session-voice last-owner graceful close, disconnect and rejection wait for awake spot teardown", async (t) => {
	for (const ending of ["close", "disconnect", "reject"] as const) {
		await t.test(ending, async (st) => {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const spot = fakeSpotting({ stopGate: gate });
			const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) } });
			st.after(() => { release(); return started.listener.close(); });
			const owner = await started.client();
			const quiet = await started.client();
			owner.hello("s-1", "w1:p1", true);
			quiet.hello("s-2", "w1:p2", false);
			await waitFor(() => framesOf(owner, "welcome").length === 1 && framesOf(quiet, "welcome").length === 1 && spot.starts === 1);
			if (ending === "close") owner.socket.end();
			else if (ending === "disconnect") owner.socket.destroy();
			else owner.socket.write("not-json\n");
			await waitFor(() => spot.calls.includes("spot.stop") && started.listener.clientCount === 1);
			assert.equal(started.listener.state, "asleep");
			assert.deepEqual(started.listener.voiceSessions, []);
			assert.equal(spot.starts, 1, "the old spotter still owns the microphone");
			assert.deepEqual(framesOf(quiet, "command"), []);
			release();
			await waitFor(() => spot.starts === 2);
			spot.hearing("voice-on");
			assert.deepEqual(await awaitFrame(quiet, (frame) => frame.type === "command"), { type: "command", command: "voice-on", wake: true });
			assert.deepEqual(started.listener.voiceSessions, ["s-2"]);
		});
	}
});

test("session-voice replacement keeps an on-to-on connection awake and sleeps for on-to-off", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory });
	t.after(() => started.listener.close());
	const first = await started.client();
	first.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(first, "welcome").length === 1 && spot.starts === 1);
	const replacement = await started.client();
	replacement.hello("s-1", "w1:p1", true);
	await awaitFrame(replacement, (frame) => frame.type === "welcome");
	assert.deepEqual(await awaitFrame(first, (frame) => frame.type === "bye"), { type: "bye", reason: "replaced" });
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(spot.calls, ["spot.start"], "an equivalent reload never churns the microphone");
	const quiet = await started.client();
	quiet.hello("s-1", "w1:p1", false);
	await awaitFrame(quiet, (frame) => frame.type === "welcome");
	assert.deepEqual(await awaitFrame(replacement, (frame) => frame.type === "bye"), { type: "bye", reason: "replaced" });
	await waitFor(() => started.listener.state === "asleep" && spot.starts === 2);
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.deepEqual(framesOf(quiet, "command"), []);
});

test("session-voice replacement of an active reader receives welcome before any other frame", async (t) => {
	const started = await startListener(scratch(), { readTailMs: 50 });
	t.after(() => started.listener.close());
	const original = await started.client();
	original.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(original, (frame) => frame.type === "welcome");
	original.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(original, (frame) => "id" in frame && frame.id === "r");
	const replacement = await started.client();
	replacement.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(replacement, (frame) => frame.type === "welcome");
	assert.equal(replacement.frames[0]?.type, "welcome", "no old-reading release precedes the handshake");
	assert.deepEqual(await awaitFrame(original, (frame) => frame.type === "bye"), { type: "bye", reason: "replaced" });
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
});

test("awake spotting settles before dictation and resumes only after that capture ends", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const order: string[] = [];
	const spot = fakeSpotting({ order, stopGate: gate });
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory,
		dictation: (request) => { order.push("capture.start"); return capture.factory(request); },
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "wake", id: "w" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "w");
	await waitFor(() => spot.calls.includes("spot.start"));
	client.send({ type: "dictate", id: "d", mode: "dictation" });
	await waitFor(() => order.includes("spot.stop"));
	assert.equal(order.includes("capture.start"), false, "the previous microphone has not closed");
	assert.equal(client.frames.some((frame) => "id" in frame && frame.id === "d"), false);
	release();
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	assert.deepEqual(order.slice(0, 3), ["spot.start", "spot.stop", "spot.settled"]);
	assert.equal(order[3], "capture.start");
	client.send({ type: "stop", id: "s" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "s");
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "hola" }]);
	assert.equal(order.at(-1), "spot.start");
	client.socket.destroy();
});

test("all commands during an unknown reading and its audible tail are ignored and logged (S14, L21)", async (t) => {
	const spot = fakeSpotting();
	const overlay = fakeOverlay();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, overlay: overlay.overlay, readTailMs: 500 });
	t.after(() => started.listener.close());
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	reader.send({ type: "wake", id: "w" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "w");
	reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r")).type, "granted");
	let starts = spot.starts;
	spot.hearing("voice-off");
	starts += 1;
	await waitFor(() => spot.starts === starts);
	assert.equal(started.listener.readingSession, "s-1");
	spot.hearing("voice-on");
	starts += 1;
	await waitFor(() => spot.starts === starts);
	reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
	spot.hearing("voice-off");
	starts += 1;
	await waitFor(() => spot.starts === starts);
	spot.hearing("voice-on");
	await waitFor(() => spot.starts === starts + 1);
	await waitFor(() => started.listener.state === "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(reader, "command"), []);
	assert.deepEqual(framesOf(reader, "transcript"), []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [
		{ command: "voice-off", reason: "ignored:reading" },
		{ command: "voice-on", reason: "ignored:reading" },
		{ command: "voice-off", reason: "ignored:reading" },
		{ command: "voice-on", reason: "ignored:reading" },
	]);
	assert.ok(overlay.snapshots.every((snapshot) => !snapshot.recording));
	assert.deepEqual(overlay.levels, []);
	reader.socket.destroy();
});

test("a hit from a reading cannot arrive late and turn voice off after its tail (S14, L21)", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting({ stopGate: gate });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, readTailMs: 20 });
	t.after(() => { release(); return started.listener.close(); });
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r");
	reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
	await waitFor(() => spot.calls.includes("spot.stop"));
	spot.hearing("voice-off");
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "ignored:stale" }]);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(reader, "command"), []);
	assert.deepEqual(framesOf(reader, "transcript"), []);
	assert.equal(spot.starts, 1, "the replacement waits for the old microphone to close");
	release();
	await waitFor(() => spot.starts === 2);
	spot.hearing("voice-off");
	assert.deepEqual(await awaitFrame(reader, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.deepEqual(started.listener.voiceSessions, []);
	reader.socket.destroy();
});

test("JD-A-006: a command from a dictation started in the reading tail is ignored, even when reported late", async (t) => {
	for (const timing of ["in tail", "after tail"] as const) {
		await t.test(timing, async (st) => {
			const spot = fakeSpotting();
			const capture = selfEndingCapture({ text: "never delivered", command: "voice-off" });
			const overlay = fakeOverlay();
			const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), overlay: overlay.overlay, readTailMs: 1_000 });
			st.after(() => started.listener.close());
			const reader = await started.client();
			const other = await started.client();
			reader.hello("s-1", "w1:p1", true);
			other.hello("s-2", "w1:p2", true);
			await waitFor(() => framesOf(reader, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
			reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
			assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r")).type, "granted");
			reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
			await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
			reader.send({ type: "dictate", id: "d", mode: "dictation" });
			assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d")).type, "ok");
			assert.deepEqual(capture.calls, ["start"], "Alt+M records immediately during the tail");
			reader.send({ type: "read-begin", id: "tail-check", readingId: "read-2", chars: 1 });
			assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "tail-check"), { type: "busy", id: "tail-check", reason: "reading", holder: "s-1" });
			if (timing === "after tail") {
				await sleep(1_100);
				reader.send({ type: "read-begin", id: "after-check", readingId: "read-2", chars: 1 });
				assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "after-check"), { type: "busy", id: "after-check", reason: "capture", holder: "s-1" }, "the tail really expired while the capture stayed open");
			}
			capture.dies();
			assert.deepEqual(await awaitFrame(reader, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
			await waitFor(() => spot.starts >= 2);
			other.send({ type: "status", id: "barrier" });
			await awaitFrame(other, (frame) => "id" in frame && frame.id === "barrier");
			const hits = started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields);
			assert.equal(hits.length, 1);
			assert.equal(hits[0]?.command, "voice-off");
			assert.ok(hits[0]?.reason === "ignored:reading" || hits[0]?.reason === "ignored:stale", `unsafe hit was ${String(hits[0]?.reason)}`);
			assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"]);
			assert.equal(started.listener.state, "listening");
			assert.deepEqual([...framesOf(reader, "command"), ...framesOf(other, "command")], []);
			assert.deepEqual([...framesOf(reader, "transcript"), ...framesOf(other, "transcript")], []);
			assert.deepEqual(phases(reader), ["recording", "failed"]);
			assert.deepEqual(capture.calls, ["start", "stop"]);
			assert.deepEqual(spot.calls.slice(0, 2), ["spot.start", "spot.stop"]);
			assert.equal(spot.calls.at(-1), "spot.start", "spotting resumes after capture releases the microphone");
			await waitFor(() => cueLog(started.events).length === 2);
			assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
			assert.ok(overlay.snapshots.some((snapshot) => snapshot.recording));
			assert.equal(overlay.snapshots.at(-1)?.recording, false);
		});
	}
});

test("JD-A-006: a capture started after the tail accepts voice off and hands the mic back", async (t) => {
	const spot = fakeSpotting();
	const capture = selfEndingCapture({ text: "never delivered", command: "voice-off" });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, readTailMs: 50 });
	t.after(() => started.listener.close());
	const reader = await started.client();
	const other = await started.client();
	reader.hello("s-1", "w1:p1", true);
	other.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(reader, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
	reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r");
	reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
	await waitFor(() => spot.starts === 2, 3_000);
	reader.send({ type: "dictate", id: "d", mode: "dictation" });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	capture.dies();
	assert.deepEqual(await awaitFrame(reader, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
	assert.deepEqual(await awaitFrame(other, (frame) => frame.type === "command"), { type: "command", command: "voice-off" });
	assert.deepEqual(framesOf(reader, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual([...framesOf(reader, "transcript"), ...framesOf(other, "transcript")], []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "whole-utterance" }]);
	await waitFor(() => spot.starts === 3);
	assert.deepEqual(spot.calls, ["spot.start", "spot.stop", "spot.start", "spot.stop", "spot.start"]);
});

test("JD-A-006: ordinary dictation still records and delivers text during the tail", async (t) => {
	const spot = fakeSpotting();
	const capture = fakeCapture({ text: "hola durante la cola" });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, readTailMs: 1_000, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(reader, "welcome").length === 1 && spot.starts === 1);
	reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r");
	reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
	reader.send({ type: "dictate", id: "d", mode: "dictation" });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	reader.send({ type: "read-begin", id: "check", readingId: "read-2", chars: 1 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "check"), { type: "busy", id: "check", reason: "reading", holder: "s-1" });
	reader.send({ type: "stop", id: "s" });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "s")).type, "ok");
	assert.deepEqual(framesOf(reader, "transcript"), [{ type: "transcript", text: "hola durante la cola" }]);
	assert.deepEqual(phases(reader), ["recording", "transcribing", "delivered"]);
	assert.deepEqual(capture.calls, ["start", "stop"]);
	assert.deepEqual(framesOf(reader, "command"), []);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	await waitFor(() => spot.starts === 2);
});

test("JD-A-006: a request in the tail whose capture starts after spot teardown is not tainted", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting({ stopGate: gate });
	const capture = selfEndingCapture({ command: "voice-off" });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, readTailMs: 100 });
	t.after(() => { release(); return started.listener.close(); });
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(reader, "welcome").length === 1 && spot.starts === 1);
	reader.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "r");
	reader.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e");
	reader.send({ type: "dictate", id: "d", mode: "dictation" });
	await waitFor(() => spot.calls.includes("spot.stop"));
	assert.deepEqual(capture.calls, []);
	reader.send({ type: "read-begin", id: "tail-check", readingId: "read-2", chars: 1 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "tail-check"), { type: "busy", id: "tail-check", reason: "reading", holder: "s-1" });
	await sleep(150);
	reader.send({ type: "read-begin", id: "after-check", readingId: "read-2", chars: 1 });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "after-check"), { type: "busy", id: "after-check", reason: "capture", holder: "s-1" });
	release();
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	capture.dies();
	assert.deepEqual(await awaitFrame(reader, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
	assert.deepEqual(framesOf(reader, "command"), [{ type: "command", command: "voice-off" }]);
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.deepEqual(framesOf(reader, "transcript"), []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "whole-utterance" }]);
	await waitFor(() => spot.starts === 2);
});

test("a command collected after cancellation is logged as stale and cannot turn voice off", async (t) => {
	let notify!: (state: VoiceSessionState) => void;
	let complete!: (result: { text: string; truncated: boolean; command: string }) => void;
	let collecting = false;
	const result = new Promise<{ text: string; truncated: boolean; command: string }>((resolve) => { complete = resolve; });
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		dictation: (request) => {
			notify = request.onStateChange;
			return {
				start: async () => { notify("recording"); },
				stop: () => { collecting = true; return result; },
				cancel: async () => {},
			};
		},
	});
	t.after(() => started.listener.close());
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "dictate", id: "d", mode: "dictation" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "d");
	notify("finished");
	await waitFor(() => collecting);
	client.send({ type: "cancel", id: "c" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "c");
	complete({ text: "", truncated: false, command: "voice-off" });
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "ignored:stale" }]);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "command"), []);
	assert.deepEqual(framesOf(client, "transcript"), []);
	client.socket.destroy();
});

test("cancel during spot teardown aborts the reserved dictation before the microphone opens (JD-A-001)", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting({ stopGate: gate });
	const capture = fakeCapture({ text: "must never be delivered" });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory });
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "wake", id: "w" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "w");
	client.send({ type: "dictate", id: "d", mode: "dictation" });
	await waitFor(() => spot.calls.includes("spot.stop"));
	client.send({ type: "cancel", id: "c" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "c")).type, "ok");
	assert.deepEqual(framesOf(client, "capture"), [{ type: "capture", phase: "cancelled" }]);
	release();
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "d");
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(capture.calls, []);
	assert.deepEqual(framesOf(client, "transcript"), []);
	assert.equal(started.events.some((entry) => entry.event === "capture.begin"), false);
	client.socket.destroy();
});

test("a reading cannot start over a dictation reserved while the spotter stops (JD-A-002)", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const spot = fakeSpotting({ stopGate: gate });
	const capture = fakeCapture();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory });
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "wake", id: "w" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "w");
	client.send({ type: "dictate", id: "d", mode: "dictation" });
	await waitFor(() => spot.calls.includes("spot.stop"));
	client.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	assert.deepEqual(await awaitFrame(client, (frame) => "id" in frame && frame.id === "r"), { type: "busy", id: "r", reason: "capture", holder: "s-1" });
	assert.deepEqual(capture.calls, []);
	release();
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	assert.deepEqual(capture.calls, ["start"]);
	assert.equal(started.listener.readingSession, undefined);
	assert.deepEqual(framesOf(client, "transcript"), []);
	client.socket.destroy();
});

test("a reading waits for a cancelled capture's microphone teardown (S15, JD-A-002/003)", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let cancelStarted = false;
	const started = await startListener(scratch(), {
		dictation: (request) => ({
			start: async () => request.onStateChange("recording"),
			stop: async () => ({ text: "", truncated: false }),
			cancel: async () => { cancelStarted = true; await gate; request.onStateChange("finished"); },
		}),
	});
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "d");
	client.send({ type: "cancel", id: "c" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "c");
	assert.equal(cancelStarted, true);
	client.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 30 });
	assert.deepEqual(await awaitFrame(client, (frame) => "id" in frame && frame.id === "r1"), { type: "busy", id: "r1", reason: "capture" });
	assert.equal(started.listener.readingSession, undefined, "the closing worker still owns the microphone");
	release();
	await new Promise((resolve) => setTimeout(resolve, 5));
	client.send({ type: "read-begin", id: "r2", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "r2")).type, "granted");
});

// Exercise the real warm-worker handoff with fake child processes: a cancelled
// child deliberately holds its microphone until the test emits its close.
class GatedWarmChild extends EventEmitter {
	readonly received: Array<Record<string, unknown>> = [];
	readonly signals: string[] = [];
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	exited = false;
	readonly stdin = {
		on: () => {}, end: () => {},
		write: (line: string) => {
			const message = JSON.parse(line) as Record<string, unknown>;
			this.received.push(message);
			if (message.type === "start") queueMicrotask(() => this.say({ type: message.spot ? "spotting" : "recording" }));
			if (message.type === "stop") queueMicrotask(() => this.say({ type: "stopped" }));
			if (message.type === "close") queueMicrotask(() => this.exit());
			return true;
		},
	};
	say(message: Record<string, unknown>) { this.stdout.emit("data", `${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message })}\n`); }
	kill(signal: string) { this.signals.push(signal); this.exit(); return true; }
	exit() { if (!this.exited) { this.exited = true; this.emit("close", 0, null); } }
}

test("a reading waits for a failed warm worker to exit before taking the microphone (S15, L37)", async (t) => {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
	});
	const started = await startListener(scratch(), {
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }),
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	children[0]!.say({ type: "error", code: "no-input-device" });
	await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed");
	assert.equal(children[0]!.exited, false, "the terminal error precedes the child's exit");
	client.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 30 });
	assert.deepEqual(await awaitFrame(client, (frame) => "id" in frame && frame.id === "r1"), { type: "busy", id: "r1", reason: "capture" });
	children[0]!.exit();
	await new Promise((resolve) => setTimeout(resolve, 5));
	client.send({ type: "read-begin", id: "r2", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "r2")).type, "granted");
});

test("a reading stays blocked until a terminal-error worker is killed at its grace timeout", async (t) => {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
	});
	const started = await startListener(scratch(), {
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }),
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	children[0]!.say({ type: "error", code: "no-input-device" });
	await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed");
	client.send({ type: "read-begin", id: "r1", readingId: "read-1", chars: 30 });
	assert.deepEqual(await awaitFrame(client, (frame) => "id" in frame && frame.id === "r1"), { type: "busy", id: "r1", reason: "capture" });
	assert.equal(started.listener.readingSession, undefined);
	await waitFor(() => children[0]!.exited, 3_000);
	assert.deepEqual(children[0]!.signals, ["SIGKILL"]);
	client.send({ type: "read-begin", id: "r2", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "r2")).type, "granted");
});

test("awake voice-on hands the real warm worker from spotting to capture and back (S15, L37)", async (t) => {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
	});
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		keyword: kws,
		spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
	children[0]!.say({ type: "command", command: "voice-on" });
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "whole-utterance" }]);
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command"), { type: "command", command: "voice-on", wake: true });
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	const starts = children[0]!.received.filter((message) => message.type === "start");
	assert.equal(starts.at(-1)?.spot, undefined, "the warm spotter releases before the conversation starts");
	children[0]!.say({ type: "transcribing" });
	children[0]!.say({ type: "result", text: "hola", truncated: false });
	await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "delivered");
	await waitFor(() => children[0]!.received.filter((message) => message.type === "start" && message.spot === true).length >= 2);
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
	children[0]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "hola" }]);
});

test("cancel and owner disconnect wait for the real warm child before reopening spotting (JD-A-003)", async (t) => {
	for (const ending of ["asleep-cancel", "awake-cancel", "awake-disconnect", "last-disconnect", "last-update"] as const) {
		await t.test(ending, async (st) => {
			const children: GatedWarmChild[] = [];
			const warm = createWarmVoiceWorker({
				target: "linux-x64", env: {},
				prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
				spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
			});
			const kws = keywordOption();
			const started = await startListener(scratch(), {
				keyword: kws,
				spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
				dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
				focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
			});
			st.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
			await waitFor(() => children[0]?.received.some((message) => message.spot === true) === true);
			const owner = await started.client();
			const other = await started.client();
			owner.hello("s-1", "w1:p1", ending !== "asleep-cancel");
			other.hello("s-2", "w1:p2", ending !== "asleep-cancel" && ending !== "last-disconnect" && ending !== "last-update");
			await waitFor(() => framesOf(owner, "welcome").length === 1 && framesOf(other, "welcome").length === 1);
			if (ending !== "asleep-cancel") {
				owner.send({ type: "wake", id: "w" });
				await awaitFrame(owner, (frame) => "id" in frame && frame.id === "w");
			}
			owner.send({ type: "dictate", id: "d", mode: "dictation" });
			assert.equal((await awaitFrame(owner, (frame) => "id" in frame && frame.id === "d")).type, "ok");
			assert.equal(children.length, 1);
			assert.equal(children[0]!.received.filter((message) => message.type === "start").every((message) => message.keywordDiagnostics === true), true);
			children[0]!.say({ type: "keyword-rejected", command: "voice-off", reason: "lead" });
			await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
			assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "rejected:lead" }]);
			assert.deepEqual(framesOf(other, "command"), []);
			if (ending === "last-update") {
				await sendSessionVoice(owner, false);
				assert.equal(started.listener.state, "asleep");
				assert.deepEqual(started.listener.voiceSessions, []);
				assert.equal(children[0]!.received.filter((message) => message.type === "start").length, 2, "the active capture is not replaced by a spotter");
			}
			if (ending === "awake-disconnect" || ending === "last-disconnect") owner.socket.destroy();
			else {
				owner.send({ type: "cancel", id: "c" });
				assert.equal((await awaitFrame(owner, (frame) => "id" in frame && frame.id === "c")).type, "ok");
			}
			await waitFor(() => children[0]!.received.some((message) => message.type === "cancel"));
			await sleep(20);
			assert.equal(children.length, 1, "no new worker starts before the old child closes");
			assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
			children[0]!.exit();
			await waitFor(() => children.length === 2 && children[1]!.received.some((message) => message.spot === true));
			assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
			if (ending === "asleep-cancel" || ending === "last-disconnect" || ending === "last-update") {
				children[1]!.say({ type: "command", command: "voice-on" });
				assert.deepEqual(await awaitFrame(other, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
				assert.deepEqual(started.listener.voiceSessions, ["s-2"]);
			} else {
				children[1]!.say({ type: "command", command: "voice-off" });
				await awaitFrame(other, (frame) => frame.type === "command" && frame.command === "voice-off");
				assert.deepEqual(started.listener.voiceSessions, []);
			}
			assert.deepEqual(framesOf(other, "transcript"), []);
			owner.socket.destroy();
			other.socket.destroy();
		});
	}
});

// Drive the real warm layer with a child whose exit can be held after its error.
// A successful result and a blank result keep that child; an error makes it exit.
test("endpoint outcomes hand the warm worker back to spotting and a later voice-off works", async (t) => {
	for (const ending of ["delivered", "no-speech", "command", "worker-error"] as const) {
		await t.test(ending, async (st) => {
			const children: GatedWarmChild[] = [];
			const warm = createWarmVoiceWorker({
				target: "linux-x64", env: {},
				prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
				spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
			});
			const kws = keywordOption();
			const started = await startListener(scratch(), {
				keyword: kws,
				spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
				dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
				focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
			});
			st.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
			const client = await started.client();
			client.hello("s-1", "w1:p1", true);
			await waitFor(() => framesOf(client, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
			client.send({ type: "dictate", id: "d", mode: "conversation", endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } });
			assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
			const child = children[0]!;
			assert.equal(child.received.filter((message) => message.type === "start").length, 2);
			if (ending === "delivered") {
				child.say({ type: "keyword-rejected", command: "voice-on", reason: "lead" });
				assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-on", reason: "rejected:lead" }]);
			}
			if (ending === "command") child.say({ type: "command", command: "voice-on" });
			else if (ending === "worker-error") {
				child.say({ type: "error", code: "decode" });
				// The final error precedes the process exit; it still owns the worker.
				await sleep(30);
				assert.equal(children.length, 1);
				assert.equal(child.received.filter((message) => message.type === "start").length, 2, "no spot start on the exiting child");
				assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
				child.exit();
			} else {
				child.say({ type: "transcribing" });
				child.say({ type: "result", text: ending === "delivered" ? "seguí con eso" : "", truncated: false });
			}
			if (ending === "delivered") {
				assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "transcript"), { type: "transcript", text: "seguí con eso" });
				assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
			} else {
				const code = ending === "worker-error" ? "decode" : "no-speech";
				assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code });
				assert.deepEqual(framesOf(client, "transcript"), []);
			}
			await waitFor(() => children.some((entry) => entry.received.filter((message) => message.spot === true).length >= (entry === child ? 2 : 1)));
			assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
			const listening = children.at(-1)!;
			listening.say({ type: "command", command: "voice-off" });
			assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
			assert.equal(started.listener.state, "asleep");
			assert.deepEqual(started.listener.voiceSessions, []);
			client.socket.destroy();
		});
	}
});

test("a transient busy spot start waits for the real warm capture to settle, retries once, and hears voice-off", async (t) => {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
	});
	let releaseFocus!: () => void;
	const focusGate = new Promise<void>((resolve) => { releaseFocus = resolve; });
	let spotAttempts = 0;
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		keyword: kws,
		spot: (onKeywordRejected) => { spotAttempts++; return warm.spot({ kws, onKeywordRejected }); },
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
		focus: { focusedPaneId: async () => { await focusGate; return { focused: "w1:p1" }; } },
	});
	t.after(async () => { releaseFocus(); for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "d");
	children[0]!.say({ type: "transcribing" });
	children[0]!.say({ type: "result", text: "hola", truncated: false });
	// Model a competing capture still settling on the same warm worker when the
	// listener finishes its asynchronous focus lookup.
	const busy = warm.session({ onStateChange: () => {} });
	await busy.start();
	releaseFocus();
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	await waitFor(() => spotAttempts === 2);
	await sleep(30);
	assert.equal(spotAttempts, 2, "the retry waits rather than spinning against a busy worker");
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false, "the first invalid-state is transient");
	const ending = busy.cancel();
	children[0]!.exit();
	await ending;
	await waitFor(() => spotAttempts === 3 && children[1]?.received.some((message) => message.spot === true) === true);
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "hola" }]);
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
	children[1]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.equal(started.listener.state, "asleep");
	client.socket.destroy();
});

test("a second transient start failure is logged once with a fixed reason, without retrying forever", async (t) => {
	let attempts = 0;
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: () => ({
			start: async () => { attempts++; throw new VoiceSessionError("invalid-state"); },
			waitUntilSettled: async () => {},
			heard: async () => undefined,
			stop: async () => {},
			cancel: async () => {},
		}),
	});
	t.after(() => started.listener.close());
	await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
	assert.equal(attempts, 2);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "invalid-state" }]);
});

test("a pending busy retry is retired when a new dictation takes the microphone", async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let attempts = 0;
	const replacement = fakeSpotting();
	const dictation = fakeCapture({ text: "hola" });
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: (onKeywordRejected) => {
			attempts++;
			if (attempts > 1) return replacement.factory(onKeywordRejected);
			return {
				start: async () => { throw new VoiceSessionError("invalid-state"); },
				waitUntilSettled: () => gate,
				heard: async () => undefined,
				stop: async () => {},
				cancel: async () => {},
			};
		},
		dictation: dictation.factory,
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(() => { release(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "dictate", id: "d", mode: "dictation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	release();
	await sleep(20);
	assert.equal(attempts, 1, "the stale retry does not open over the recording");
	assert.deepEqual(dictation.calls, ["start"]);
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
	client.send({ type: "stop", id: "s" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "s")).type, "ok");
	await waitFor(() => attempts === 2 && replacement.starts === 1);
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "hola" }]);
	replacement.hearing("voice-off");
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	client.socket.destroy();
});

test("an unknown spotter failure logs only a fixed reason, never native details", async (t) => {
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: () => { throw new Error("private audio and device path"); },
	});
	t.after(() => started.listener.close());
	await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "internal" }]);
	assert.equal(JSON.stringify(started.events).includes("private audio"), false);
});

test("a recording that fails on its own, or ends on a spoken command, is settled without a stop as well", async () => {
	const failing = selfEndingCapture({ error: "no-speech" });
	const first = await startListener(scratch(), { dictation: failing.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const asker = await first.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
	// The worker ended without ever reporting transcribing.
	failing.dies();
	const failed = await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "failed");
	assert.equal((failed as { code?: string }).code, "no-speech");
	await waitFor(() => first.listener.state === "listening");
	asker.socket.destroy();
	await first.listener.close();

	const spoken = selfEndingCapture({ text: "", command: "voice-off" });
	const second = await startListener(scratch(), { dictation: spoken.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const other = await second.client();
	other.hello("s-2", "w1:p1");
	await waitFor(() => framesOf(other, "welcome").length === 1);
	other.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(other, (frame) => "id" in frame && frame.id === "d1");
	spoken.endsByItself();
	await waitFor(() => second.listener.state === "asleep");
	assert.equal(other.frames.some((frame) => frame.type === "transcript"), false, "a command is never delivered as text");
	other.socket.destroy();
	await second.listener.close();
});
