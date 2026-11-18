import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, Server, type Socket } from "node:net";
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
import { VOICE_WORKER_SCHEMA, VoiceSessionError, type VoiceKeywordOption, type VoiceSessionErrorCode, type VoiceSessionState } from "../lib/voice-session.ts";
import { createWarmVoiceWorker, type WarmVoiceWorker } from "../lib/voice-warm.ts";

// One voice listener for every Pi session (S6, slice A): the single-instance
// lock, the unix-socket registry, the state edges, focus resolution and the
// rule that a capture returns its transcript to its requester. Every socket lives
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
		focus?: ListenerFocus;
		readLeaseMs?: number;
		readTailMs?: number;
		dictation?: (request: ListenerDictationRequest) => ListenerDictation;
		cues?: CuePlayer;
		now?: () => number;
		language?: ListenerLanguage;
		keyword?: VoiceKeywordOption;
		spot?: ListenerSpotFactory;
		worker?: Pick<WarmVoiceWorker, "needsRecycle" | "recycle" | "close">;
	} = {},
): Promise<Started> {
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	const listener = new VoiceListener({
		dir,
		idleMs: options.idleMs ?? 60_000,
		readLeaseMs: options.readLeaseMs,
		readTailMs: options.readTailMs,
		dictation: options.dictation,
		keyword: options.keyword,
		spot: options.spot,
		worker: options.worker,
		cues: options.cues,
		now: options.now,
		language: options.language,
		log: (event, fields) => events.push({ event, fields }),
		focus: options.focus ?? { focusedPaneId: async () => ({ focused: undefined }) },
	});
	await listener.listen();
	return { listener, events, client: () => connectClient(dir) };
}

test("display subscriptions show asleep everywhere and a reading only to its owner", async (t) => {
 const started = await startListener(scratch(), { readTailMs: 10, language: "en" });
 t.after(() => started.listener.close());
 const owner = await started.client(); const other = await started.client();
 owner.send({type:"hello",proto:1,sessionId:"s-1",paneId:"p1",voiceOn:false,label:"repo"});
 other.hello("s-2","p2",false);
 await waitFor(() => framesOf(owner,"welcome").length === 1 && framesOf(other,"welcome").length === 1);
 for (const client of [owner, other]) {
  client.send({type:"display",id:"watch",on:true} as never);
  const answer=await awaitFrame(client, frame => ("id" in frame && frame.id === "watch") || frame.type === "error");
  assert.deepEqual(answer,{type:"ok",id:"watch",request:"display",state:"asleep"});
  await waitFor(() => framesOf(client,"display" as never).length === 1);
  assert.deepEqual(framesOf(client,"display" as never),[{type:"display",state:"asleep",language:"en"}]);
 }
 owner.send({type:"set-voice",id:"on",voiceOn:true}); await awaitFrame(owner,f=>"id" in f && f.id==="on");
 owner.send({type:"read-begin",id:"begin",readingId:"r",chars:10}); await awaitFrame(owner,f=>"id" in f && f.id==="begin");
 await waitFor(() => framesOf(owner,"display" as never).some(f => (f as {state?:string}).state === "reading"));
 assert.deepEqual(framesOf(owner,"display" as never).at(-1),{type:"display",state:"reading",language:"en",label:"repo"});
 assert.equal(framesOf(other,"display" as never).some(f => (f as {state?:string}).state === "reading"),false);
 owner.send({type:"read-end",id:"end",readingId:"r",outcome:"done"}); await awaitFrame(owner,f=>"id" in f && f.id==="end");
 await waitFor(() => (framesOf(owner,"display" as never).at(-1) as {state?:string})?.state === "off");
 owner.send({type:"sleep",id:"sleep"}); await awaitFrame(owner,f=>"id" in f && f.id==="sleep");
 await waitFor(() => [owner,other].every(c => (framesOf(c,"display" as never).at(-1) as {state?:string})?.state === "asleep"));
});

test("only a visible subscribed owner receives paced reading levels", async (t) => {
 const started=await startListener(scratch(), {readTailMs:10}); t.after(()=>started.listener.close());
 const owner=await started.client(); const other=await started.client();
 owner.hello("s-1","p1",true); other.hello("s-2","p2",true);
 await waitFor(()=>[owner,other].every(c=>framesOf(c,"welcome").length===1));
 for (const c of [owner,other]) { c.send({type:"display",id:"watch",on:true} as never); const reply=await awaitFrame(c,f=>("id" in f && f.id==="watch")||f.type==="error"); assert.equal(reply.type,"ok"); }
 owner.send({type:"read-begin",id:"b",readingId:"r",chars:10}); await awaitFrame(owner,f=>"id" in f && f.id==="b");
 owner.send({type:"read-levels",id:"v",readingId:"r",frameMs:50,levels:[0.1,0.2,0.3]}); await awaitFrame(owner,f=>"id" in f && f.id==="v");
 await waitFor(()=>levelFrames(owner).length===3); assert.deepEqual(levelFrames(owner).map(f=>(f as {rms:number}).rms),[0.1,0.2,0.3]);
 assert.deepEqual(levelFrames(other),[]);
 owner.send({type:"read-end",id:"e",readingId:"r",outcome:"done"}); await awaitFrame(owner,f=>"id" in f && f.id==="e");
 await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(levelFrames(owner).length,3);
});

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

test("voice off from one session clears every session's flag without disconnecting either", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 40 });
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", true);
	second.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(framesOf(first, "bye"), [], "two sessions with voice keep the listener alive");
	first.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => started.listener.state === "asleep");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.equal(started.listener.clientCount, 2);
	assert.deepEqual(framesOf(second, "bye"), []);
	first.socket.destroy();
	second.socket.destroy();
	await started.listener.close();
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

test("a session with voice on keeps the listener alive past the no-client idle window", async () => {
	const dir = scratch();
	const started = await startListener(dir, { idleMs: 40 });
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
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.replaced").map((entry) => entry.fields), [{ sessionId: "s-1", role: "session" }]);
	assert.equal(started.events.some((entry) => entry.event === "listener.reconnect-throttled"), false, "one normal reload is never throttled");
	second.socket.destroy();
	await started.listener.close();
});

test("reconnect: a 250 ms same-role ping-pong is logged and throttled without evicting its live voice session", async (t) => {
	let clock = 10_000;
	const started = await startListener(scratch(), { now: () => clock });
	t.after(() => started.listener.close());
	let live: Client | undefined;
	for (let i = 0; i < 6; i++) {
		const next = await started.client();
		next.hello("s-1", "w1:p1", true);
		assert.equal((await awaitFrame(next, (frame) => frame.type === "welcome" || frame.type === "error")).type, "welcome");
		if (live) await live.closed;
		live = next;
		clock += 250;
	}
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.replaced").map((entry) => entry.fields), Array.from({ length: 5 }, () => ({ sessionId: "s-1", role: "session" })));
	const logCount = started.events.length;
	for (let i = 0; i < 5; i++) {
		const refused = await started.client();
		refused.hello("s-1", "w1:p1", false);
		assert.deepEqual(await awaitFrame(refused, (frame) => frame.type === "welcome" || frame.type === "error"), { type: "error", code: "rate-limit" });
		await refused.closed;
		clock += 250;
	}
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.reconnect-throttled").map((entry) => entry.fields), [{ sessionId: "s-1" }]);
	assert.equal(started.events.slice(logCount).some((entry) => entry.event === "listener.rejected" || entry.event === "listener.client-closed"), false, "rejected attempts do not create a log storm");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"], "a refused stale hello cannot switch off its live replacement");
	assert.deepEqual(framesOf(live!, "bye"), []);
	live!.send({ type: "status", id: "alive" });
	assert.equal((await awaitFrame(live!, (frame) => "id" in frame && frame.id === "alive")).type, "snapshot");
	const other = await started.client();
	other.hello("s-2", "w1:p2", true);
	assert.equal((await awaitFrame(other, (frame) => frame.type === "welcome" || frame.type === "error")).type, "welcome", "another session is not throttled");
	assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"]);
});

test("reconnect: a reading-role burst cannot throttle the same session's session role", async (t) => {
	let clock = 10_000;
	const started = await startListener(scratch(), { now: () => clock });
	t.after(() => started.listener.close());
	const session = await started.client();
	session.hello("s-1", "w1:p1", true, "session");
	await awaitFrame(session, (frame) => frame.type === "welcome");
	let reading: Client | undefined;
	for (let i = 0; i < 6; i++) {
		const next = await started.client();
		next.hello("s-1", "w1:p1", true, "reading");
		assert.equal((await awaitFrame(next, (frame) => frame.type === "welcome" || frame.type === "error")).type, "welcome");
		if (reading) await reading.closed;
		reading = next;
		clock += 250;
	}
	const refused = await started.client();
	refused.hello("s-1", "w1:p1", true, "reading");
	assert.deepEqual(await awaitFrame(refused, (frame) => frame.type === "welcome" || frame.type === "error"), { type: "error", code: "rate-limit" }, "the same-role ping-pong is still throttled");
	await refused.closed;
	const reloaded = await started.client();
	reloaded.hello("s-1", "w1:p1", true, "session");
	assert.equal((await awaitFrame(reloaded, (frame) => frame.type === "welcome" || frame.type === "error")).type, "welcome");
	await session.closed;
	assert.deepEqual(framesOf(reading!, "bye"), [], "the reading role is not replaced by the session role");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.reconnect-throttled").map((entry) => entry.fields), [{ sessionId: "s-1" }]);
});

