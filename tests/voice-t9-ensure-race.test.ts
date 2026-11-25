import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VoiceSessionState } from "../lib/voice-session.ts";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionListenerLink, type SessionDictation } from "../lib/voice-listener-client.ts";
import { VoiceListener } from "../lib/voice-listener.ts";

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => { release = resolve; });
	return { promise, release };
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

test("manual ensure after bye but before fallback starts must not discard automatic recovery", async () => {
	const dir = mkdtempSync(join(tmpdir(), "t9-ensure-"));
	const asked = gate();
	const deliverStart = gate();
	const displayed = gate();
	const oldGone = gate();
	const current = { sessionId: "same", paneId: "w1:p1", voiceOn: true };
	const old = new VoiceListener({ dir, focus: { focusedPaneId: async () => ({ focused: current.paneId }) },
		dictation: () => ({ start: () => { asked.release(); return deliverStart.promise; }, stop: async () => ({ text: "unused", truncated: false }), cancel: async () => {} }) });
	const replacement = new VoiceListener({ dir });
	const local = fakeLocal();
	let closing = false;
	let joining: Promise<boolean> | undefined;
	const starts: string[] = [];
	const link = createSessionListenerLink({ dir, session: () => current, backoffMs: [20],
		start: async () => { starts.push(local.state); await replacement.listen(); },
		probe: async () => { if (!closing) return true; await oldGone.promise; return starts.length > 0; }, waitMs: 250,
		onDisplay: (frame) => {
			if (frame.type !== "display") return;
			displayed.release();
			if (closing && frame.state === "off" && !joining) joining = link.ensure();
		} });
	try {
		await old.listen();
		assert.equal(await link.ensure(), true);
		await displayed.promise;
		const capture = link.dictate({ mode: "dictation", fallback: () => local, onStateChange: () => {} });
		const starting = capture.start();
		await asked.promise;
		closing = true;
		await old.close();
		await starting;
		assert.ok(joining, "manual ensure ran after bye retired the socket");
		oldGone.release();
		await joining;
		assert.deepEqual(starts, [], "manual ensure must not start over the fallback");
		await capture.stop();
		const deadline = Date.now() + 2_000;
		while (!replacement.sessionIds.includes(current.sessionId)) {
			assert.ok(Date.now() < deadline, "the joined client never restarted its listener");
			await delay(5);
		}
		assert.deepEqual(starts, ["finished"]);
	} finally {
		link.close();
		deliverStart.release();
		oldGone.release();
		await old.close();
		if (starts.length) await replacement.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
