import assert from "node:assert/strict";
import test from "node:test";
import {
	encodeListenerFrame,
	LISTENER_MAX_LINE,
	parseListenerFrameLine,
	parseListenerRequestLine,
	VOICE_LISTENER_SCHEMA,
} from "../lib/voice-listener-protocol.ts";

// The wire protocol between Pi sessions and the one voice listener (S6,
// odd/notes/voice-listener-design.md §2): one JSON object per line, bounded,
// and strict about unknown fields. Nothing here starts a process or a socket.

const line = (frame: Record<string, unknown>) => JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, ...frame });

test("a hello is accepted with and without its optional fields", () => {
	assert.deepEqual(parseListenerRequestLine(line({ type: "hello", proto: 1, sessionId: "s-1", voiceOn: false })), {
		type: "hello",
		proto: 1,
		sessionId: "s-1",
		voiceOn: false,
	});
	assert.deepEqual(parseListenerRequestLine(line({ type: "hello", id: "r1", proto: 1, sessionId: "s-1", paneId: "w1C4:p1", voiceOn: true, label: "repo" })), {
		type: "hello",
		id: "r1",
		proto: 1,
		sessionId: "s-1",
		paneId: "w1C4:p1",
		voiceOn: true,
		label: "repo",
	});
	assert.deepEqual(parseListenerRequestLine(line({ type: "status" })), { type: "status" });
	assert.deepEqual(parseListenerRequestLine(line({ type: "set-voice", voiceOn: true })), { type: "set-voice", voiceOn: true });
});

test("an unknown field, a wrong type, a missing field or a foreign schema is refused", () => {
	const hello = { type: "hello", proto: 1, sessionId: "s-1", voiceOn: true };
	assert.deepEqual(parseListenerRequestLine(line(hello)), hello);
	for (const bad of [
		{ ...hello, extra: 1 },
		{ ...hello, voiceOn: "yes" },
		{ ...hello, proto: 2 },
		{ type: "hello", proto: 1, sessionId: "s-1" },
		{ ...hello, paneId: 7 },
		{ type: "shout" },
		{ type: "wake", voiceOn: true },
		{ type: "hello", proto: 1, sessionId: "s-1", voiceOn: true, label: "x".repeat(300) },
	]) {
		assert.equal(parseListenerRequestLine(line(bad)), undefined, JSON.stringify(bad));
	}
	assert.equal(parseListenerRequestLine(JSON.stringify({ ...hello, schema: "other/v1" })), undefined);
	assert.equal(parseListenerRequestLine("not json"), undefined);
	assert.equal(parseListenerRequestLine(JSON.stringify([hello])), undefined);
	assert.equal(parseListenerRequestLine(""), undefined);
});

test("a session id is a bounded identifier", () => {
	for (const ok of ["a", "01a1cd43-abc_def", "A".repeat(128)]) {
		assert.ok(parseListenerRequestLine(line({ type: "hello", proto: 1, sessionId: ok, voiceOn: true })), ok);
	}
	for (const bad of ["", "-leading", "../etc/passwd", "a".repeat(129), "with space"]) {
		assert.equal(parseListenerRequestLine(line({ type: "hello", proto: 1, sessionId: bad, voiceOn: true })), undefined, bad);
	}
});

test("an inherited property name is neither a type nor a field", () => {
	for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty"]) assert.equal(parseListenerRequestLine(line({ type })), undefined, type);
	const hello = { type: "hello", proto: 1, sessionId: "s-1", voiceOn: true };
	for (const key of ["toString", "constructor", "valueOf"]) assert.equal(parseListenerRequestLine(line({ ...hello, [key]: "x" })), undefined, key);
});

test("a line over the protocol bound is refused without being parsed", () => {
	assert.equal(parseListenerRequestLine(`{"pad":"${"x".repeat(LISTENER_MAX_LINE)}"}`), undefined);
});