test("reconnect: quiet periods double after repeated bursts and reset after a stable minute", async (t) => {
	let clock = 10_000;
	const started = await startListener(scratch(), { now: () => clock });
	t.after(() => started.listener.close());
	let live: Client | undefined;
	const hello = async (accepted: boolean) => {
		const next = await started.client();
		next.hello("s-1", "w1:p1", true);
		const frame = await awaitFrame(next, (value) => value.type === "welcome" || value.type === "error");
		if (!accepted) {
			assert.deepEqual(frame, { type: "error", code: "rate-limit" });
			await next.closed;
		} else {
			assert.equal(frame.type, "welcome");
			if (live) await live.closed;
			live = next;
		}
	};
	for (let i = 0; i < 6; i++) { await hello(true); if (i < 5) clock += 250; }
	const episodes = () => started.events.filter((entry) => entry.event === "listener.reconnect-throttled").length;
	for (const delay of [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
		const at = clock;
		const previous = episodes();
		clock = at + delay - 1; await hello(false);
		clock = at + delay; await hello(true);
		// Older hellos may have fallen out of the window: produce the next
		// burst without resetting the escalating history.
		for (let i = 0; episodes() === previous && i < 5; i++) { clock += 250; await hello(true); }
		assert.equal(episodes(), previous + 1, `the next burst after ${delay} ms logs exactly once`);
	}
	const beforeReset = episodes();
	clock += 60_001;
	for (let i = 0; i < 6; i++) { await hello(true); if (i < 5) clock += 250; }
	const reset = clock;
	clock = reset + 1_999; await hello(false);
	clock = reset + 2_000; await hello(true);
	assert.equal(episodes(), beforeReset + 2, "new bursts are logged once apiece after reset");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(live!, "bye"), []);
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

test("reconnect: replacing a reading role logs that role without replacing the session", async (t) => {
	const started = await startListener(scratch());
	t.after(() => started.listener.close());
	const session = await started.client();
	const first = await started.client();
	const second = await started.client();
	session.hello("s-1", "w1:p1", true, "session");
	await awaitFrame(session, (frame) => frame.type === "welcome");
	first.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(first, (frame) => frame.type === "welcome");
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.replaced"), [], "different roles do not replace each other");
	second.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(second, (frame) => frame.type === "welcome");
	await first.closed;
	assert.deepEqual(framesOf(first, "bye"), [{ type: "bye", reason: "replaced" }]);
	assert.deepEqual(framesOf(session, "bye"), []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "listener.replaced").map((entry) => entry.fields), [{ sessionId: "s-1", role: "reading" }]);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
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

// A transcript that remains in flight until the test completes transcription.
function delayedCapture(text: string, command?: string) {
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const calls: string[] = [];
	const requests: ListenerDictationRequest[] = [];
	const factory = (request: ListenerDictationRequest): ListenerDictation => {
		requests.push(request);
		return {
			start: async () => { calls.push("start"); request.onStateChange("recording"); },
			stop: async () => { calls.push("stop"); request.onStateChange("transcribing"); await gate; request.onStateChange("finished"); return { text, truncated: false, ...(command === undefined ? {} : { command }) }; },
			cancel: async () => { calls.push("cancel"); request.onStateChange("finished"); },
		};
	};
	return { factory, finish, calls, requests };
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

test("a conversation transcript goes to its requester even when another session is focused", async (t) => {
	const dir = scratch();
	const capture = fakeCapture({ text: "hola mundo" });
	const started = await startListener(dir, {
		dictation: capture.factory,
		cues: cuePlayer(),
		focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
	});
	t.after(() => started.listener.close());
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
	assert.deepEqual(await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "hola mundo" }]);
	assert.deepEqual(framesOf(focused, "transcript"), []);
	assert.deepEqual(phases(asker), ["recording", "transcribing", "delivered"]);
	assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-1" }]);
	assert.deepEqual(capture.calls, ["start", "stop"]);
	// The microphone closes when the recording does; a session that has voice
	// keeps the listener awake, so it stays listening rather than asleep.
	assert.deepEqual(states(started.events), ["listening", "transcribing", "listening"]);
	assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
	asker.socket.destroy();
	focused.socket.destroy();
	await started.listener.close();
});

test("moving focus during transcription keeps the dictation with its requester", async (t) => {
	let focused = "w1:p1";
	let lookups = 0;
	const capture = delayedCapture("sigue acá");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => { lookups++; return { focused }; } } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const asker = await started.client();
	const other = await started.client();
	asker.hello("s-1", "w1:p1"); other.hello("s-2", "w1:p2");
	await waitFor(() => [asker, other].every((client) => framesOf(client, "welcome").length === 1));
	asker.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	asker.send({ type: "stop", id: "stop" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	focused = "w1:p2";
	capture.finish();
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "stop");
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "sigue acá" }]);
	assert.deepEqual(framesOf(other, "transcript"), []);
	assert.equal(phases(asker).at(-1), "delivered");
	assert.equal(lookups, 0);
});

test("a connected requester is delivered without awaiting a hung focus lookup", async (t) => {
	let lookups = 0;
	const started = await startListener(scratch(), { dictation: fakeCapture({ text: "sin espera" }).factory, focus: { focusedPaneId: () => { lookups++; return new Promise(() => {}); } } });
	t.after(() => started.listener.close());
	const requester = await started.client();
	requester.hello("s-1", "w1:p1");
	await awaitFrame(requester, (frame) => frame.type === "welcome");
	requester.send({ type: "dictate", id: "d", mode: "dictation" });
	await awaitFrame(requester, (frame) => "id" in frame && frame.id === "d");
	requester.send({ type: "stop", id: "stop" });
	assert.deepEqual(await awaitFrame(requester, (frame) => frame.type === "transcript", 300), { type: "transcript", text: "sin espera" });
	assert.equal((await awaitFrame(requester, (frame) => "id" in frame && frame.id === "stop", 300)).type, "ok");
	assert.equal(lookups, 0);
	assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-1" }]);
});

test("a connected requester receives a finished transcript without a fallback log", async (t) => {
	const scenarios: Array<{ name: string; focus: ListenerFocus; count: number }> = [
		{ name: "failed lookup with one connection", focus: { focusedPaneId: async () => ({ failed: true }) }, count: 1 },
		{ name: "failed lookup with two connections", focus: { focusedPaneId: async () => ({ failed: true }) }, count: 2 },
		{ name: "lookup throws or times out", focus: { focusedPaneId: async () => { throw new Error("timeout with private details"); } }, count: 2 },
		{ name: "focused pane has no client", focus: { focusedPaneId: async () => ({ focused: "w9:p9" }) }, count: 2 },
		{ name: "nobody focused with two connections", focus: { focusedPaneId: async () => ({ focused: undefined }) }, count: 2 },
	];
	for (const { name, focus, count } of scenarios) {
		await t.test(name, async (st) => {
			const started = await startListener(scratch(), { dictation: fakeCapture({ text: "texto terminado", truncated: true }).factory, focus });
			st.after(() => started.listener.close());
			const clients = await Promise.all(Array.from({ length: count }, () => started.client()));
			clients.forEach((client, index) => client.hello(`s-${index + 1}`, `w1:p${index + 1}`));
			await waitFor(() => clients.every((client) => framesOf(client, "welcome").length === 1));
			const requester = clients[0]!;
			requester.send({ type: "dictate", id: "d", mode: "dictation" });
			await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
			requester.send({ type: "stop", id: "stop" });
			await awaitFrame(requester, (frame) => "id" in frame && frame.id === "stop");
			assert.deepEqual(framesOf(requester, "transcript"), [{ type: "transcript", text: "texto terminado", truncated: true }]);
			assert.deepEqual(phases(requester), ["recording", "transcribing", "delivered"]);
			for (const other of clients.slice(1)) assert.deepEqual(framesOf(other, "transcript"), []);
			assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-1" }]);
			assert.equal(started.events.filter((entry) => entry.event === "transcript.undelivered").length, 0);
			assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "delivered");
			assert.equal(JSON.stringify(started.events).includes("texto terminado"), false);
		});
	}
});

test("a departed requester falls back to the focused session, not its reading connection", async (t) => {
	const capture = delayedCapture("hola");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const requester = await started.client();
	const reader = await started.client();
	const focused = await started.client();
	requester.hello("s-1", "w1:p1");
	reader.hello("s-2", "w1:p2", true, "reading");
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	focused.hello("s-2", "w1:p2", true, "session");
	await waitFor(() => [requester, focused].every((client) => framesOf(client, "welcome").length === 1));
	requester.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	requester.socket.destroy();
	await waitFor(() => started.listener.clientCount === 2);
	capture.finish();
	assert.deepEqual(await awaitFrame(focused, (frame) => frame.type === "transcript"), { type: "transcript", text: "hola" });
	assert.deepEqual(framesOf(reader, "transcript"), []);
	assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-2", fallback: "focus" }]);
	assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "elsewhere");
	assert.deepEqual(capture.calls, ["start", "stop"]);
});

test("replacing the requester's connection with the same session is still a focus fallback", async (t) => {
	const capture = delayedCapture("reconectado");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const requester = await started.client();
	requester.hello("s-1", "w1:p1");
	await awaitFrame(requester, (frame) => frame.type === "welcome");
	requester.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	const replacement = await started.client();
	replacement.hello("s-1", "w1:p1");
	await awaitFrame(replacement, (frame) => frame.type === "welcome");
	capture.finish();
	assert.deepEqual(await awaitFrame(replacement, (frame) => frame.type === "transcript"), { type: "transcript", text: "reconectado" });
	assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-1", fallback: "focus" }]);
	assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "elsewhere");
});

test("a departed requester's focused reading-only connection is not a transcript target", async (t) => {
	const capture = delayedCapture("hola");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const requester = await started.client();
	const reader = await started.client();
	requester.hello("s-1", "w1:p1"); reader.hello("s-2", "w1:p2", true, "reading");
	await waitFor(() => [requester, reader].every((client) => framesOf(client, "welcome").length === 1));
	requester.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	requester.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	capture.finish();
	await waitFor(() => started.events.some((entry) => entry.event === "transcript.undelivered"));
	assert.deepEqual(framesOf(reader, "transcript"), []);
	assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "dropped");
});

