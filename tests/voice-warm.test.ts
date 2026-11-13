import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import nodeTest from "node:test";
import { parseWorkerLine, VoiceSessionError, VOICE_SESSION_DEFAULTS, VOICE_WORKER_SCHEMA, type VoiceSessionState } from "../lib/voice-session.ts";
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

nodeTest("a long endpoint-ended recording reuses the worker for spotting", { timeout: 5_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const dictation = h.warm.session({ onStateChange: () => {}, kws: KWS });
	const recording = dictation.start();
	await Promise.resolve();
	assert.equal(h.workers.length, 1);
	const child = h.workers[0]!;
	child.say({ type: "recording" });
	await recording;
	// The incident's endpoint arrived after almost a minute, without a stop.
	t.mock.timers.tick(58_000);
	child.say({ type: "transcribing" });
	const result = dictation.stop();
	child.say({ type: "result", text: "seguí con eso", truncated: false });
	assert.deepEqual(await result, { text: "seguí con eso", truncated: false });
	const spot = h.warm.spot({ kws: KWS });
	const spotting = spot.start();
	await Promise.resolve();
	assert.equal(child.received.filter((message) => message.type === "start").length, 2);
	child.say({ type: "spotting" });
	await spotting;
	const heard = spot.heard();
	child.say({ type: "command", command: "voice-off" });
	assert.equal(await heard, "voice-off");
	await h.warm.close();
});

nodeTest("a start timeout still fails the capture and kills its child", { timeout: 5_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const started = h.warm.session({ onStateChange: () => {} }).start();
	const failed = assert.rejects(started, (error: unknown) => error instanceof VoiceSessionError && error.code === "timeout");
	await Promise.resolve();
	assert.equal(h.workers.length, 1);
	t.mock.timers.tick(120_000);
	await failed;
	assert.deepEqual(h.workers[0]!.signals, ["SIGKILL"]);
	await h.warm.close();
});

test("an error leaves the next capture waiting until the old child has exited", async () => {
	const h = harness();
	const first = h.warm.session({ onStateChange: () => {} });
	const started = first.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const old = h.workers[0]!;
	old.say({ type: "recording" });
	await started;
	const stopped = first.stop();
	old.say({ type: "error", code: "decode" });
	await assert.rejects(stopped, (error: unknown) => error instanceof VoiceSessionError && error.code === "decode");
	const next = h.warm.spot({ kws: KWS });
	const nextStarted = next.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(h.workers.length, 1);
	assert.equal(old.received.filter((message) => message.type === "start").length, 1, "nothing is sent to the exiting worker");
	old.exit();
	await h.until(() => h.workers.length === 2 && h.workers[1]!.received.some((message) => message.type === "start"));
	h.workers[1]!.say({ type: "spotting" });
	await nextStarted;
	const heard = next.heard();
	h.workers[1]!.say({ type: "command", command: "voice-off" });
	assert.equal(await heard, "voice-off", "the old close did not fail the new capture");
	await h.warm.close();
});

test("a terminal error settles its result before the capture reports microphone release", async () => {
	const h = harness();
	const capture = h.warm.session({ onStateChange: () => {} });
	const started = capture.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const child = h.workers[0]!;
	try {
		child.say({ type: "recording" });
		await started;
		const outcome = capture.stop();
		child.say({ type: "error", code: "decode" });
		await assert.rejects(outcome, (error: unknown) => error instanceof VoiceSessionError && error.code === "decode");
		let released = false;
		const waiting = capture.waitUntilReleased().then(() => { released = true; });
		await Promise.resolve();
		assert.equal(released, false, "the error is not the child's exit");
		child.exit();
		await waiting;
		assert.equal(released, true);
	} finally {
		child.exit();
		await h.warm.close();
	}
});

nodeTest("a terminal error kills a stuck child at the existing grace timeout before releasing the microphone", { timeout: 5_000 }, async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const h = harness();
	const capture = h.warm.session({ onStateChange: () => {} });
	const started = capture.start();
	await Promise.resolve();
	const child = h.workers[0]!;
	try {
		child.say({ type: "recording" });
		await started;
		const outcome = capture.stop();
		child.say({ type: "error", code: "decode" });
		await assert.rejects(outcome, (error: unknown) => error instanceof VoiceSessionError && error.code === "decode");
		let released = false;
		const waiting = capture.waitUntilReleased().then(() => { released = true; });
		t.mock.timers.tick(VOICE_SESSION_DEFAULTS.exitGraceMs - 1);
		await Promise.resolve();
		assert.deepEqual(child.signals, []);
		assert.equal(released, false);
		t.mock.timers.tick(1);
		await waiting;
		assert.deepEqual(child.signals, ["SIGKILL"]);
		assert.equal(child.exited, true);
		assert.equal(released, true);
	} finally {
		child.exit();
		await h.warm.close();
	}
});

