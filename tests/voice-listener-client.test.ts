import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { cutListenerReading, ensureListener, listenerReadingTurn, VoiceListenerClient } from "../lib/voice-listener-client.ts";
import { listenerPaths, readListenerLock, takeListenerLock, VoiceListener } from "../lib/voice-listener.ts";
import type { ListenerFrame } from "../lib/voice-listener-protocol.ts";

// The session side of the one voice listener (S6, slice A): join the running
// listener, start it once when it is not there, survive a stale socket or a
// dead locker, and reconnect after a restart. Every socket is bound in a
// scratch voice home under tmp/, except one test that runs the real
// scripts/voice-listener.mjs entry point; every child is stopped before the
// test ends and the real ~/.pi/gentle-ai/voice is never touched.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const dirs: string[] = [];
const children: ChildProcess[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-client-"));
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

const session = (sessionId: string, voiceOn = true) => ({ sessionId, paneId: "w1:p1", voiceOn });

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