test("a departed requester and no eligible focus drop the transcript", async (t) => {
	for (const outcome of ["failed", "unfocused"] as const) {
		await t.test(outcome, async (st) => {
			const capture = delayedCapture("texto terminado");
			const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => outcome === "failed" ? { failed: true } : { focused: undefined } } });
			st.after(() => { capture.finish(); return started.listener.close(); });
			const requester = await started.client();
			const other = await started.client();
			const third = await started.client();
			requester.hello("s-1", "w1:p1"); other.hello("s-2", "w1:p2"); third.hello("s-3", "w1:p3");
			await waitFor(() => [requester, other, third].every((client) => framesOf(client, "welcome").length === 1));
			requester.send({ type: "dictate", mode: "dictation" });
			await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
			requester.send({ type: "stop" });
			await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
			requester.socket.destroy();
			await waitFor(() => started.listener.clientCount === 2);
			capture.finish();
			await waitFor(() => started.events.some((entry) => entry.event === "transcript.undelivered"));
			assert.deepEqual([...framesOf(other, "transcript"), ...framesOf(third, "transcript")], []);
			assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "dropped");
			assert.equal(started.events.some((entry) => entry.event === "transcript.delivered"), false);
		});
	}
});

test("with the requester gone and no pane focused, the sole unchanged session receives the transcript", async (t) => {
	const capture = delayedCapture("texto terminado");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: undefined }) } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const requester = await started.client();
	const other = await started.client();
	requester.hello("s-1", "w1:p1"); other.hello("s-2", "w1:p2");
	await waitFor(() => [requester, other].every((client) => framesOf(client, "welcome").length === 1));
	requester.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	requester.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	capture.finish();
	assert.deepEqual(await awaitFrame(other, (frame) => frame.type === "transcript"), { type: "transcript", text: "texto terminado" });
	assert.deepEqual(started.events.filter((entry) => entry.event === "transcript.delivered").map((entry) => entry.fields), [{ sessionId: "s-2", fallback: "focus" }]);
	assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "elsewhere");
});

test("a command finishing after its owner disconnects stays stale", async (t) => {
	const capture = delayedCapture("", "voice-off");
	const started = await startListener(scratch(), { dictation: capture.factory });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const requester = await started.client(); const other = await started.client();
	requester.hello("s-1", "w1:p1"); other.hello("s-2", "w1:p2");
	await waitFor(() => [requester, other].every((client) => framesOf(client, "welcome").length === 1));
	requester.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	requester.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	capture.finish();
	await waitFor(() => started.events.some((entry) => entry.event === "kws.hit"));
	assert.deepEqual(framesOf(other, "command"), []);
	assert.deepEqual(started.listener.voiceSessions, ["s-2"]);
	assert.ok(started.events.some((entry) => entry.event === "kws.hit" && entry.fields?.reason === "ignored:stale"));
});

test("a focused fallback that leaves during lookup cannot receive a stale transcript", async (t) => {
	let release!: () => void;
	let asked = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const capture = delayedCapture("hola");
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => { asked = true; await gate; return { focused: "w1:p2" }; } } });
	t.after(() => { capture.finish(); release(); return started.listener.close(); });
	const requester = await started.client();
	const focused = await started.client();
	const other = await started.client();
	requester.hello("s-1", "w1:p1"); focused.hello("s-2", "w1:p2"); other.hello("s-3", "w1:p3");
	await waitFor(() => [requester, focused, other].every((client) => framesOf(client, "welcome").length === 1));
	requester.send({ type: "dictate", mode: "dictation" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "recording");
	requester.send({ type: "stop" });
	await awaitFrame(requester, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	requester.socket.destroy();
	await waitFor(() => started.listener.clientCount === 2);
	capture.finish();
	await waitFor(() => asked);
	focused.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	release();
	await waitFor(() => started.events.some((entry) => entry.event === "transcript.undelivered"));
	assert.deepEqual([...framesOf(focused, "transcript"), ...framesOf(other, "transcript")], []);
	assert.equal(started.events.find((entry) => entry.event === "capture.end")?.fields?.phase, "dropped");
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

test("a cancel during transcription prevents delivery to either session", async (t) => {
	const capture = delayedCapture("no debería");
	let lookups = 0;
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => { lookups++; return { focused: "w1:p2" }; } } });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const asker = await started.client();
	const focused = await started.client();
	asker.hello("s-1", "w1:p1"); focused.hello("s-2", "w1:p2");
	await waitFor(() => [asker, focused].every((client) => framesOf(client, "welcome").length === 1));
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "recording");
	asker.send({ type: "stop", id: "s1" });
	await awaitFrame(asker, (frame) => frame.type === "capture" && frame.phase === "transcribing");
	asker.send({ type: "cancel", id: "c1" });
	assert.equal((await awaitFrame(asker, (frame) => "id" in frame && frame.id === "c1")).type, "ok");
	assert.deepEqual(framesOf(asker, "capture").at(-1), { type: "capture", phase: "cancelled" });
	capture.finish();
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "s1");
	assert.deepEqual([...framesOf(asker, "transcript"), ...framesOf(focused, "transcript")], []);
	assert.equal(lookups, 0);
	assert.equal(started.events.some((entry) => entry.event === "transcript.delivered"), false);
});

test("a cancelled focus fallback cannot deliver after its lookup resolves or fails", async (t) => {
	for (const outcome of ["focused", "throws"] as const) {
		await t.test(outcome, async (st) => {
			let release!: () => void;
			let asked = false;
			let cancelled = false;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const started = await startListener(scratch(), { focus: { focusedPaneId: async () => { asked = true; await gate; if (outcome === "throws") throw new Error("late error"); return { focused: "w1:p1" }; } } });
			st.after(() => { release(); return started.listener.close(); });
			const client = await started.client();
			client.hello("s-1", "w1:p1");
			await awaitFrame(client, (frame) => frame.type === "welcome");
			const delivery = started.listener.deliverTranscript("no debería", false, () => cancelled);
			await waitFor(() => asked);
			cancelled = true;
			release();
			assert.equal(await delivery, undefined);
			assert.deepEqual(framesOf(client, "transcript"), []);
			assert.equal(started.events.some((entry) => entry.event === "transcript.delivered"), false);
			assert.ok(started.events.some((entry) => entry.event === "transcript.undelivered" && entry.fields?.capture === "cancelled"));
		});
	}
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
const displayFrames = (client: Client) => client.frames.filter((frame) => frame.type === "display");
const displayStates = (client: Client) => displayFrames(client).map((frame) => frame.type === "display" ? frame.state : undefined);
async function watchDisplay(client: Client): Promise<void> {
	client.send({ type: "display", id: "display-subscribe", on: true });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "display-subscribe")).type, "ok");
	await waitFor(() => displayFrames(client).length > 0);
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

test("the worker sends levels only when a subscriber needs them", async (t) => {
	for (const subscribed of [false, true]) {
		const capture = fakeCapture();
		const started = await startListener(scratch(), { dictation: capture.factory });
		t.after(() => started.listener.close());
		const asker = await started.client();
		asker.hello("s-1", "w1:p1");
		await awaitFrame(asker, (frame) => frame.type === "welcome");
		if (subscribed) await watchDisplay(asker);
		asker.send({ type: "dictate", id: "d1", mode: "conversation" });
		await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");
		assert.equal(capture.requests[0]!.levels, subscribed);
		asker.socket.destroy();
		await started.listener.close();
	}
});

test("the owning display receives capture states, label and raw microphone loudness", async (t) => {
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(scratch(), { dictation: capture.factory, now: () => 7, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await awaitFrame(asker, frame => frame.type === "welcome");
	await watchDisplay(asker);
	assert.deepEqual(displayFrames(asker), [{ type: "display", state: "off", language: "es" }]);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "d1");
	await waitFor(() => displayStates(asker).includes("listening"));
	assert.deepEqual(displayFrames(asker).at(-1), { type: "display", state: "listening", language: "es", label: "repo" });
	capture.requests.at(-1)!.onLevel(0.016);
	await waitFor(() => levelFrames(asker).length === 1);
	assert.deepEqual(levelFrames(asker), [{ type: "level", rms: 0.016, at: 7 }]);
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "d2");
	await waitFor(() => displayStates(asker).at(-1) === "off");
	assert.deepEqual(displayStates(asker), ["off", "listening", "off", "transcribing", "off"]);
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "hola" }]);
});

test("the display claims listening only after the worker reports recording (S10)", async (t) => {
	const capture = manualCapture();
	const started = await startListener(scratch(), { dictation: capture.factory, now: () => 7, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await awaitFrame(asker, frame => frame.type === "welcome");
	await watchDisplay(asker);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "d1");
	assert.deepEqual(displayStates(asker), ["off"], "preparing cannot claim the microphone");
	capture.state("recording");
	await waitFor(() => displayStates(asker).includes("listening"));
	assert.deepEqual(displayFrames(asker).at(-1), { type: "display", state: "listening", language: "es", label: "repo" });
	capture.requests.at(-1)!.onLevel(0.016);
	await waitFor(() => levelFrames(asker).length === 1);
	assert.deepEqual(displayStates(asker), ["off", "listening"], "a level is not a state change");
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "delivered");
	await waitFor(() => displayStates(asker).at(-1) === "off");
	assert.deepEqual(displayStates(asker), ["off", "listening", "off", "transcribing", "off"]);
});

test("every capture ending withdraws listening and cannot turn it back on (S10)", async (t) => {
	for (const ending of ["stop", "cancel", "worker-error", "session-close"] as const) {
		const capture = manualCapture({ error: ending === "worker-error" ? "worker-exited" : undefined });
		const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
		t.after(() => started.listener.close());
		const asker = await started.client();
		asker.hello("s-1", "w1:p1");
		await awaitFrame(asker, frame => frame.type === "welcome");
		await watchDisplay(asker);
		asker.send({ type: "dictate", id: "d1", mode: "conversation" });
		await awaitFrame(asker, frame => "id" in frame && frame.id === "d1");
		capture.state("recording");
		await waitFor(() => displayStates(asker).includes("listening"));
		if (ending === "cancel") asker.send({ type: "cancel", id: "d2" });
		else if (ending === "session-close") asker.socket.destroy();
		else asker.send({ type: "stop", id: "d2" });
		const phase = ending === "cancel" ? "cancelled" : ending === "worker-error" ? "failed" : "delivered";
		if (ending === "session-close") await waitFor(() => started.listener.clientCount === 0);
		else {
			await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === phase);
			await waitFor(() => displayStates(asker).at(-1) === "off");
		}
		assert.equal(displayStates(asker).filter(state => state === "listening").length, 1, ending);
		const count = levelFrames(asker).length;
		capture.requests[0]!.onLevel(0.3);
		await new Promise(resolve => setTimeout(resolve, 20));
		assert.equal(levelFrames(asker).length, count, `${ending}: no level after release`);
		asker.socket.destroy();
		await started.listener.close();
	}
});