test("a normal result releases the capture while retaining the warm worker for the next recording", async () => {
	const h = harness();
	const capture = h.warm.session({ onStateChange: () => {} });
	const started = capture.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const child = h.workers[0]!;
	try {
		child.say({ type: "recording" });
		await started;
		let released = false;
		const waiting = capture.waitUntilReleased().then(() => { released = true; });
		await Promise.resolve();
		assert.equal(released, false);
		const outcome = capture.stop();
		child.say({ type: "transcribing" });
		child.say({ type: "result", text: "hola", truncated: false });
		assert.deepEqual(await outcome, { text: "hola", truncated: false });
		await waiting;
		assert.equal(released, true);
		assert.equal(child.exited, false);
		(child.received[0] as { _seen?: boolean })._seen = true;
		assert.equal((await record(h, "otra vez")).worker, child);
	} finally {
		child.exit();
		await h.warm.close();
	}
});

test("a retried busy dictation reports release for its own recording, not the former owner", async () => {
	const h = harness();
	const first = h.warm.session({ onStateChange: () => {} });
	const started = first.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	h.workers[0]!.say({ type: "recording" });
	await started;
	const second = h.warm.session({ onStateChange: () => {} });
	try {
		await assert.rejects(second.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
		await first.cancel();
		const retried = second.start();
		await h.until(() => h.workers.length === 2 && h.workers[1]!.received.length === 1);
		const child = h.workers[1]!;
		child.say({ type: "recording" });
		await retried;
		let released = false;
		const waiting = second.waitUntilReleased().then(() => { released = true; });
		await Promise.resolve();
		assert.equal(released, false, "the retried recording still owns the microphone");
		const outcome = second.stop();
		child.say({ type: "transcribing" });
		child.say({ type: "result", text: "hola", truncated: false });
		await outcome;
		await waiting;
		assert.equal(released, true);
	} finally {
		for (const child of h.workers) child.exit();
		await h.warm.close();
	}
});

test("a refused spot start can wait for the owning warm capture to finish cancellation", async () => {
	const h = harness();
	const first = h.warm.session({ onStateChange: () => {} });
	const started = first.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const old = h.workers[0]!;
	old.say({ type: "recording" });
	await started;
	const refused = h.warm.spot({ kws: KWS });
	await assert.rejects(refused.start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
	let settled = false;
	const ready = refused.waitUntilSettled().then(() => { settled = true; });
	old.stubborn = true;
	const cancelling = first.cancel();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(settled, false, "the microphone is still held by the cancelling child");
	old.exit();
	await cancelling;
	await ready;
	const next = h.warm.spot({ kws: KWS });
	const nextStarted = next.start();
	await h.until(() => h.workers.length === 2 && h.workers[1]!.received.length === 1);
	h.workers[1]!.say({ type: "spotting" });
	await nextStarted;
	const heard = next.heard();
	h.workers[1]!.say({ type: "command", command: "voice-off" });
	assert.equal(await heard, "voice-off");
	await h.warm.close();
});

test("a start cancelled while an old worker retires does not open a replacement", async () => {
	const h = harness();
	const first = h.warm.session({ onStateChange: () => {} });
	const started = first.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const old = h.workers[0]!;
	old.say({ type: "recording" });
	await started;
	const stopped = first.stop();
	old.say({ type: "error", code: "decode" });
	await assert.rejects(stopped, (error: unknown) => error instanceof VoiceSessionError && error.code === "decode");
	const next = h.warm.spot({ kws: KWS });
	const nextStarted = next.start();
	const rejected = assert.rejects(nextStarted, (error: unknown) => error instanceof VoiceSessionError && error.code === "cancelled");
	const cancelling = next.cancel();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(h.workers.length, 1);
	old.exit();
	await cancelling;
	await rejected;
	assert.equal(h.workers.length, 1, "the cancelled start never launches a new child");
	await h.warm.close();
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

// --- spoken commands (T15, S7/S4) ---------------------------------------------

const KWS = {
	model: { root: "/kws", files: {} },
	keywords: [{ tokens: "▁G ENT LE ▁ VO IC E ▁OF F", command: "voice-off" }],
	boost: 2,
	threshold: 0.25,
	maxActivePaths: 16,
	trailingBlanks: 2,
};

test("a warm session that asks for keywords forwards the option and ends on a command instead of a transcript", async () => {
	const h = harness();
	const states: VoiceSessionState[] = [];
	const dictation = h.warm.session({ onStateChange: (state) => states.push(state), kws: KWS });
	const started = dictation.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	assert.deepEqual(worker.received[0]!.kws, KWS, "the start request carries the option as given");
	assert.equal(Object.hasOwn(worker.received[0]!, "spot"), false);
	worker.say({ type: "recording" });
	await started;
	worker.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await dictation.stop(), { text: "", truncated: false, command: "voice-off" });
	assert.deepEqual(states, ["starting", "recording", "finished"]);
	assert.equal(worker.received.some((message) => message.type === "stop"), false, "nothing is left to stop");
	assert.equal(worker.exited, false, "the worker stays for the next recording");
	// A command the worker found while it was ending the recording counts too.
	const second = h.warm.session({ onStateChange: () => {}, kws: KWS });
	const secondStarted = second.start();
	await h.until(() => worker.received.filter((message) => message.type === "start").length === 2);
	worker.say({ type: "recording" });
	await secondStarted;
	const stopped = second.stop();
	worker.say({ type: "command", command: "voice-off" });
	assert.deepEqual(await stopped, { text: "", truncated: false, command: "voice-off" });
	await h.warm.close();
});

test("without the keyword option the warm start request is unchanged and a stray command is ignored", async () => {
	const h = harness();
	const dictation = h.warm.session({ onStateChange: () => {} });
	const started = dictation.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	assert.deepEqual(worker.received[0], { ...BASE_REQUEST, keepAlive: true });
	worker.say({ type: "recording" });
	await started;
	worker.say({ type: "command", command: "voice-off" });
	worker.say({ type: "stopped" });
	const stopped = dictation.stop();
	worker.say({ type: "transcribing" });
	worker.say({ type: "result", text: "hola", truncated: false });
	assert.deepEqual(await stopped, { text: "hola", truncated: false });
	assert.equal(worker.exited, false);
	await h.warm.close();
});

test("a spot-only capture opens the microphone for keywords alone and reports the command it hears", async () => {
	const h = harness();
	const states: VoiceSessionState[] = [];
	const spotting = h.warm.spot({ kws: KWS, onStateChange: (state) => states.push(state) });
	const started = spotting.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	assert.deepEqual(worker.received[0], { ...BASE_REQUEST, kws: KWS, spot: true, keepAlive: true });
	worker.say({ type: "spotting" });
	await started;
	assert.equal(spotting.state, "recording");
	const heard = spotting.heard();
	worker.say({ type: "command", command: "voice-off" });
	assert.equal(await heard, "voice-off");
	assert.deepEqual(states, ["starting", "recording", "finished"]);
	assert.equal(worker.exited, false);
	// The same worker dictates afterwards.
	const after = await record(h, "hola");
	assert.equal(after.worker, worker);
	assert.deepEqual(after.transcript, { text: "hola", truncated: false });
	await h.warm.close();
});

test("a spot-only capture that is stopped hears nothing, and one capture at a time still holds", async () => {
	const h = harness();
	const spotting = h.warm.spot({ kws: KWS });
	const started = spotting.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	worker.say({ type: "spotting" });
	await started;
	await assert.rejects(h.warm.session({ onStateChange: () => {} }).start(), (error: unknown) => error instanceof VoiceSessionError && error.code === "invalid-state");
	const heard = spotting.heard();
	const stopping = spotting.stop();
	await h.until(() => worker.received.some((message) => message.type === "stop"));
	worker.say({ type: "stopped" });
	await stopping;
	assert.equal(await heard, undefined);
	assert.equal(worker.exited, false);
	await h.warm.close();
});

test("a spot-only capture answered like a dictation is a protocol error", async () => {
	const h = harness();
	const spotting = h.warm.spot({ kws: KWS });
	const started = spotting.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	h.workers[0]!.say({ type: "recording" });
	await assert.rejects(started, (error: unknown) => error instanceof VoiceSessionError && error.code === "protocol");
	await h.until(() => h.workers[0]!.exited);
});

test("keyword rejections reach the spot and dictation observers without ending either capture", async () => {
	const h = harness();
	const hits: Array<{ command: string; reason: string }> = [];
	const spot = h.warm.spot({ kws: KWS, onKeywordRejected: (hit) => hits.push(hit) });
	const started = spot.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	assert.equal(worker.received[0]!.keywordDiagnostics, true);
	worker.say({ type: "spotting" });
	await started;
	worker.say({ type: "keyword-rejected", command: "voice-off", reason: "lead" });
	worker.say({ type: "keyword-rejected", command: "voice-off", reason: "speech-after" });
	assert.deepEqual(hits, [{ command: "voice-off", reason: "lead" }, { command: "voice-off", reason: "speech-after" }]);
	assert.equal(spot.state, "recording");
	const stopped = spot.stop();
	worker.say({ type: "stopped" });
	await stopped;
	assert.equal(await spot.heard(), undefined);
	const dictation = h.warm.session({ kws: KWS, onStateChange: () => {}, onKeywordRejected: (hit) => hits.push(hit) });
	const recording = dictation.start();
	await h.until(() => worker.received.filter((message) => message.type === "start").length === 2);
	assert.equal(worker.received.at(-1)!.keywordDiagnostics, true);
	worker.say({ type: "recording" });
	await recording;
	worker.say({ type: "keyword-rejected", command: "voice-off", reason: "lead" });
	assert.equal(dictation.state, "recording");
	const result = dictation.stop();
	worker.say({ type: "transcribing" });
	worker.say({ type: "result", text: "ordinary speech", truncated: false });
	assert.deepEqual(await result, { text: "ordinary speech", truncated: false });
	assert.deepEqual(hits.at(-1), { command: "voice-off", reason: "lead" });
	await h.warm.close();
});

test("a pending keyword rejected during cancellation is still reported before the child exits", async () => {
	const h = harness();
	const hits: Array<{ command: string; reason: string }> = [];
	const spot = h.warm.spot({ kws: KWS, onKeywordRejected: (hit) => hits.push(hit) });
	const started = spot.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	worker.stubborn = true;
	worker.say({ type: "spotting" });
	await started;
	const cancelled = spot.cancel();
	worker.say({ type: "keyword-rejected", command: "voice-off", reason: "ended" });
	worker.exit();
	await cancelled;
	assert.deepEqual(hits, [{ command: "voice-off", reason: "ended" }]);
	assert.deepEqual(worker.signals, [], "a valid final diagnostic is not a protocol error");
});

test("a command crossing cancellation is reported as ignored and never becomes the capture result", async () => {
	const h = harness();
	const hits: Array<{ command: string; reason: string }> = [];
	const spot = h.warm.spot({ kws: KWS, onKeywordRejected: (hit) => hits.push(hit) });
	const started = spot.start();
	await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
	const worker = h.workers[0]!;
	worker.stubborn = true;
	worker.say({ type: "spotting" });
	await started;
	const heard = spot.heard();
	heard.catch(() => {});
	const cancelled = spot.cancel();
	worker.say({ type: "command", command: "voice-off" });
	worker.exit();
	await cancelled;
	await assert.rejects(heard, (error: unknown) => error instanceof VoiceSessionError && error.code === "cancelled");
	assert.deepEqual(hits, [{ command: "voice-off", reason: "cancelled" }]);
	assert.deepEqual(worker.signals, []);
});

test("malformed rejection messages with extra data or invalid fields fail the warm protocol", async () => {
	for (const bad of [
		{ type: "keyword-rejected", command: "voice-off", reason: "lead", text: "private" },
		{ type: "keyword-rejected", command: "Voice Off", reason: "lead" },
		{ type: "keyword-rejected", command: "voice-off", reason: "not-a-reason" },
		{ type: "keyword-rejected", command: "voice-off" },
	]) {
		const h = harness();
		const spot = h.warm.spot({ kws: KWS, onKeywordRejected: () => assert.fail("no malformed hit") });
		const started = spot.start();
		await h.until(() => h.workers.length === 1 && h.workers[0]!.received.length === 1);
		const worker = h.workers[0]!;
		worker.say({ type: "spotting" });
		await started;
		const heard = spot.heard();
		worker.say(bad);
		await assert.rejects(heard, (error: unknown) => error instanceof VoiceSessionError && error.code === "protocol");
		await h.until(() => worker.exited);
	}
});

const workerLine = (message: Record<string, unknown>) => JSON.stringify({ schema: VOICE_WORKER_SCHEMA, ...message });

test("command, spotting and stopped lines carry exactly their fields", async () => {
	assert.deepEqual(parseWorkerLine(workerLine({ type: "command", command: "voice-off" })), { type: "command", command: "voice-off" });
	assert.deepEqual(parseWorkerLine(workerLine({ type: "spotting" })), { type: "spotting" });
	assert.deepEqual(parseWorkerLine(workerLine({ type: "stopped" })), { type: "stopped" });
	const malformed = [
		workerLine({ type: "command" }),
		workerLine({ type: "command", command: "Voice Off" }),
		workerLine({ type: "command", command: 7 }),
		workerLine({ type: "command", command: "voice-off", text: "gentle voice off" }),
		workerLine({ type: "spotting", extra: 1 }),
		workerLine({ type: "stopped", command: "voice-off" }),
	];
	for (const line of malformed) assert.equal(parseWorkerLine(line), undefined, line);
});
