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