test("a level is never read as the microphone recording (S10)", async (t) => {
	const capture = manualCapture();
	const started = await startListener(scratch(), { dictation: capture.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await awaitFrame(asker, frame => frame.type === "welcome");
	await watchDisplay(asker);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "d1");
	capture.requests.at(-1)!.onLevel(0.9);
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.deepEqual(levelFrames(asker), []);
	assert.deepEqual(displayStates(asker), ["off"]);
});

test("the original shared state frames stay unchanged beside display snapshots", async (t) => {
	const capture = manualCapture();
	const started = await startListener(scratch(), { dictation: capture.factory, now: () => 7, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const asker = await started.client();
	asker.send({ type: "hello", proto: 1, sessionId: "s-1", paneId: "w1:p1", voiceOn: true, label: "repo" });
	await awaitFrame(asker, frame => frame.type === "welcome");
	await watchDisplay(asker);
	asker.send({ type: "dictate", id: "d1", mode: "conversation" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "d1");
	capture.state("recording");
	await waitFor(() => displayStates(asker).includes("listening"));
	asker.send({ type: "stop", id: "d2" });
	await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "delivered");
	assert.deepEqual(framesOf(asker, "state"), [
		{ type: "state", state: "listening", language: "es", at: 7 },
		{ type: "state", state: "transcribing", language: "es", paneId: "w1:p1", label: "repo", at: 7 },
		{ type: "state", state: "listening", language: "es", at: 7 },
	]);
	for (const frame of framesOf(asker, "state")) assert.ok(!("recording" in frame));
});

test("a disconnected display never breaks another session's capture", async (t) => {
	const capture = fakeCapture({ text: "hola mundo" });
	const started = await startListener(scratch(), { dictation: capture.factory, cues: cuePlayer(), focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const asker = await started.client(); const display = await started.client();
	asker.hello("s-1", "w1:p1"); display.hello("s-2", "w1:p2");
	await awaitFrame(asker, frame => frame.type === "welcome");
	await awaitFrame(display, frame => frame.type === "welcome");
	await watchDisplay(display);
	display.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	asker.send({ type: "dictate", mode: "conversation" });
	await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "recording");
	capture.requests.at(-1)!.onLevel(0.02);
	asker.send({ type: "stop" });
	assert.deepEqual(await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "hola mundo" }]);
	assert.deepEqual(cueLog(started.events).map(cue => cue?.name), ["open", "close"]);
});

test("T21-R2: a backpressured display drops levels, coalesces snapshots and never holds the capture", async (t) => {
	const capture = manualCapture();
	let clock = 0;
	let saturated = false;
	let armed = false;
	let backpressureReturn: boolean | undefined;
	let serverDisplay: Socket | undefined;
	const writes: Array<{ frame: ListenerFrame; saturated: boolean }> = [];
	// Intercept the public server connection event and control only the first
	// accepted socket. All actual frames still cross the real Unix socket.
	const emit = Server.prototype.emit;
	Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
		if (event === "connection" && !serverDisplay) {
			const socket = args[0] as Socket;
			serverDisplay = socket;
			const write = socket.write.bind(socket);
			Object.defineProperty(socket, "writableNeedDrain", { configurable: true, get: () => saturated });
			socket.write = ((chunk: string) => {
				const frame = parseListenerFrameLine(chunk);
				if (frame?.type === "display" || frame?.type === "level") writes.push({ frame, saturated });
				const result = write(chunk);
				if (armed && frame?.type === "display" && frame.state === "listening") {
					armed = false;
					saturated = true;
					backpressureReturn = false;
					return false;
				}
				return result;
			}) as typeof socket.write;
		}
		return emit.call(this, event, ...args);
	} as typeof Server.prototype.emit;
	t.after(() => { Server.prototype.emit = emit; });
	const started = await startListener(scratch(), { dictation: capture.factory, now: () => clock, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const display = await started.client(); const asker = await started.client();
	Server.prototype.emit = emit;
	display.hello("s-1", "w1:p1"); asker.hello("s-1", "w1:p1", true, "reading");
	await awaitFrame(display, frame => frame.type === "welcome");
	await awaitFrame(asker, frame => frame.type === "welcome");
	await watchDisplay(display);
	armed = true;
	asker.send({ type: "dictate", mode: "conversation" });
	await waitFor(() => capture.requests.length === 1);
	capture.state("recording");
	await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "recording");
	assert.equal(backpressureReturn, false, "the server-side write really returned false");
	assert.equal(serverDisplay!.writableNeedDrain, true, "the server-side buffer is saturated");
	capture.requests[0]!.onLevel(0.02);
	clock = 50;
	capture.requests[0]!.onLevel(0.03);
	asker.send({ type: "stop" });
	await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "transcribing");
	assert.deepEqual(await awaitFrame(asker, frame => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	await awaitFrame(asker, frame => frame.type === "transcript");
	assert.deepEqual(framesOf(asker, "transcript"), [{ type: "transcript", text: "hola" }], "capture and transcript finish while the display is saturated");
	assert.deepEqual(framesOf(display, "transcript"), []);
	asker.send({ type: "sleep", id: "sleep-after-capture" });
	await awaitFrame(asker, frame => "id" in frame && frame.id === "sleep-after-capture");
	assert.equal(started.listener.state, "asleep", "the latest snapshot differs from the first pending off snapshot");
	assert.equal(serverDisplay!.writableNeedDrain, true);
	assert.deepEqual(writes.filter(entry => entry.saturated), [], "neither state nor level frames are written while saturated");
	assert.deepEqual(levelFrames(display), [], "expendable levels are dropped, not buffered");
	await waitFor(() => displayStates(display).includes("listening"));
	assert.deepEqual(displayStates(display), ["off", "listening"]);
	// While blocked: off, transcribing, off, then asleep. A first-only
	// queue would flush off; replacement must flush only the latest, asleep.
	const beforeDrain = writes.length;
	saturated = false;
	serverDisplay!.emit("drain");
	await waitFor(() => displayFrames(display).length === 3);
	assert.deepEqual(displayStates(display), ["off", "listening", "asleep"], "at most one pending snapshot is delivered, and it is the newest");
	assert.deepEqual(writes.slice(beforeDrain).map(entry => entry.frame), [{ type: "display", state: "asleep", language: "es" }]);
	assert.deepEqual(levelFrames(display), []);
	display.socket.destroy();
});

// --- the reading's own loudness (T13, S5) --------------------------------------
// The owner receives the output, not the microphone, one frame at a time.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One session that asked, was granted the turn, and is the only one accepted.
async function grantedReading(started: Started, sessionId = "s-1", readingId = "read-1", role: "session" | "reading" = "session"): Promise<Client> {
	const reader = await started.client();
	reader.hello(sessionId, undefined, true, role);
	await waitFor(() => framesOf(reader, "welcome").length === 1);
	reader.send({ type: "read-begin", id: "b1", readingId, chars: 40 });
	assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "b1")).type, "granted");
	return reader;
}

test("the reading's loudness reaches the subscribed display in audio time and stops on end", async () => {
	const started = await startListener(scratch());
	const reader = await grantedReading(started);
	await watchDisplay(reader);
	const overlay = { get levels() { return levelFrames(reader).map(frame => frame.type === "level" ? frame.rms : 0); } };
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.3, 0.6, 0.1] });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v1"), { type: "ok", id: "v1", request: "read-levels", state: "reading" });
	assert.deepEqual(overlay.levels, [], "a level is drawn in audio time, never at the moment it arrives");
	const first = Date.now();
	await waitFor(() => overlay.levels.length === 3);
	assert.deepEqual(overlay.levels, [0.3, 0.6, 0.1], "the session receives raw output loudness");
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
	const started = await startListener(scratch());
	const reader = await grantedReading(started);
	await watchDisplay(reader);
	const overlay = { get levels() { return levelFrames(reader).map(frame => frame.type === "level" ? frame.rms : 0); } };
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
	const cut = await startListener(scratch());
	const reader = await grantedReading(cut);
	await watchDisplay(reader);
	const cutOverlay = { get levels() { return levelFrames(reader).map(frame => frame.type === "level" ? frame.rms : 0); } };
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
	const lease = await startListener(scratch(), { readLeaseMs: 150 });
	const silent = await grantedReading(lease);
	await watchDisplay(silent);
	const leaseOverlay = { get levels() { return levelFrames(silent).map(frame => frame.type === "level" ? frame.rms : 0); } };
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
	const gone = await startListener(scratch());
	const reader = await grantedReading(gone);
	await watchDisplay(reader);
	const goneOverlay = { get levels() { return levelFrames(reader).map(frame => frame.type === "level" ? frame.rms : 0); } };
	reader.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => goneOverlay.levels.length >= 1);
	reader.socket.destroy();
	await waitFor(() => gone.listener.readingSession === undefined);
	const afterGone = goneOverlay.levels.length;
	await sleep(200);
	assert.equal(goneOverlay.levels.length, afterGone, "the holder leaving stops the levels");
	await gone.listener.close();

	const closing = await startListener(scratch());
	const last = await grantedReading(closing);
	await watchDisplay(last);
	const closedOverlay = { get levels() { return levelFrames(last).map(frame => frame.type === "level" ? frame.rms : 0); } };
	last.send({ type: "read-levels", readingId: "read-1", frameMs: 50, levels: Array.from({ length: 20 }, () => 0.4) });
	await waitFor(() => closedOverlay.levels.length >= 1);
	await closing.listener.close();
	const afterClose = closedOverlay.levels.length;
	await sleep(200);
	assert.equal(closedOverlay.levels.length, afterClose, "a closing listener stops the levels");
	last.socket.destroy();
});

