import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { createSessionCaptureGuard, createSessionListenerLink } from "../lib/voice-listener-client.ts";
import { probeListenerSocket, VoiceListener } from "../lib/voice-listener.ts";

async function retiringCapture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "voice-switch-"));
	const captureGuard = createSessionCaptureGuard();
	let state: "idle" | "recording" | "finished" = "idle";
	let open = false;
	let oldStarts = 0;
	let oldProbes = 0;
	let probes = 0;
	const starts: boolean[] = [];
	const server = new VoiceListener({ dir });
	const before = createSessionListenerLink({
		dir, captureGuard, backoffMs: [20, 40],
		session: () => ({ sessionId: "before-switch", voiceOn: true }),
		probe: (path) => { oldProbes++; return probeListenerSocket(path); },
		start: () => { oldStarts++; throw new Error("offline"); },
	});
	const after = createSessionListenerLink({
		dir, captureGuard, backoffMs: [20, 40],
		session: () => ({ sessionId: "after-switch", voiceOn: true }),
		probe: (path) => { probes++; return probeListenerSocket(path); },
		start: async () => { starts.push(open); await server.listen(); },
	});
	t.after(async () => {
		before.close();
		after.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const capture = before.dictate({
		mode: "dictation", onStateChange: () => {}, fallback: () => ({
			get state() { return state; }, get microphoneActive() { return open; }, owner: "session",
			async start() { state = "recording"; open = true; },
			async cancel() { state = "finished"; },
			async stop() { state = "finished"; return { text: "", truncated: false }; },
		}),
	});
	await capture.start();
	return {
		before, after, capture, server, starts, probes: () => probes,
		oldStarts: () => oldStarts, oldProbes: () => oldProbes, exit: () => { open = false; },
	};
}

// S3: a newly loaded voice-on session must not give up when the previous
// session's local capture finished cancelling but its worker is still alive.
test("voice-on session switch defers its first listener join until prior capture exits", async (t) => {
	const { before, after, capture, exit, server, starts, probes } = await retiringCapture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	before.close();
	await capture.cancel();
	assert.equal(capture.state, "finished");
	assert.equal(await after.ensure(), false);
	assert.equal(await after.ensure(), false, "repeated joins coalesce into one deferred retry");
	t.mock.timers.tick(20);
	assert.deepEqual(starts, []);
	assert.equal(probes(), 0, "no join attempt while the prior worker is alive");
	exit();
	t.mock.timers.tick(39);
	assert.equal(probes(), 0, "the retry uses the reconnect backoff");
	t.mock.timers.tick(1);
	const deadline = Date.now() + 1_000;
	while (!server.sessionIds.includes("after-switch") && Date.now() < deadline) await delay(5);
	assert.deepEqual(server.sessionIds, ["after-switch"], "the new session joins after the prior worker exits");
	t.mock.timers.tick(40);
	assert.deepEqual(starts, [false], "exactly one listener started, after the worker exited");
});

for (const cancel of ["close", "voice off"] as const) test(`a deferred first listener join is cancelled on ${cancel}`, async (t) => {
	const { before, after, capture, exit, server, starts, probes } = await retiringCapture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	before.close();
	await capture.cancel();
	assert.equal(await after.ensure(), false);
	t.mock.timers.tick(20);
	if (cancel === "close") after.close();
	else after.updateVoice?.(false);
	exit();
	t.mock.timers.tick(40);
	assert.equal(probes(), 0);
	assert.deepEqual(starts, []);
	assert.deepEqual(server.sessionIds, []);
});

test("an offline session's own local capture does not schedule a first listener join", async (t) => {
	const { before, capture, exit, oldStarts, oldProbes } = await retiringCapture(t);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	assert.equal(oldStarts(), 1, "initial listener failure took the existing local fallback");
	assert.equal(await before.ensure(), false);
	await capture.cancel();
	exit();
	t.mock.timers.tick(20);
	assert.equal(oldProbes(), 1, "no deferred listener startup for the same session");
});
