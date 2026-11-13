import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeTest from "node:test";
import { VoiceSessionError, VOICE_WORKER_SCHEMA, type VoiceSessionState } from "../lib/voice-session.ts";
import { createWarmVoiceWorker } from "../lib/voice-warm.ts";

// The warm dictation worker (S11): one worker process kept alive between
// recordings, so the model is verified and loaded once. Fake processes only.

const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 5_000 }, fn);

class FakeWorker extends EventEmitter {
	readonly received: Array<Record<string, unknown>> = [];
	readonly signals: string[] = [];
	ended = false;
	exited = false;
	// Like the real worker, it leaves on cancel or close unless told to hang.
	stubborn = false;
	stdin = {
		write: (chunk: string) => {
			for (const line of chunk.split("\n").filter(Boolean)) {
				const message = JSON.parse(line);
				this.received.push(message);
				if (!this.stubborn && (message.type === "cancel" || message.type === "close")) queueMicrotask(() => this.exit());
			}
			return true;
		},
		end: () => { this.ended = true; },
		on: () => {},
	};
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(signal: string) {
		this.signals.push(signal);
		queueMicrotask(() => this.exit());
		return true;
	}
	exit() {
		if (this.exited) return;
		this.exited = true;
		this.emit("close", 0, null);
	}
	say(message: Record<string, unknown>) {
		this.stdout.emit("data", `${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message })}\n`);
	}
}

const BASE_REQUEST = { schema: VOICE_WORKER_SCHEMA, type: "start", target: "linux-x64", maxRecordingMs: 120000, numThreads: 4, runtime: { root: "/r", files: [] }, model: { root: "/m", files: {} } };

function harness(options: { idleMs?: number; prepareError?: VoiceSessionError } = {}) {
	const workers: FakeWorker[] = [];
	const launches: Array<{ executable: string; args: string[]; cwd: string; env: Record<string, unknown> }> = [];
	let prepares = 0;
	const warm = createWarmVoiceWorker({
		target: "linux-x64",
		env: { HOME: "/home/someone", SECRET_TOKEN: "abc" },
		workerPath: "/fixed/voice-worker.cjs",
		idleMs: options.idleMs ?? 60_000,
		prepare: async () => {
			prepares++;
			if (options.prepareError) throw options.prepareError;
			return { root: "/r", request: { ...BASE_REQUEST } };
		},
		spawn: (executable, args, spawnOptions) => {
			launches.push({ executable, args, cwd: spawnOptions.cwd, env: spawnOptions.env as Record<string, unknown> });
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		},
	});
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(check(), "condition not reached");
	};
	return { warm, workers, launches, until, prepares: () => prepares };
}

// One full recording on the current worker.
async function record(h: ReturnType<typeof harness>, text: string, endpoint = { endOfSpeechMs: 1200, noSpeechMs: 8000 }) {
	const states: VoiceSessionState[] = [];
	const dictation = h.warm.session({ onStateChange: (state) => states.push(state), endpoint });
	const started = dictation.start();
	await h.until(() => h.workers.length > 0 && h.workers.at(-1)!.received.some((message) => message.type === "start" && !(message as { _seen?: boolean })._seen));
	const worker = h.workers.at(-1)!;
	const request = worker.received.findLast((message) => message.type === "start")!;
	(request as { _seen?: boolean })._seen = true;
	worker.say({ type: "recording" });
	await started;
	const stopped = dictation.stop();
	worker.say({ type: "transcribing" });
	worker.say({ type: "result", text, truncated: false });
	return { transcript: await stopped, states, request, worker };
}

test("recordings reuse one kept-alive worker with a fixed, scrubbed launch", async () => {
	const h = harness();
	const first = await record(h, "  hola  ");
	assert.deepEqual(first.transcript, { text: "hola", truncated: false });
	assert.deepEqual(first.states, ["starting", "recording", "transcribing", "finished"]);
	assert.equal(first.request.keepAlive, true);
	assert.deepEqual(first.request.endpoint, { endOfSpeechMs: 1200, noSpeechMs: 8000 });
	assert.equal(first.worker.exited, false, "the worker stays alive");
	const second = await record(h, "otra vez");
	assert.equal(second.worker, first.worker, "the same worker answers the next recording");
	assert.equal(h.workers.length, 1);
	assert.equal(h.prepares(), 2, "the install is checked for every recording");
	const [launch] = h.launches;
	assert.deepEqual(launch!.args, ["/fixed/voice-worker.cjs"]);
	assert.equal(launch!.cwd, "/r");
	assert.deepEqual(Object.keys(launch!.env).sort(), ["GENTLE_PI_AGENTS_CHILD", "HOME", "NODE_NO_WARNINGS"]);
	await h.warm.close();
	assert.deepEqual(first.worker.received.at(-1), { schema: VOICE_WORKER_SCHEMA, type: "close" });
});