test("without a display subscriber the reading still accepts its levels", async () => {
	const started = await startListener(scratch());
	const reader = await grantedReading(started);
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.2, 0.2] });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "v1"), { type: "ok", id: "v1", request: "read-levels", state: "reading" });
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	assert.deepEqual(await awaitFrame(reader, (frame) => "id" in frame && frame.id === "e1"), { type: "ok", id: "e1", request: "read-end", state: "reading" });
	reader.socket.destroy();
	await started.listener.close();
});

test("a display that disconnects mid-wave does not interrupt its session's reading", async (t) => {
	const started = await startListener(scratch());
	t.after(() => started.listener.close());
	const reader = await grantedReading(started, "s-1", "read-1", "reading");
	const display = await started.client();
	display.hello("s-1");
	await awaitFrame(display, frame => frame.type === "welcome");
	await watchDisplay(display);
	assert.equal(displayStates(display).at(-1), "reading");
	reader.send({ type: "read-levels", id: "v1", readingId: "read-1", frameMs: 50, levels: [0.2, 0.4, 0.6] });
	await waitFor(() => levelFrames(display).length === 1);
	display.socket.destroy();
	await waitFor(() => started.listener.clientCount === 1);
	assert.equal(started.listener.readingSession, "s-1");
	reader.send({ type: "read-end", id: "e1", readingId: "read-1", outcome: "done" });
	assert.deepEqual(await awaitFrame(reader, frame => "id" in frame && frame.id === "e1"), { type: "ok", id: "e1", request: "read-end", state: "reading" });
});

test("reading and microphone levels reach the display as raw, distinct sources", async () => {
	const dir = scratch();
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, { dictation: capture.factory, readTailMs: 20, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const reader = await grantedReading(started);
	await watchDisplay(reader);
	const overlay = { get levels() { return levelFrames(reader).map(frame => frame.type === "level" ? frame.rms : 0); } };
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
	await waitFor(() => overlay.levels.length === 2);
	assert.deepEqual(overlay.levels, [0.5, 0.016], "the listener forwards raw microphone and output levels");
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
	// The open spot-only capture dies or stops without being asked.
	dying(): void;
	stopping(): void;
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
		stopping: () => pending?.resolve(undefined),
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
	assert.deepEqual(started.listener.voiceSessions, [], "voice is off in every session, but their connections stay open");
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
	const capture = fakeCapture({ text: "hola" });
	const started = await startListener(dir, {
		keyword: keywordOption(),
		spot: spot.factory,
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
	await watchDisplay(quiet); await watchDisplay(focused);
	quiet.send({ type: "set-voice", id: "off", voiceOn: false });
	await awaitFrame(quiet, frame => "id" in frame && frame.id === "off");
	await waitFor(() => displayStates(quiet).at(-1) === "asleep" && displayStates(focused).at(-1) === "asleep");
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
	// Wake alone does not claim the microphone or display a listening bubble.
	assert.deepEqual(cueLog(started.events), [], "the wake plays no cue of its own");
	await waitFor(() => displayStates(focused).at(-1) === "off");
	assert.equal(displayStates(quiet).at(-1), "off");
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

test("a spotter that dies while listening retries and reports recovery (S7)", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	t.after(() => started.listener.close());
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	spot.dying();
	await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
	await waitFor(() => spot.starts === 2);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "worker-exited" }]);
	assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
	spot.hearing("voice-off");
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	await waitFor(() => spot.starts === 3);
	spot.hearing("voice-on");
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "transcript"), []);
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

test("a connected asleep session still hears voice on after ten minutes", async (t) => {
	const dir = scratch();
	const spot = fakeSpotting();
	const started = await startListener(dir, { keyword: keywordOption(), spot: spot.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	await waitFor(() => spot.starts === 1);
	const flushIO = async (condition: () => boolean) => {
		for (let i = 0; i < 100 && !condition(); i++) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.ok(condition(), "listener did not process the frame");
	};
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	try {
		client.send({ type: "set-voice", id: "off", voiceOn: false });
		await flushIO(() => framesOf(client, "ok").some((frame) => "id" in frame && frame.id === "off"));
		assert.equal(started.listener.state, "asleep");
		t.mock.timers.tick(600_001);
		await Promise.resolve();
		assert.equal(started.listener.clientCount, 1, "voice-off session keeps the listener alive past ten minutes");
		assert.deepEqual(spot.calls, ["spot.start"], "the same spotter remains open");
		spot.hearing("voice-on");
		await flushIO(() => framesOf(client, "command").some((frame) => frame.type === "command" && frame.command === "voice-on"));
		assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
		assert.deepEqual(framesOf(client, "bye"), []);
	} finally {
		t.mock.timers.reset();
		client.socket.destroy();
		await started.listener.close();
	}
});

test("an unexpected stopped spotter retries and hears the next command", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) } });
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	try {
		spot.stopping();
		await flush();
		assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "capture" }]);
		t.mock.timers.tick(999); await flush();
		assert.equal(spot.starts, 1);
		t.mock.timers.tick(1); await flush();
		assert.equal(spot.starts, 2);
		spot.hearing("voice-on");
		await flush();
		assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
		assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
	} finally {
		t.mock.timers.reset();
		client.socket.destroy();
		await started.listener.close();
	}
});

for (const code of ["not-installed", "model-invalid"] as const) test(`a ${code} spotter failure stays disabled`, async (t) => {
	let starts = 0;
	let reject!: (error: unknown) => void;
	const first = new Promise<void>((_resolve, fail) => { reject = fail; });
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: () => {
		starts++;
		return { start: () => first, heard: () => new Promise(() => {}), stop: async () => {}, cancel: async () => {} };
	} });
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	try {
		reject(new VoiceSessionError(code));
		for (let i = 0; i < 20; i++) await Promise.resolve();
		t.mock.timers.tick(600_001);
		for (let i = 0; i < 20; i++) await Promise.resolve();
		assert.equal(starts, 1);
		assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: code }]);
	} finally {
		t.mock.timers.reset();
		await started.listener.close();
	}
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

test("a stop that arrives while the listener is already collecting is answered once the outcome is known", async (t) => {
	const capture = delayedCapture("hola");
	const started = await startListener(scratch(), { dictation: capture.factory });
	t.after(() => { capture.finish(); return started.listener.close(); });
	const asker = await started.client();
	asker.hello("s-1", "w1:p1");
	await waitFor(() => framesOf(asker, "welcome").length === 1);
	asker.send({ type: "dictate", id: "d1", mode: "dictation" });
	await awaitFrame(asker, (frame) => "id" in frame && frame.id === "d1");

	capture.requests[0]!.onStateChange("finished");
	await waitFor(() => capture.calls.includes("stop"));
	asker.send({ type: "stop", id: "s1" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(asker.frames.some((frame) => "id" in frame && frame.id === "s1"), false, "not answered before the transcript went out");
	capture.finish();
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
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer() });
	t.after(() => started.listener.close());
	await waitFor(() => spot.starts === 1);
	const first = await started.client();
	first.hello("s-1", "w1:p1", true);
	await awaitFrame(first, (frame) => frame.type === "welcome");
	await waitFor(() => started.listener.state === "listening");
	const second = await started.client();
	second.hello("s-2", "w1:p2", true);
	await awaitFrame(second, (frame) => frame.type === "welcome");
	await watchDisplay(first); await watchDisplay(second);
	assert.deepEqual(started.listener.voiceSessions, ["s-1", "s-2"]);
	assert.equal(spot.starts, 1, "the already-open spot-only capture stays open");
	assert.deepEqual(cueLog(started.events), []);
	assert.deepEqual(displayStates(first), ["off"]);
	assert.deepEqual(levelFrames(first), []);
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
	await waitFor(() => displayStates(first).at(-1) === "off");
	assert.deepEqual(displayStates(first), ["off", "asleep", "off"]);
	first.socket.destroy();
	second.socket.destroy();
	quiet.socket.destroy();
});

test("awake spotting logs a voice-on without a focused session and still turns voice off everywhere", async (t) => {
	const spot = fakeSpotting();
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer() });
	t.after(() => started.listener.close());
	const first = await started.client();
	const second = await started.client();
	first.hello("s-1", "w1:p1", true);
	second.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(first, "welcome").length === 1 && framesOf(second, "welcome").length === 1);
	await watchDisplay(first);
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
	assert.ok(displayStates(first).every(state => state === "off" || state === "asleep"));
	assert.deepEqual(cueLog(started.events), []);
	first.socket.destroy();
	second.socket.destroy();
});