test("every listener frame parses and re-encodes as exactly one line", () => {
	const frames = [
		{ type: "welcome", listenerPid: 99, proto: 1, state: "asleep" },
		{ type: "ok", request: "wake", id: "3", state: "listening" },
		{ type: "snapshot", state: "asleep", listenerPid: 99, clients: 2, sessions: ["s-1", "s-2"] },
		{ type: "state", state: "listening", at: 1700 },
		{ type: "command", command: "voice-off" },
		{ type: "transcript", text: "hola" },
		{ type: "error", code: "bad-frame", id: "4" },
		{ type: "bye", reason: "idle" },
	];
	for (const frame of frames) {
		assert.deepEqual(parseListenerFrameLine(line(frame)), frame, JSON.stringify(frame));
	}
	const encoded = encodeListenerFrame({ type: "state", state: "reading", at: 1 });
	assert.equal(encoded.endsWith("\n"), true);
	assert.equal(encoded.split("\n").length, 2, "one frame is one line");
	assert.deepEqual(parseListenerFrameLine(encoded.trimEnd()), { type: "state", state: "reading", at: 1 });
});

test("unknown states, commands, reasons and oversized transcript text are refused", () => {
	assert.equal(parseListenerFrameLine(line({ type: "state", state: "off", at: 1 })), undefined, "off is the absence of a listener, not a state");
	assert.equal(parseListenerFrameLine(line({ type: "command", command: "reboot" })), undefined);
	assert.equal(parseListenerFrameLine(line({ type: "bye", reason: "bye" })), undefined);
	assert.equal(parseListenerFrameLine(line({ type: "error", code: "oops" })), undefined);
	assert.equal(parseListenerFrameLine(line({ type: "transcript", text: "x".repeat(16 * 1024 + 1) })), undefined);
	assert.equal(parseListenerFrameLine(line({ type: "snapshot", state: "asleep", listenerPid: 1, clients: 1, sessions: ["../x"] })), undefined);
	assert.equal(parseListenerFrameLine(line({ type: "welcome", listenerPid: 0, proto: 1, state: "asleep" })), undefined);
});

test("the reading turn parses as requests and as answers", () => {
	const requests = [
		{ type: "read-begin", id: "r1", readingId: "read-1", chars: 1_200 },
		{ type: "read-heartbeat", readingId: "read-1" },
		{ type: "read-end", readingId: "read-1", outcome: "skipped" },
		{ type: "read-cut" },
		{ type: "read-cut", readingId: "read-1" },
	];
	for (const request of requests) assert.deepEqual(parseListenerRequestLine(line(request)), request, JSON.stringify(request));
	const frames = [
		{ type: "granted", id: "r1", readingId: "read-1", state: "reading" },
		{ type: "busy", id: "r2", reason: "reading", holder: "s-1" },
		{ type: "busy", reason: "asleep" },
		{ type: "reading", change: "granted", readingId: "read-1", session: "s-1" },
		{ type: "reading", change: "released", readingId: "read-1", session: "s-1", reason: "lease" },
	];
	for (const frame of frames) assert.deepEqual(parseListenerFrameLine(line(frame)), frame, JSON.stringify(frame));
});

test("a dictation asks, stops and cancels with its mode and its endpoint", () => {
	const requests = [
		{ type: "dictate", mode: "conversation" },
		{ type: "dictate", id: "d1", mode: "dictation", endpoint: { endOfSpeechMs: 2_500, noSpeechMs: 8_000 } },
		{ type: "stop" },
		{ type: "stop", id: "d2" },
		{ type: "cancel" },
	];
	for (const request of requests) assert.deepEqual(parseListenerRequestLine(line(request)), request, JSON.stringify(request));
	for (const bad of [
		{ type: "dictate" },
		{ type: "dictate", mode: "shouting" },
		{ type: "dictate", mode: "dictation", endpoint: { endOfSpeechMs: 2_500 } },
		{ type: "dictate", mode: "dictation", endpoint: { endOfSpeechMs: 2_500, noSpeechMs: 8_000, pad: 1 } },
		{ type: "dictate", mode: "dictation", endpoint: { endOfSpeechMs: 0, noSpeechMs: 8_000 } },
		{ type: "dictate", mode: "dictation", endpoint: "2500" },
	]) {
		assert.equal(parseListenerRequestLine(line(bad)), undefined, JSON.stringify(bad));
	}
});

