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
	type ListenerFocus,
} from "../lib/voice-listener.ts";
import { encodeListenerFrame, parseListenerFrameLine, VOICE_LISTENER_SCHEMA, type ListenerFrame, type ListenerRequest } from "../lib/voice-listener-protocol.ts";

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

interface Started {
	listener: VoiceListener;
	events: Array<{ event: string; fields?: Record<string, unknown> }>;
	client(): Promise<Client>;
}

async function startListener(dir: string, options: { idleMs?: number; asleepIdleMs?: number; focus?: ListenerFocus } = {}): Promise<Started> {
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const listener = new VoiceListener({
		dir,
		idleMs: options.idleMs ?? 60_000,
		asleepIdleMs: options.asleepIdleMs ?? 600_000,
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