test("awake voice-on opens a conversation only for the focused voice-on session (S15)", async (t) => {
	const spot = fakeSpotting();
	const capture = fakeCapture({ text: "seguí por favor" });
	const started = await startListener(scratch(), {
		keyword: keywordOption(), spot: spot.factory, dictation: capture.factory,
		cues: cuePlayer(),
		focus: { focusedPaneId: async () => ({ focused: "w1:p2" }) },
	});
	t.after(() => started.listener.close());
	const other = await started.client();
	const focused = await started.client();
	other.hello("s-1", "w1:p1", true);
	focused.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(other, "welcome").length === 1 && framesOf(focused, "welcome").length === 1 && spot.starts === 1);
	await watchDisplay(other); await watchDisplay(focused);
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
	await waitFor(() => displayStates(focused).includes("listening"));
	assert.equal(displayStates(other).includes("listening"), false);
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
			const focus: ListenerFocus = { focusedPaneId: async () => scenario === "failed" ? { failed: true } : { focused: scenario === "unknown" ? undefined : scenario === "absent" ? "w9:p9" : "w1:p2" } };
			const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), focus });
			st.after(() => started.listener.close());
			const voiced = await started.client();
			voiced.hello("s-1", "w1:p1", true);
			const other = await started.client();
			other.hello("s-2", "w1:p2", scenario === "reader-only", scenario === "reader-only" ? "reading" : "session");
			await waitFor(() => framesOf(voiced, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
			await watchDisplay(voiced);
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
			assert.deepEqual(displayStates(voiced), ["off"]);
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
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, cues: cuePlayer() });
	t.after(() => started.listener.close());
	const client = await started.client();
	client.hello("s-1", "w1:p1", false);
	await waitFor(() => framesOf(client, "welcome").length === 1 && spot.starts === 1);
	await watchDisplay(client);
	await sendSessionVoice(client, true);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "command"), []);
	assert.deepEqual(cueLog(started.events), []);
	assert.deepEqual(spot.calls, ["spot.start"]);
	await waitFor(() => displayStates(client).at(-1) === "off");
	assert.deepEqual(displayStates(client), ["asleep", "off"]);
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
	const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, readTailMs: 500 });
	t.after(() => started.listener.close());
	const reader = await started.client();
	reader.hello("s-1", "w1:p1", true);
	await awaitFrame(reader, (frame) => frame.type === "welcome");
	await watchDisplay(reader);
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
	assert.ok(displayStates(reader).every(state => state !== "listening"));
	assert.deepEqual(levelFrames(reader), []);
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
			const started = await startListener(scratch(), { keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), readTailMs: 1_000 });
			st.after(() => started.listener.close());
			const reader = await started.client();
			const other = await started.client();
			reader.hello("s-1", "w1:p1", true);
			other.hello("s-2", "w1:p2", true);
			await waitFor(() => framesOf(reader, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && spot.starts === 1);
			await watchDisplay(reader);
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
			assert.ok(displayStates(reader).includes("listening"));
			assert.equal(displayStates(reader).at(-1), "off");
		});
	}
});

test("D1: a conversation opened in a reading tail accepts only hits safely after the tail", async (t) => {
	for (const scenario of [
		{ name: "hit in the tail", hitAt: 1_200, accept: false },
		{ name: "latest possible tail echo, including confirmation", hitAt: 4_850, accept: false },
		{ name: "first safe hit after the echo window", hitAt: 4_851, accept: true },
		{ name: "the owner's 4.7 second hit", hitAt: 5_700, accept: true },
	] as const) {
		await t.test(scenario.name, async (st) => {
			let clock = 1_000;
			const spot = fakeSpotting();
			const capture = selfEndingCapture({ command: "voice-off" });
			const started = await startListener(scratch(), { now: () => clock, keyword: keywordOption(), spot: spot.factory, dictation: capture.factory, cues: cuePlayer(), readTailMs: 250 });
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
			clock = 1_030; // the automatic reopen, 30 ms after the reading ended
			reader.send({ type: "dictate", id: "d", mode: "conversation" });
			assert.equal((await awaitFrame(reader, (frame) => "id" in frame && frame.id === "d")).type, "ok");
			if (scenario.hitAt > 1_250) await sleep(300); // let the actual tail timer expire
			clock = scenario.hitAt;
			capture.dies();
			assert.deepEqual(await awaitFrame(reader, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
			other.send({ type: "status", id: "barrier" });
			await awaitFrame(other, (frame) => "id" in frame && frame.id === "barrier");
			assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: scenario.accept ? "whole-utterance" : "ignored:reading" }]);
			assert.deepEqual(started.listener.voiceSessions, scenario.accept ? [] : ["s-1", "s-2"]);
			assert.equal(started.listener.state, scenario.accept ? "asleep" : "listening");
			for (const client of [reader, other]) {
				assert.deepEqual(framesOf(client, "command"), scenario.accept ? [{ type: "command", command: "voice-off" }] : []);
				assert.deepEqual(framesOf(client, "transcript"), []);
			}
			await waitFor(() => cueLog(started.events).length === 2);
			assert.deepEqual(cueLog(started.events).map((cue) => cue?.name), ["open", "close"]);
		});
	}
});

test("D1: a delayed command outcome cannot turn a tail echo into a later hit", async (t) => {
	let clock = 1_000;
	let notify!: (state: VoiceSessionState) => void;
	let complete!: (value: { text: string; truncated: boolean; command: string }) => void;
	const outcome = new Promise<{ text: string; truncated: boolean; command: string }>((resolve) => { complete = resolve; });
	const started = await startListener(scratch(), {
		now: () => clock, readTailMs: 100, keyword: keywordOption(),
		dictation: (request) => {
			notify = request.onStateChange;
			return { start: async () => { notify("recording"); }, stop: () => outcome, cancel: async () => {} };
		},
	});
	t.after(() => started.listener.close());
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	client.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "r");
	client.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "e");
	client.send({ type: "dictate", id: "d", mode: "conversation" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "d");
	clock = 1_050;
	notify("finished"); // the hit was received inside the tail
	await sleep(150);
	clock = 6_000; // delayed result collection must not change its timestamp
	complete({ text: "", truncated: false, command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "no-speech" });
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.hit").map((entry) => entry.fields), [{ command: "voice-off", reason: "ignored:reading" }]);
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(framesOf(client, "command"), []);
	assert.deepEqual(framesOf(client, "transcript"), []);
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
	holdClose = false;
	holdStop = false;
	readonly stdin = {
		on: () => {}, end: () => {},
		write: (line: string) => {
			const message = JSON.parse(line) as Record<string, unknown>;
			this.received.push(message);
			if (message.type === "start") queueMicrotask(() => this.say({ type: message.spot ? "spotting" : "recording" }));
			if (message.type === "stop" && !this.holdStop) queueMicrotask(() => this.say({ type: "stopped" }));
			if (message.type === "close" && !this.holdClose) queueMicrotask(() => this.exit());
			return true;
		},
	};
	say(message: Record<string, unknown>) { this.stdout.emit("data", `${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message })}\n`); }
	kill(signal: string) { this.signals.push(signal); this.exit(); return true; }
	exit() { if (!this.exited) { this.exited = true; this.emit("close", 0, null); } }
}

async function recycleFixture(t: import("node:test").TestContext, options: { failRecycle?: boolean; failFreshSpot?: boolean; readTailMs?: number } = {}) {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => {
			const child = new GatedWarmChild();
			children.push(child);
			if (options.failFreshSpot && children.length === 2) {
				const write = child.stdin.write;
				child.stdin.write = (line: string) => {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (message.type === "start" && message.spot === true) {
						child.received.push(message);
						queueMicrotask(() => { child.say({ type: "error", code: "capture" }); child.exit(); });
						return true;
					}
					return write(line);
				};
			}
			return child;
		},
	});
	let recycleCalls = 0;
	let closeCalls = 0;
	const worker = {
		needsRecycle: () => warm.needsRecycle(),
		recycle: async () => {
			recycleCalls++;
			if (options.failRecycle && recycleCalls === 1) throw new VoiceSessionError("capture");
			return warm.recycle();
		},
		close: async () => { closeCalls++; await warm.close(); },
	};
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		keyword: kws, worker, readTailMs: options.readTailMs,
		spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
	const transcribe = async (id: string) => {
		client.send({ type: "dictate", id, mode: "dictation" });
		assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === id)).type, "ok");
		const child = children.at(-1)!;
		child.say({ type: "transcribing" });
		child.say({ type: "result", text: `text-${id}`, truncated: false });
		await waitFor(() => framesOf(client, "transcript").some((frame) => frame.type === "transcript" && frame.text === `text-${id}`));
		return child;
	};
	return { children, warm, worker, started, client, transcribe, recycleCalls: () => recycleCalls, closeCalls: () => closeCalls };
}

for (const source of ["menu", "spoken"] as const) test(`${source} voice off recycles a transcribed worker and the fresh spotter wakes`, async (t) => {
	const f = await recycleFixture(t);
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	old.holdClose = true;
	if (source === "menu") {
		f.client.send({ type: "set-voice", id: "off", voiceOn: false });
		await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "off");
	} else old.say({ type: "command", command: "voice-off" });
	await waitFor(() => old.received.some((message) => message.type === "close"));
	assert.equal(f.children.length, 1, "the fresh spotter waits until the old child exits");
	assert.equal(f.started.listener.state, "asleep");
	old.exit();
	await waitFor(() => f.children.length === 2 && f.children[1]!.received.some((message) => message.spot === true));
	await waitFor(() => f.started.events.some((entry) => entry.event === "worker.recycled"));
	assert.deepEqual(f.started.events.filter((entry) => entry.event === "worker.recycled").map((entry) => entry.fields), [{ reason: "voice-off" }]);
	assert.equal(f.recycleCalls(), 1);
	const fresh = f.children[1]!;
	await sleep(10);
	fresh.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(f.started.listener.voiceSessions, ["s-1"]);
	assert.equal(await f.transcribe("again"), fresh, "the new child takes the next lazy dictation");
	assert.equal(f.children.length, 2);
});

test("a spot-only worker stays open without a spotting gap when voice goes off", async (t) => {
	const f = await recycleFixture(t);
	const child = f.children[0]!;
	f.client.send({ type: "session-voice", voiceOn: false });
	f.client.send({ type: "status", id: "barrier" });
	await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "barrier");
	await sleep(20);
	assert.equal(f.started.listener.state, "asleep");
	assert.equal(f.children.length, 1);
	assert.equal(child.exited, false);
	assert.deepEqual(child.received.map((message) => message.type), ["start"]);
	assert.equal(f.recycleCalls(), 0);
	assert.equal(f.started.events.some((entry) => entry.event === "worker.recycled"), false);
	child.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
});

test("a capture requested during recycle starts only after the old worker exits", async (t) => {
	const f = await recycleFixture(t);
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	old.holdClose = true;
	f.client.send({ type: "set-voice", id: "off", voiceOn: false });
	await waitFor(() => old.received.some((message) => message.type === "close"));
	f.client.send({ type: "dictate", id: "during", mode: "dictation" });
	await sleep(30);
	assert.equal(f.children.length, 1);
	assert.equal(f.client.frames.some((frame) => "id" in frame && frame.id === "during"), false);
	old.exit();
	assert.equal((await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "during")).type, "ok");
	assert.equal(f.children.length, 2);
	const fresh = f.children[1]!;
	assert.equal(fresh.received.some((message) => message.type === "start" && message.spot !== true), true);
	fresh.say({ type: "transcribing" });
	fresh.say({ type: "result", text: "during recycle", truncated: false });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "transcript" && frame.text === "during recycle"), { type: "transcript", text: "during recycle" });
});

