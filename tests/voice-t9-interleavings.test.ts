import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionCaptureGuard, createSessionListenerLink, listenerReadingTurn, VoiceListenerClient, type SessionDictation } from "../lib/voice-listener-client.ts";
import { listenerPaths, readListenerLock, VoiceListener } from "../lib/voice-listener.ts";
import { createWarmVoiceWorker } from "../lib/voice-warm.ts";
import { VOICE_WORKER_SCHEMA, type VoiceSessionState, type VoiceWorkerChild } from "../lib/voice-session.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
}

async function until(predicate: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "condition not reached");
		await delay(5);
	}
}

function fakeLocal(): SessionDictation {
	let state: VoiceSessionState = "idle";
	return {
		get state() { return state; }, owner: "session",
		async start() { state = "recording"; },
		async stop() { state = "finished"; return { text: "local", truncated: false }; },
		async cancel() { state = "finished"; },
	};
}

// T9 S3/S4: exercise real link/socket handoff with controlled capture teardown.
for (const route of ["adopted", "reading", "warm-cancel", "shutdown-order", "idle-start-error", "closed-link"] as const) {
	test(`T9 ${route}: listener restart observes microphone ownership`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "t9-"));
		const session = { sessionId: "same", paneId: "w1:p1", voiceOn: true };
		const asked = gate();
		const oldReleased = gate();
		const newReleased = gate();
		let oldWorkerOpen = route === "shutdown-order";
		let fallbackStartedWithOldWorker = false;
		const server = new VoiceListener({
			dir,
			focus: { focusedPaneId: async () => ({ focused: session.paneId }) },
			...(oldWorkerOpen ? { worker: { needsRecycle: () => false, recycle: async () => false, close: async () => { await oldReleased.promise; oldWorkerOpen = false; } } } : {}),
			dictation: () => ({
				start: () => { asked.release(); return newReleased.promise; },
				stop: async () => ({ text: "unused", truncated: false }),
				cancel: async () => {},
			}),
		});
		const replacement = new VoiceListener({ dir });
		let starts = 0;
		const start = async () => { starts++; await replacement.listen(); };
		// Exactly the passive client configuration adopted by voice-on, with a
		// shorter retry delay. The long delay for reading isolates its own start.
		const adoptedClient = route === "adopted" ? new VoiceListenerClient({
			dir, session: () => session, backoffMs: [20], restartOnDisconnect: { start },
		}) : undefined;
		const captureGuard = createSessionCaptureGuard();
		const link = createSessionListenerLink({ dir, session: () => session, adoptedClient, captureGuard, start,
			backoffMs: [route === "reading" || route === "shutdown-order" ? 400 : 20] });
		const child = Object.assign(new EventEmitter(), {
			stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
		});
		child.stdin.on("data", (chunk) => {
			if (JSON.parse(String(chunk)).type === "start") queueMicrotask(() => {
				child.stdout.write(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: "recording" })}\n`);
			});
		});
		const warm = createWarmVoiceWorker({ target: "linux-x64", spawn: () => child as unknown as VoiceWorkerChild,
			prepare: async () => ({ root: dir, request: { type: "start" } }) });
		const warmCapture = warm.session({ onStateChange: () => {} });
		const local = fakeLocal();
		const failed = new Error("local preflight failed");
		const fallback: SessionDictation = route === "warm-cancel" ? {
			get state() { return warmCapture.state; },
			get microphoneActive() { return warmCapture.microphoneActive; },
			owner: "session", start: () => warmCapture.start(),
			stop: () => warmCapture.stop(), cancel: () => warmCapture.cancel(),
		} : {
			get state() { return local.state; }, owner: "session", stop: () => local.stop(), cancel: () => local.cancel(),
			start: () => {
				if (route === "idle-start-error") throw failed;
				fallbackStartedWithOldWorker = oldWorkerOpen;
				return local.start();
			},
		};
		let closing: Promise<void> | undefined;
		let cancelling: Promise<void> | undefined;
		const readAbort = new AbortController();
		try {
			await server.listen();
			await adoptedClient?.connect();
			assert.equal(await link.ensure(), true);
			const dictation = link.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => fallback });
			const starting = dictation.start();
			void starting.catch(() => {});
			await asked.promise;
			closing = server.close();
			if (route === "shutdown-order") {
				// Worker close is still gated and there is no PID fence yet.
				await delay(100);
				assert.equal(oldWorkerOpen, true);
				assert.equal(readListenerLock(listenerPaths(dir))?.workerPid, undefined);
				assert.equal(fallbackStartedWithOldWorker, false, "local fallback opened before the old worker released the mic");
				assert.equal(local.state, "idle");
				const late = createSessionListenerLink({ dir, session: () => ({ ...session, sessionId: "late" }), start });
				try {
					const capture = late.dictate({ mode: "dictation", onStateChange: () => {}, fallback: () => assert.fail("shutdown must not open a new local mic") });
					await assert.rejects(capture.start(), { code: "invalid-state", message: "The microphone is busy. Try again in a moment." });
				} finally {
					late.close();
				}
				oldReleased.release();
			}
			await closing;
			if (route === "idle-start-error") {
				await assert.rejects(starting, (error) => error === failed);
				await until(() => replacement.sessionIds.includes(session.sessionId));
				assert.equal(starts, 1);
				return;
			}
			await starting;
			assert.equal(dictation.owner, "session");
			assert.equal(dictation.state, "recording");
			if (route === "reading") {
				const read = () => listenerReadingTurn({ dir, session, start, beforeStart: captureGuard.assertReleased, waitMs: 100, signal: readAbort.signal });
				assert.deepEqual(await read(), { kind: "unavailable" });
				const running = new VoiceListener({ dir });
				await running.listen();
				try {
					const turn = await read();
					assert.equal(turn?.kind, "granted", "an existing listener can still grant a reading");
					turn.release();
				} finally {
					await running.close();
				}
			} else if (route === "warm-cancel") {
				cancelling = dictation.cancel();
				void cancelling.catch(() => {});
				assert.equal(dictation.state, "finished", "the warm capture still reports cancellation promptly");
				await assert.rejects(cancelling, { code: "worker-exited" });
			} else if (route === "closed-link") {
				link.close();
			}
			await delay(100);
			assert.equal(starts, 0, "listener started while fallback worker still owned the mic");
			if (route === "warm-cancel") {
				// The bounded cancellation wait expired, but the child only exits here.
				child.emit("close");
			} else await dictation.stop();
			if (route === "closed-link") {
				await delay(60);
				assert.equal(starts, 0, "closed link must not reconnect after fallback exits");
			} else {
				await until(() => replacement.sessionIds.includes(session.sessionId));
				assert.equal(starts, 1);
			}
		} finally {
			readAbort.abort();
			link.close();
			adoptedClient?.close();
			newReleased.release();
			oldReleased.release();
			child.emit("close");
			await cancelling?.catch(() => {});
			await closing;
			await server.close();
			if (starts) await replacement.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
