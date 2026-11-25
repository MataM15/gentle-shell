import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createSessionListenerLink, VoiceListenerClient } from "../lib/voice-listener-client.ts";
import type { ListenerFrame } from "../lib/voice-listener-protocol.ts";
import { VoiceListener } from "../lib/voice-listener.ts";

for (const focus of ["other", undefined]) test(`S2: requester rejoins during transcription (focus ${focus ?? "none"})`, { timeout: 3_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "requester-"));
	const stopping = Promise.withResolvers<void>();
	const transcription = Promise.withResolvers<{ text: string; truncated: boolean }>();
	const delivered: string[] = [];
	let focusCalls = 0;
	const server = new VoiceListener({ dir,
		focus: { focusedPaneId: async () => { ++focusCalls; return { focused: focus }; } },
		dictation: () => ({ start: async () => {}, stop: () => { stopping.resolve(); return transcription.promise; }, cancel: async () => {} }),
	});
	const client = (label: string, sessionId: string, paneId: string) => new VoiceListenerClient({ dir, session: { sessionId, paneId, voiceOn: true },
		onFrame: (f: ListenerFrame) => { if (f.type === "transcript") delivered.push(`${label}:${f.text}`); } });
	const original = client("original", "same-session", "owner");
	const replacement = client("replacement", "same-session", "owner");
	const other = client("other", "other-session", "other");
	try {
		await server.listen();
		await original.connect();
		await other.connect();
		assert.equal((await original.request({ type: "dictate", mode: "dictation" })).type, "ok");
		const stop = original.request({ type: "stop" }).catch(() => {});
		await stopping.promise;
		await replacement.connect();
		transcription.resolve({ text: "mi dictado", truncated: false });
		await stop;
		const deadline = Date.now() + 250;
		while (!delivered.length && Date.now() < deadline) await delay(5);
		assert.deepEqual({ delivered, focusCalls }, { delivered: ["replacement:mi dictado"], focusCalls: 0 });
	} finally {
		transcription.resolve({ text: "", truncated: false });
		for (const peer of [original, replacement, other]) peer.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("S2/T6: a requester returning during focus lookup inserts the old transcript without settling its new capture", { timeout: 3_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "requester-"));
	const stopping = Promise.withResolvers<void>();
	const transcription = Promise.withResolvers<{ text: string; truncated: boolean }>();
	const disconnected = Promise.withResolvers<void>();
	const looking = Promise.withResolvers<void>();
	const focus = Promise.withResolvers<{ focused: string }>();
	const received: string[] = [];
	const otherReceived: string[] = [];
	const session = { sessionId: "same-session", paneId: "owner", voiceOn: true };
	const server = new VoiceListener({
		dir,
		focus: { focusedPaneId: () => { looking.resolve(); return focus.promise; } },
		log: (event, fields) => { if (event === "listener.client-closed" && fields?.sessionId === session.sessionId) disconnected.resolve(); },
		dictation: ({ mode }) => ({
			start: async () => {},
			stop: () => {
				if (mode === "conversation") return Promise.resolve({ text: "new transcript", truncated: false });
				stopping.resolve();
				return transcription.promise;
			},
			cancel: async () => {},
		}),
	});
	const original = new VoiceListenerClient({ dir, session });
	const replacement = createSessionListenerLink({ dir, session: () => session, onTranscript: (text) => received.push(text) });
	const other = new VoiceListenerClient({
		dir,
		session: { sessionId: "other-session", paneId: "other", voiceOn: true },
		onFrame: (frame) => { if (frame.type === "transcript") otherReceived.push(frame.text); },
	});
	try {
		await server.listen();
		await original.connect();
		await other.connect();
		assert.equal((await original.request({ type: "dictate", mode: "dictation" })).type, "ok");
		const stop = original.request({ type: "stop" }).catch(() => {});
		await stopping.promise;
		original.close();
		await stop;
		await disconnected.promise;
		transcription.resolve({ text: "old transcript", truncated: false });
		await looking.promise;
		assert.equal(await replacement.ensure(), true);
		focus.resolve({ focused: "other" });
		// Install the next capture's handler before the pending delivery resumes.
		const next = replacement.dictate({ mode: "conversation", onStateChange: () => {}, fallback: () => assert.fail("listener capture expected") });
		await next.start();
		assert.deepEqual({ result: await next.stop(), received, otherReceived }, {
			result: { text: "new transcript", truncated: false },
			received: ["old transcript"],
			otherReceived: [],
		});
	} finally {
		transcription.resolve({ text: "", truncated: false });
		focus.resolve({ focused: "other" });
		original.close();
		replacement.close();
		other.close();
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