test("a capture requested while the old spotter stops still waits for recycle", async (t) => {
	const f = await recycleFixture(t);
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	const before = old.received.filter((message) => message.type === "stop").length;
	const starts = old.received.filter((message) => message.type === "start").length;
	old.holdStop = true;
	old.holdClose = true;
	f.client.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => old.received.filter((message) => message.type === "stop").length === before + 1);
	f.client.send({ type: "dictate", id: "during-stop", mode: "dictation" });
	await sleep(20);
	old.say({ type: "stopped" });
	await waitFor(() => old.received.some((message) => message.type === "close"), 500);
	assert.equal(old.received.filter((message) => message.type === "start").length, starts, "the capture cannot use the old child");
	assert.equal(f.children.length, 1);
	old.exit();
	assert.equal((await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "during-stop")).type, "ok");
	assert.equal(f.children.length, 2);
	f.children[1]!.say({ type: "transcribing" });
	f.children[1]!.say({ type: "result", text: "after stop", truncated: false });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "transcript" && frame.text === "after stop"), { type: "transcript", text: "after stop" });
});

test("a stuck spot stop is cancelled so a waiting capture can proceed", async (t) => {
	const f = await recycleFixture(t);
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	const stops = old.received.filter((message) => message.type === "stop").length;
	old.holdStop = true;
	f.client.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => old.received.filter((message) => message.type === "stop").length === stops + 1);
	f.client.send({ type: "dictate", id: "waiting", mode: "dictation" });
	await waitFor(() => old.received.some((message) => message.type === "cancel"), 3_000);
	assert.equal(f.children.length, 1, "the replacement waits for the cancelled child to exit");
	assert.ok(f.started.events.some((entry) => entry.event === "kws.failed"));
	old.exit();
	assert.equal((await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "waiting")).type, "ok");
	assert.equal(f.children.length, 2);
	f.children[1]!.say({ type: "transcribing" });
	f.children[1]!.say({ type: "result", text: "after stuck stop", truncated: false });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "transcript" && frame.text === "after stuck stop"), { type: "transcript", text: "after stuck stop" });
});

test("a fresh spot that fails after recycling retries and hears wake", async (t) => {
	const f = await recycleFixture(t, { failFreshSpot: true });
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	f.client.send({ type: "set-voice", voiceOn: false });
	await waitFor(() => f.started.events.some((entry) => entry.event === "kws.failed"));
	assert.equal(old.exited, true);
	assert.equal(f.children[1]!.exited, true);
	assert.equal(f.started.events.filter((entry) => entry.event === "worker.recycled").length, 1);
	await waitFor(() => f.children.length === 3 && f.children[2]!.received.some((message) => message.spot === true));
	await waitFor(() => f.started.events.some((entry) => entry.event === "kws.recovered"));
	f.children[2]!.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
});

test("a recycle failure uses the spot failure backoff and eventually hears wake", async (t) => {
	const f = await recycleFixture(t, { failRecycle: true });
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	f.client.send({ type: "set-voice", id: "off", voiceOn: false });
	await waitFor(() => f.started.events.some((entry) => entry.event === "kws.failed"));
	assert.deepEqual(f.started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "capture" }]);
	await waitFor(() => f.children.length === 2 && f.children[1]!.received.some((message) => message.spot === true));
	assert.equal(f.recycleCalls(), 2);
	assert.equal(f.started.events.filter((entry) => entry.event === "worker.recycled").length, 1);
	await sleep(10);
	f.children[1]!.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(f.client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
});

test("a voiced session prevents recycling when another session turns off", async (t) => {
	const f = await recycleFixture(t);
	const child = await f.transcribe("first");
	await waitFor(() => child.received.filter((message) => message.spot === true).length === 2);
	const other = await f.started.client();
	other.hello("s-2", "w1:p2", true);
	await awaitFrame(other, (frame) => frame.type === "welcome");
	f.client.send({ type: "session-voice", voiceOn: false });
	f.client.send({ type: "status", id: "barrier" });
	await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "barrier");
	await sleep(30);
	assert.deepEqual(f.started.listener.voiceSessions, ["s-2"]);
	assert.equal(child.exited, false);
	assert.equal(f.recycleCalls(), 0);
	assert.equal(f.started.events.some((entry) => entry.event === "worker.recycled"), false);
	other.socket.destroy();
});

for (const pending of ["capture", "reading"] as const) test(`voice off waits for the active ${pending} before recycling`, async (t) => {
	const f = await recycleFixture(t, { readTailMs: 100 });
	const old = await f.transcribe("first");
	await waitFor(() => old.received.filter((message) => message.spot === true).length === 2);
	if (pending === "capture") {
		f.client.send({ type: "dictate", id: "active", mode: "dictation" });
		await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "active");
	} else {
		f.client.send({ type: "read-begin", id: "read", readingId: "r1", chars: 30 });
		assert.equal((await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "read")).type, "granted");
	}
	f.client.send({ type: "set-voice", id: "off", voiceOn: false });
	await awaitFrame(f.client, (frame) => "id" in frame && frame.id === "off");
	await sleep(20);
	assert.equal(old.exited, false);
	assert.equal(f.recycleCalls(), 0, "the active turn has not settled");
	if (pending === "capture") {
		old.say({ type: "transcribing" });
		old.say({ type: "result", text: "still delivered", truncated: false });
		await awaitFrame(f.client, (frame) => frame.type === "transcript" && frame.text === "still delivered");
	}
	await waitFor(() => old.exited && f.children.length === 2);
	assert.equal(f.recycleCalls(), 1);
});

for (const reason of ["idle", "shutdown", "error"] as const) test(`listener ${reason} closes its warm worker`, async (t) => {
	const children: GatedWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
	});
	let closes = 0;
	const worker = { needsRecycle: () => warm.needsRecycle(), recycle: () => warm.recycle(), close: async () => { closes++; await warm.close(); } };
	const kws = keywordOption();
	const started = await startListener(scratch(), { idleMs: reason === "idle" ? 40 : 60_000, keyword: kws, worker, spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }) });
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	await waitFor(() => children[0]?.received.some((message) => message.spot === true) === true);
	if (reason === "idle") await waitFor(() => started.events.some((entry) => entry.event === "listener.exit"));
	else await started.listener.close(reason);
	assert.equal(closes, 1);
	assert.equal(children[0]!.exited, true);
	assert.ok(children[0]!.received.some((message) => message.type === "close"));
});

test("late native diagnostics from dictation and spotting reach the listener event log", async (t) => {
	for (const mode of ["dictation", "spot"] as const) {
		await t.test(mode, async (st) => {
			const children: GatedWarmChild[] = [];
			const kws = keywordOption();
			const warm = createWarmVoiceWorker({
				target: "linux-x64", env: {},
				prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
				spawn: () => { const child = new GatedWarmChild(); children.push(child); return child; },
				onNativeError: (error) => started.listener.reportNativeCaptureError(error),
			});
			const started = await startListener(scratch(), {
				...(mode === "spot" ? { keyword: kws, spot: (onKeywordRejected: Parameters<ListenerSpotFactory>[0]) => warm.spot({ kws, onKeywordRejected }) } : {}),
				dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
			});
			st.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
			const client = await started.client();
			client.hello("s-1", "w1:p1");
			await awaitFrame(client, (frame) => frame.type === "welcome");
			if (mode === "dictation") {
				client.send({ type: "dictate", mode: "dictation" });
				await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "recording");
			}
			await waitFor(() => children[0]?.received.some((message) => message.type === "start") === true);
			children[0]!.say({ type: "error", code: "capture" });
			if (mode === "spot") await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
			else await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed");
			children[0]!.stderr.emit("data", "gentle-voice-diag capture stream:DEVICE_BUSY\n");
			assert.deepEqual(started.events.filter((entry) => entry.event === "capture.native"), [{ event: "capture.native", fields: { phase: "stream", kind: "DEVICE_BUSY" } }]);
			assert.equal(started.events.filter((entry) => entry.event === (mode === "spot" ? "kws.failed" : "capture.failed")).length, 1);
		});
	}
});

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

// The native device can refuse the first reopen after a delivered capture.
// The worker sends capture as its terminal error and may exit later.
class RefusingWarmChild extends EventEmitter {
	readonly received: Array<Record<string, unknown>> = [];
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	exited = false;
	refuseNextStart = false;
	readonly stdin = {
		on: () => {}, end: () => {},
		write: (line: string) => {
			const message = JSON.parse(line) as Record<string, unknown>;
			this.received.push(message);
			if (message.type === "start") {
				const refused = this.refuseNextStart;
				this.refuseNextStart = false;
				queueMicrotask(() => this.say(refused ? { type: "error", code: "capture" } : { type: message.spot ? "spotting" : "recording" }));
			}
			if (message.type === "stop") queueMicrotask(() => this.say({ type: "stopped" }));
			if (message.type === "close" || message.type === "cancel") queueMicrotask(() => this.exit());
			return true;
		},
	};
	say(message: Record<string, unknown>) { this.stdout.emit("data", `${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message })}\n`); }
	kill() { this.exit(); return true; }
	exit() { if (!this.exited) { this.exited = true; this.emit("close", 0, null); } }
}

test("D2-R1: a warm child exiting during spot start is replaced and hears off then on", async (t) => {
	const children: RefusingWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => {
			const child = new RefusingWarmChild();
			children.push(child);
			if (children.length === 1) {
				const write = child.stdin.write;
				child.stdin.write = (line: string) => {
					const message = JSON.parse(line) as Record<string, unknown>;
					if (message.type === "start" && message.spot === true) {
						child.received.push(message);
						queueMicrotask(() => child.exit());
						return true;
					}
					return write(line);
				};
			}
			return child;
		},
	});
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		keyword: kws, spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	await waitFor(() => started.events.some((entry) => entry.event === "kws.failed"));
	assert.equal(children[0]!.exited, true);
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "worker-exited" }]);
	await waitFor(() => children.length === 2 && children[1]!.received.some((message) => message.spot === true));
	await waitFor(() => started.events.some((entry) => entry.event === "kws.recovered"));
	children[1]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	await waitFor(() => children[1]!.received.filter((message) => message.spot === true).length === 2);
	children[1]!.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "transcript"), []);
	assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
});

