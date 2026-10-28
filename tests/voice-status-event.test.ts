import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createVoiceStatePublisher,
	readVoiceSessionId,
	VOICE_STATE_EVENT,
	VOICE_STATE_SCHEMA,
	voiceDisplayState,
	type VoiceStateEvent,
} from "../lib/voice-status-event.ts";

// The display contract the sidebar tab consumes: the channel, the exact payload
// and the guards that keep a dead session from publishing into a live one.
// Nothing here touches a terminal, a microphone or a config home.

const test = (name: string, fn: () => void) => nodeTest(name, { timeout: 5_000 }, fn);

function fakePi() {
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const pi = { events: { emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); }, on: () => () => {} } } as unknown as Pick<ExtensionAPI, "events">;
	return { pi, emitted };
}

const ctxFor = (sessionId: unknown) => ({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionContext;

test("the contract names one channel and one schema", () => {
	assert.equal(VOICE_STATE_EVENT, "gentle-ai:voice-state");
	assert.equal(VOICE_STATE_SCHEMA, "gentle-pi.voice-state/v1");
});

test("each session state maps to the exact display state the contract allows", () => {
	assert.equal(voiceDisplayState("idle"), "idle");
	assert.equal(voiceDisplayState("starting"), "preparing");
	assert.equal(voiceDisplayState("recording"), "listening");
	assert.equal(voiceDisplayState("transcribing"), "transcribing");
	assert.equal(voiceDisplayState("finished"), "transcribing", "the transcript is still owed");
});

test("publishing emits exactly the schema, the real session id and the state", () => {
	const { pi, emitted } = fakePi();
	const publisher = createVoiceStatePublisher(pi, ctxFor("session-alpha"));
	assert.equal(publisher.sessionId, "session-alpha");
	assert.equal(publisher.publish("listening"), true);
	assert.deepEqual(emitted, [
		{ channel: VOICE_STATE_EVENT, data: { schema: VOICE_STATE_SCHEMA, sessionId: "session-alpha", state: "listening" } satisfies VoiceStateEvent },
	]);
	// Exactly the three contract keys: no transcript, path, error or alias.
	assert.deepEqual(Object.keys(emitted[0]!.data as object).sort(), ["schema", "sessionId", "state"]);
});

test("the session id is read from the supported context API and never invented", () => {
	assert.equal(readVoiceSessionId(ctxFor("session-alpha")), "session-alpha");
	for (const value of ["", undefined, null, 42, {}]) assert.equal(readVoiceSessionId(ctxFor(value)), undefined, JSON.stringify(value));
	assert.equal(readVoiceSessionId(undefined), undefined);
	const throwing = { sessionManager: { getSessionId: () => { throw new Error("gone"); } } } as unknown as ExtensionContext;
	assert.equal(readVoiceSessionId(throwing), undefined);
});

test("a context without a real session id publishes nothing", () => {
	for (const value of ["", undefined, 42]) {
		const { pi, emitted } = fakePi();
		assert.equal(createVoiceStatePublisher(pi, ctxFor(value)).publish("listening"), false, JSON.stringify(value));
		assert.deepEqual(emitted, []);
	}
});

test("a run that no longer owns the display publishes nothing, and close() makes it permanent", () => {
	const { pi, emitted } = fakePi();
	const publisher = createVoiceStatePublisher(pi, ctxFor("session-alpha"));
	assert.equal(publisher.publish("listening", () => false), false, "a stale run");
	let live = true;
	assert.equal(publisher.publish("listening", () => live), true);
	assert.equal(publisher.publish("transcribing", () => live), true);
	live = false;
	assert.equal(publisher.publish("idle", () => live), false, "a late terminal state");
	assert.deepEqual(emitted.map((event) => (event.data as VoiceStateEvent).state), ["listening", "transcribing"]);
	live = true;
	publisher.close();
	assert.equal(publisher.publish("idle"), false, "a closed publisher never publishes again");
	assert.equal(publisher.publish("idle", () => true), false);
	assert.deepEqual(emitted.map((event) => (event.data as VoiceStateEvent).state), ["listening", "transcribing"]);
});

test("a guard that throws or an emit that throws never escapes the publisher", () => {
	const { pi } = fakePi();
	const publisher = createVoiceStatePublisher(pi, ctxFor("session-alpha"));
	assert.equal(publisher.publish("listening", () => { throw new Error("gone"); }), false);
	const broken = { events: { emit: () => { throw new Error("no bus"); }, on: () => () => {} } } as unknown as Pick<ExtensionAPI, "events">;
	const other = createVoiceStatePublisher(broken, ctxFor("session-alpha"));
	assert.doesNotThrow(() => other.publish("listening"));
	assert.equal(other.publish("listening"), false);
	// A state that never went out is not remembered as published.
	assert.equal(publisher.publish("listening"), true);
});

test("a repeated state is published once per session, so the run ends with one idle", () => {
	const { pi, emitted } = fakePi();
	const publisher = createVoiceStatePublisher(pi, ctxFor("session-alpha"));
	for (const state of ["preparing", "preparing", "listening", "transcribing", "transcribing", "idle", "idle"] as const) publisher.publish(state);
	assert.deepEqual(emitted.map((event) => (event.data as VoiceStateEvent).state), ["preparing", "listening", "transcribing", "idle"]);
	// A new session has its own publisher, so its first state is not deduplicated.
	const next = createVoiceStatePublisher(pi, ctxFor("session-beta"));
	next.publish("idle");
	assert.deepEqual(emitted.map((event) => (event.data as VoiceStateEvent).sessionId), ["session-alpha", "session-alpha", "session-alpha", "session-alpha", "session-beta"]);
});

test("creating a publisher or importing the module emits nothing by itself", () => {
	const { pi, emitted } = fakePi();
	createVoiceStatePublisher(pi, ctxFor("session-alpha"));
	assert.deepEqual(emitted, []);
});
