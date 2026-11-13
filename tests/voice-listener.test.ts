import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import test, { after } from "node:test";
import {
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
} from "../lib/voice-listener.ts";
import { encodeListenerFrame, parseListenerFrameLine, VOICE_LISTENER_SCHEMA, type ListenerFrame, type ListenerRequest } from "../lib/voice-listener-protocol.ts";
import type { CuePlayer } from "../lib/voice-cues.ts";
import { VoiceSessionError, type VoiceSessionErrorCode, type VoiceSessionState } from "../lib/voice-session.ts";

// One voice listener for every Pi session (S6, slice A): the single-instance
// lock, the unix-socket registry, the state edges, focus resolution and the
// rule that a transcript reaches the focused session only. Every socket lives
// in a scratch voice home under tmp/; the real ~/.pi/gentle-ai/voice is never
// touched and no microphone is opened in this slice.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
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
	hello(sessionId: string, paneId?: string, voiceOn?: boolean): void;
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
		hello: (sessionId, paneId?, voiceOn = true) => send({ type: "hello", proto: 1, sessionId, paneId, voiceOn }),
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
	options: { idleMs?: number; asleepIdleMs?: number; focus?: ListenerFocus; readLeaseMs?: number; readTailMs?: number; dictation?: (request: ListenerDictationRequest) => ListenerDictation; cues?: CuePlayer } = {},
): Promise<Started> {
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const listener = new VoiceListener({
		dir,
		idleMs: options.idleMs ?? 60_000,
		asleepIdleMs: options.asleepIdleMs ?? 600_000,
		readLeaseMs: options.readLeaseMs,
		readTailMs: options.readTailMs,
		dictation: options.dictation,
		cues: options.cues,
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
	first.hello("s-1", "w1:p1");
	second.hello("s-2", "w1:p2");
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

test("voice off from one session turns voice off everywhere (L10)", async () => {
	const started = await startListener(scratch());
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1");
	second.hello("s-2", "w1:p2", false);
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
	await waitFor(() => started.listener.state === "asleep");
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
	await waitFor(() => started.listener.state === "asleep");
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
	await waitFor(() => started.listener.state === "asleep");
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
	await waitFor(() => started.listener.state === "asleep");
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
	await waitFor(() => started.listener.state === "asleep");
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
	await waitFor(() => started.listener.state === "asleep");
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
	readonly factory: (request: ListenerDictationRequest) => ListenerDictation;
}

function fakeCapture(options: { text?: string; truncated?: boolean; error?: VoiceSessionErrorCode } = {}): FakeCapture {
	const calls: string[] = [];
	let notify: (state: VoiceSessionState) => void = () => {};
	return {
		calls,
		factory: (request) => {
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
					return { text: options.text ?? "hola", truncated: options.truncated === true };
				},
				cancel: async () => {
					calls.push("cancel");
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