test("D2-R1: repeated start failures use bounded backoff and one failure episode", async (t) => {
	const starts: number[] = [];
	let failFirst!: (error: unknown) => void;
	const first = new Promise<void>((_resolve, reject) => { failFirst = reject; });
	const errors = [new VoiceSessionError("capture"), new VoiceSessionError("invalid-state"), new Error("private device"), new VoiceSessionError("capture")];
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: () => {
			const attempt = starts.length;
			starts.push(attempt === 0 ? 0 : Date.now());
			return {
				start: () => attempt === 0 ? first : attempt <= errors.length ? Promise.reject(errors[attempt - 1]) : Promise.resolve(),
				heard: () => new Promise<string | undefined>(() => {}),
				waitUntilSettled: async () => {}, stop: async () => {}, cancel: async () => {},
			};
		},
	});
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	try {
		failFirst(new VoiceSessionError("worker-exited"));
		await flush();
		for (const delay of [1_000, 5_000, 30_000, 60_000, 60_000]) {
			const previous = starts.length;
			t.mock.timers.tick(delay - 1); await flush();
			assert.equal(starts.length, previous, "no early retry");
			t.mock.timers.tick(1); await flush();
			assert.equal(starts.length, previous + 1);
		}
		assert.deepEqual(starts, [0, 1_000, 6_000, 36_000, 96_000, 156_000]);
		assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "worker-exited" }]);
		assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
		assert.equal(JSON.stringify(started.events).includes("private device"), false);
	} finally {
		t.mock.timers.reset();
		await started.listener.close();
	}
});

test("D2: a delivered capture's refused reopen waits for exit, retries, and hears off then on", async (t) => {
	const children: RefusingWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new RefusingWarmChild(); children.push(child); return child; },
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
	client.send({ type: "dictate", id: "d", mode: "conversation", endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "d")).type, "ok");
	const child = children[0]!;
	child.say({ type: "transcribing" });
	child.refuseNextStart = true;
	child.say({ type: "result", text: "seguí con eso", truncated: false });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "transcript"), { type: "transcript", text: "seguí con eso" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	await waitFor(() => child.received.filter((message) => message.type === "start").length === 3);
	await sleep(50);
	assert.equal(children.length, 1, "the refused worker has not exited yet");
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "capture" }]);
	child.exit();
	await waitFor(() => children.length === 2 && children[1]!.received.some((message) => message.spot === true));
	assert.equal(started.listener.state, "listening");
	children[1]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	await waitFor(() => children[1]!.received.filter((message) => message.spot === true).length === 2);
	children[1]!.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "seguí con eso" }]);
	assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
});

test("D2: a spotting device that repeatedly fails after opening retries with backoff", async (t) => {
	const starts: number[] = [];
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: () => ({
			start: async () => { starts.push(Date.now()); },
			heard: async () => { throw new VoiceSessionError("capture"); },
			waitUntilSettled: async () => {},
			stop: async () => {},
			cancel: async () => {},
		}),
	});
	t.after(() => started.listener.close());
	await waitFor(() => starts.length >= 3, 8_000);
	assert.ok(starts[2]! - starts[1]! >= 4_900, `the second retry backs off, got ${starts[2]! - starts[1]!} ms`);
	assert.ok(started.events.some((entry) => entry.event === "kws.failed"));
});

test("D1/D2: a delivered turn, reading, automatic reopen, off and wake reach the focused session", async (t) => {
	let clock = 1_000;
	const children: RefusingWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new RefusingWarmChild(); children.push(child); return child; },
	});
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		now: () => clock, readTailMs: 250, keyword: kws,
		spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	const other = await started.client();
	client.hello("s-1", "w1:p1", true);
	other.hello("s-2", "w1:p2", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && framesOf(other, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
	const child = children[0]!;
	client.send({ type: "dictate", id: "first", mode: "conversation", endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "first")).type, "ok");
	child.say({ type: "transcribing" });
	child.say({ type: "result", text: "seguí con eso", truncated: false });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "delivered"), { type: "capture", phase: "delivered" });
	await waitFor(() => child.received.filter((message) => message.spot === true).length === 2);
	client.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "r")).type, "granted");
	client.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "e");
	clock = 1_030;
	client.send({ type: "dictate", id: "auto", mode: "conversation", endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "auto")).type, "ok");
	await sleep(300);
	clock = 5_700;
	child.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(other, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.equal(started.listener.state, "asleep");
	assert.deepEqual(started.listener.voiceSessions, []);
	await waitFor(() => child.received.filter((message) => message.spot === true).length === 3);
	// A session's in-flight agent turn has no listener-protocol state: wake must
	// be addressed to the focused session without waiting for another reply.
	child.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(await awaitFrame(other, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on" });
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "seguí con eso" }]);
	assert.deepEqual(framesOf(other, "transcript"), []);
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
});

test("D2: an auto-reopened capture's own delayed capture error releases before spotting resumes", async (t) => {
	let clock = 1_000;
	const children: RefusingWarmChild[] = [];
	const warm = createWarmVoiceWorker({
		target: "linux-x64", env: {},
		prepare: async () => ({ root: "/fake", request: { schema: VOICE_WORKER_SCHEMA, type: "start" } }),
		spawn: () => { const child = new RefusingWarmChild(); children.push(child); return child; },
	});
	const kws = keywordOption();
	const started = await startListener(scratch(), {
		now: () => clock, readTailMs: 100, keyword: kws,
		spot: (onKeywordRejected) => warm.spot({ kws, onKeywordRejected }),
		dictation: ({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws: option, onKeywordRejected }),
		focus: { focusedPaneId: async () => ({ focused: "w1:p1" }) },
	});
	t.after(async () => { for (const child of children) child.exit(); await started.listener.close(); await warm.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await waitFor(() => framesOf(client, "welcome").length === 1 && children[0]?.received.some((message) => message.spot === true) === true);
	const child = children[0]!;
	client.send({ type: "read-begin", id: "r", readingId: "read-1", chars: 30 });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "r");
	client.send({ type: "read-end", id: "e", readingId: "read-1", outcome: "done" });
	await awaitFrame(client, (frame) => "id" in frame && frame.id === "e");
	clock = 1_030;
	client.send({ type: "dictate", id: "auto", mode: "conversation" });
	assert.equal((await awaitFrame(client, (frame) => "id" in frame && frame.id === "auto")).type, "ok");
	clock = 6_283; // the capture itself reports a device failure about 5 s later
	child.say({ type: "error", code: "capture" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "capture" && frame.phase === "failed"), { type: "capture", phase: "failed", code: "capture" });
	await sleep(150);
	assert.equal(child.received.filter((message) => message.spot === true).length, 1, "no spot start while the failed capture's child is still exiting");
	assert.equal(children.length, 1);
	assert.equal(started.events.some((entry) => entry.event === "kws.failed"), false);
	child.exit();
	await waitFor(() => children.length === 2 && children[1]!.received.some((message) => message.spot === true));
	children[1]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	await waitFor(() => children[1]!.received.filter((message) => message.spot === true).length === 2);
	children[1]!.say({ type: "command", command: "voice-on" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-on"), { type: "command", command: "voice-on", wake: true });
	assert.deepEqual(started.listener.voiceSessions, ["s-1"]);
	assert.equal(started.listener.state, "listening");
	assert.deepEqual(framesOf(client, "transcript"), []);
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
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "invalid-state" }]);
	const ending = busy.cancel();
	children[0]!.exit();
	await ending;
	await waitFor(() => spotAttempts === 3 && children[1]?.received.some((message) => message.spot === true) === true);
	assert.deepEqual(framesOf(client, "transcript"), [{ type: "transcript", text: "hola" }]);
	assert.equal(started.events.filter((entry) => entry.event === "kws.recovered").length, 1);
	children[1]!.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.equal(started.listener.state, "asleep");
	client.socket.destroy();
});

test("D2: repeated busy spot refusals each wait for settlement and eventually recover", async (t) => {
	let attempts = 0;
	const release: Array<() => void> = [];
	const gates = Array.from({ length: 2 }, () => new Promise<void>((resolve) => { release.push(resolve); }));
	const replacement = fakeSpotting();
	const started = await startListener(scratch(), {
		keyword: keywordOption(),
		spot: (onKeywordRejected) => {
			const attempt = attempts++;
			if (attempt >= gates.length) return replacement.factory(onKeywordRejected);
			return {
				start: async () => { throw new VoiceSessionError("invalid-state"); },
				waitUntilSettled: () => gates[attempt]!,
				heard: async () => undefined,
				stop: async () => {},
				cancel: async () => {},
			};
		},
	});
	t.after(() => { for (const done of release) done(); return started.listener.close(); });
	const client = await started.client();
	client.hello("s-1", "w1:p1", true);
	await awaitFrame(client, (frame) => frame.type === "welcome");
	assert.equal(attempts, 1);
	release[0]!();
	await waitFor(() => attempts === 2);
	await sleep(20);
	assert.equal(attempts, 2, "the second refusal also waits instead of spinning");
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "invalid-state" }]);
	release[1]!();
	await waitFor(() => attempts === 3 && replacement.starts === 1, 7_000);
	replacement.hearing("voice-off");
	assert.deepEqual(await awaitFrame(client, (frame) => frame.type === "command" && frame.command === "voice-off"), { type: "command", command: "voice-off" });
	assert.deepEqual(started.listener.voiceSessions, []);
	assert.equal(started.listener.state, "asleep");
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
	assert.deepEqual(started.events.filter((entry) => entry.event === "kws.failed").map((entry) => entry.fields), [{ reason: "invalid-state" }]);
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