test("a blank transcript is no speech, and the worker stays for the next recording", async () => {
	const h = harness();
	await assert.rejects(record(h, "   ").then((result) => result.transcript), (error: unknown) => error instanceof VoiceSessionError && error.code === "no-speech");
	assert.equal(h.workers[0]!.exited, false);
	await record(h, "ahora sí");
	assert.equal(h.workers.length, 1);
});

test("cancel ends the worker and the next recording starts a new one", async () => {
	const h = harness();
	const dictation = h.warm.session({ onStateChange: () => {} });
	const started = dictation.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	h.workers[0]!.say({ type: "recording" });
	await started;
	await dictation.cancel();
	assert.deepEqual(h.workers[0]!.received.at(-1), { schema: VOICE_WORKER_SCHEMA, type: "cancel" });
	assert.equal(h.workers[0]!.exited, true);
	await record(h, "de nuevo");
	assert.equal(h.workers.length, 2);
});

test("a worker error fails that recording, and a crash between recordings is replaced", async () => {
	const h = harness();
	const dictation = h.warm.session({ onStateChange: () => {} });
	const started = dictation.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	h.workers[0]!.say({ type: "error", code: "no-input-device" });
	h.workers[0]!.exit();
	await assert.rejects(started, (error: unknown) => error instanceof VoiceSessionError && error.code === "no-input-device");
	await record(h, "uno");
	h.workers[1]!.exit();
	await record(h, "dos");
	assert.equal(h.workers.length, 3);
});

test("one recording at a time", async () => {
	const h = harness();
	const first = h.warm.session({ onStateChange: () => {} });
	const started = first.start();
	const second = h.warm.session({ onStateChange: () => {} });
	await assert.rejects(second.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	h.workers[0]!.say({ type: "recording" });
	await started;
	await first.cancel();
});

test("an idle worker closes by itself, and close kills one that does not exit", async () => {
	const h = harness({ idleMs: 20 });
	const { worker } = await record(h, "hola");
	await h.until(() => worker.received.at(-1)?.type === "close" && worker.exited);
	const h2 = harness();
	const { worker: stubborn } = await record(h2, "hola");
	stubborn.stubborn = true;
	const closing = h2.warm.close(10);
	await closing;
	assert.deepEqual(stubborn.signals, ["SIGKILL"]);
});

test("a missing install fails before any worker is started", async () => {
	const h = harness({ prepareError: new VoiceSessionError("not-installed") });
	await assert.rejects(h.warm.session({ onStateChange: () => {} }).start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "not-installed");
	assert.equal(h.workers.length, 0);
});

// --- levels (T4, S5) -----------------------------------------------------------------

test("a warm session asks for levels when it wants them and hands them over", async () => {
	const h = harness();
	const levels: number[] = [];
	const dictation = h.warm.session({ onStateChange: () => {}, levels: true, onLevel: (rms) => levels.push(rms) });
	const started = dictation.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	assert.equal(worker.received[0]!.levels, true, "the start request asks for them");
	worker.say({ type: "recording" });
	await started;
	worker.say({ type: "level", rms: 0.02 });
	worker.say({ type: "level", rms: 0 });
	assert.deepEqual(levels, [0.02, 0]);
	const stopped = dictation.stop();
	worker.say({ type: "transcribing" });
	worker.say({ type: "result", text: "hola", truncated: false });
	assert.deepEqual(await stopped, { text: "hola", truncated: false });
	assert.equal(worker.exited, false, "levels never end the kept-alive worker");
	await h.warm.close();
});

test("without levels the warm start request is unchanged and a stray level is ignored", async () => {
	const h = harness();
	const first = await record(h, "hola");
	assert.equal(Object.hasOwn(first.request, "levels"), false, "no levels key in the start request");
	const dictation = h.warm.session({ onStateChange: () => {} });
	const started = dictation.start();
	await h.until(() => h.workers.at(-1)!.received.some((message) => message.type === "start" && !("_seen" in message)));
	const worker = h.workers.at(-1)!;
	worker.say({ type: "recording" });
	await started;
	worker.say({ type: "level", rms: 0.5 });
	const stopped = dictation.stop();
	worker.say({ type: "transcribing" });
	worker.say({ type: "result", text: "otra", truncated: false });
	assert.deepEqual(await stopped, { text: "otra", truncated: false }, "a level is not a protocol error");
	await h.warm.close();
});