test("a capture reports every phase, its code and who got the transcript", () => {
	const frames = [
		{ type: "capture", phase: "recording" },
		{ type: "capture", phase: "transcribing" },
		{ type: "capture", phase: "delivered" },
		{ type: "capture", phase: "elsewhere", target: "s-2" },
		{ type: "capture", phase: "dropped" },
		{ type: "capture", phase: "cancelled" },
		{ type: "capture", phase: "failed", code: "no-speech" },
		{ type: "transcript", text: "hola", truncated: true },
	];
	for (const frame of frames) assert.deepEqual(parseListenerFrameLine(line(frame)), frame, JSON.stringify(frame));
	for (const bad of [
		{ type: "capture" },
		{ type: "capture", phase: "paused" },
		{ type: "capture", phase: "failed" },
		{ type: "capture", phase: "failed", code: "oops" },
		{ type: "capture", phase: "elsewhere", target: "../x" },
		{ type: "transcript", text: "hola", truncated: "yes" },
	]) {
		assert.equal(parseListenerFrameLine(line(bad)), undefined, JSON.stringify(bad));
	}
});

test("a reading request or answer outside the fixed lists is refused", () => {
	for (const bad of [
		{ type: "read-begin", readingId: "read-1" },
		{ type: "read-begin", readingId: "read-1", chars: -1 },
		{ type: "read-begin", readingId: 7, chars: 10 },
		{ type: "read-heartbeat" },
		{ type: "read-end", readingId: "read-1", outcome: "partial" },
		{ type: "read-end", readingId: "read-1" },
		{ type: "read-cut", readingId: 7 },
	]) {
		assert.equal(parseListenerRequestLine(line(bad)), undefined, JSON.stringify(bad));
	}
	for (const bad of [
		{ type: "busy", reason: "tired" },
		{ type: "reading", change: "held" },
		{ type: "reading", change: "released", reason: "stop" },
		{ type: "granted", readingId: "read-1", state: "off" },
		{ type: "granted", state: "reading" },
	]) {
		assert.equal(parseListenerFrameLine(line(bad)), undefined, JSON.stringify(bad));
	}
});

// --- levels and the owning session (T4, S5) ------------------------------------------

test("levels subscribe and unsubscribe, and nothing else is accepted", () => {
	assert.deepEqual(parseListenerRequestLine(line({ type: "levels", on: true })), { type: "levels", on: true });
	assert.deepEqual(parseListenerRequestLine(line({ type: "levels", id: "l1", on: false })), { type: "levels", id: "l1", on: false });
	for (const bad of [{ type: "levels" }, { type: "levels", on: "yes" }, { type: "levels", on: true, rms: 0.2 }, { type: "levels", on: 1 }]) {
		assert.equal(parseListenerRequestLine(line(bad)), undefined, JSON.stringify(bad));
	}
});

test("a level frame carries one bounded microphone RMS and its time", () => {
	assert.deepEqual(parseListenerFrameLine(line({ type: "level", rms: 0.31, at: 1700 })), { type: "level", rms: 0.31, at: 1700 });
	assert.deepEqual(parseListenerFrameLine(line({ type: "level", rms: 0, at: 0 })), { type: "level", rms: 0, at: 0 });
	assert.deepEqual(parseListenerFrameLine(line({ type: "level", rms: 1, at: 1700 })), { type: "level", rms: 1, at: 1700 });
	for (const bad of [
		{ type: "level", rms: -0.1, at: 1 },
		{ type: "level", rms: 1.1, at: 1 },
		{ type: "level", rms: 1e9, at: 1 },
		{ type: "level", rms: "0.1", at: 1 },
		{ type: "level", rms: 0.1 },
		{ type: "level", rms: 0.1, at: -1 },
		{ type: "level", at: 1 },
		{ type: "level", rms: 0.1, at: 1, extra: 1 },
	]) {
		assert.equal(parseListenerFrameLine(line(bad)), undefined, JSON.stringify(bad));
	}
});

test("a state frame names the language and the session that owns the microphone", () => {
	assert.deepEqual(parseListenerFrameLine(line({ type: "state", state: "listening", language: "es", paneId: "w1:p1", label: "repo", at: 5 })), {
		type: "state",
		state: "listening",
		language: "es",
		paneId: "w1:p1",
		label: "repo",
		at: 5,
	});
	// A frame written before the overlay existed keeps parsing.
	assert.deepEqual(parseListenerFrameLine(line({ type: "state", state: "asleep", at: 5 })), { type: "state", state: "asleep", at: 5 });
	for (const bad of [
		{ type: "state", state: "listening", language: "fr", at: 5 },
		{ type: "state", state: "listening", label: "x".repeat(300), at: 5 },
		{ type: "state", state: "listening", paneId: 7, at: 5 },
	]) {
		assert.equal(parseListenerFrameLine(line(bad)), undefined, JSON.stringify(bad));
	}
});
