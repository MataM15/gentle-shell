import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { createSessionListenerLink, VoiceListenerClient } from "../lib/voice-listener-client.ts";
import { readListenerLock, VoiceListener } from "../lib/voice-listener.ts";

for (const action of ["start", "join peer", "close", "voice off"] as const) test(`S3/T14a: deferred first join meets a shutdown fence (${action})`, { timeout: 5_000 }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "fence-"));
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	const closed = once(child, "close").then(() => {});
	const old = new VoiceListener({ dir, worker: {
		needsRecycle: () => false, recycle: async () => false,
		close: async () => { throw new Error("worker shutdown deadline"); },
		unclosedChild: () => ({ pid: child.pid, closed }),
	} });
	const next = new VoiceListener({ dir });
	const fenceAtBye: Array<number | undefined> = [];
	const prior = new VoiceListenerClient({ dir, session: { sessionId: "prior", voiceOn: true }, onFrame: (frame) => {
		if (frame.type === "bye") fenceAtBye.push(readListenerLock(old.paths)?.workerPid);
	} });
	const peer = new VoiceListenerClient({ dir, session: { sessionId: "peer", voiceOn: true } });
	const starts: boolean[] = [];
	let probes = 0;
	const link = createSessionListenerLink({ dir, session: () => ({ sessionId: "new-voice-on", voiceOn: true }), backoffMs: [20, 40],
		probe: async (path) => { probes++; return existsSync(path); },
		start: async () => { starts.push(child.exitCode !== null); await next.listen(); } });
	try {
		await once(child, "spawn");
		await old.listen();
		await prior.connect();
		await old.close();
		const deadlineBye = Date.now() + 500;
		while (!fenceAtBye.length && Date.now() < deadlineBye) await delay(5);
		prior.close();
		assert.deepEqual(fenceAtBye, [child.pid]);
		const before = readFileSync(old.paths.lock, "utf8");
		t.mock.timers.enable({ apis: ["setTimeout"] });
		assert.equal(await link.ensure(), false);
		assert.equal(probes, 1);
		t.mock.timers.tick(20);
		await nextTurn();
		assert.equal(probes, 2, "the first retry checked the still-live fence");
		assert.deepEqual(starts, []);
		assert.deepEqual(next.sessionIds, []);
		assert.equal(readFileSync(old.paths.lock, "utf8"), before, "refused joins must preserve the fence byte-for-byte");

		if (action === "close") link.close();
		if (action === "voice off") link.updateVoice?.(false);
		child.stdin.end();
		await closed;
		if (action === "join peer") {
			await next.listen();
			await peer.connect();
		}
		t.mock.timers.tick(39);
		assert.equal(probes, 2, "the retry uses the reconnect backoff");
		t.mock.timers.tick(1);
		if (action === "start" || action === "join peer") {
			const deadline = Date.now() + 1_000;
			while (!next.sessionIds.includes("new-voice-on") && Date.now() < deadline) await delay(5);
		} else await nextTurn();
		t.mock.timers.tick(40);
		await nextTurn();
		assert.equal(probes, action === "start" ? 4 : action === "join peer" ? 3 : 2);
		assert.deepEqual(starts, action === "start" ? [true] : []);
		assert.deepEqual(next.sessionIds, action === "start" ? ["new-voice-on"] : action === "join peer" ? ["peer", "new-voice-on"] : []);
	} finally {
		t.mock.timers.reset();
		link.close();
		prior.close();
		peer.close();
		child.stdin.end();
		await closed;
		await old.close();
		if (starts.length || action === "join peer") await next.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
