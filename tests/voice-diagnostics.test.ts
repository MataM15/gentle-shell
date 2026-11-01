import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createVoiceLog, VOICE_LOG_FILE } from "../lib/voice-diagnostics.ts";

// The voice event log: one JSON line per event, kept small, never throwing.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-log-"));
	dirs.push(dir);
	return dir;
};
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("each event is one JSON line with time, pid, session and fields, and text is never logged", () => {
	const dir = scratch();
	const log = createVoiceLog({ dir, pid: 42, now: () => new Date("2026-11-01T12:00:00Z") });
	log("mic.reopen", { session: "s1", reason: "not-focused", text: "secret reply" });
	const [line] = readFileSync(join(dir, VOICE_LOG_FILE), "utf8").trim().split("\n");
	assert.deepEqual(JSON.parse(line!), { at: "2026-11-01T12:00:00.000Z", pid: 42, event: "mic.reopen", session: "s1", reason: "not-focused" });
});

test("a log past its size limit moves to .1 and starts again", () => {
	const dir = scratch();
	writeFileSync(join(dir, VOICE_LOG_FILE), "x".repeat(300));
	const log = createVoiceLog({ dir, maxBytes: 200 });
	log("reading.start");
	assert.equal(readFileSync(join(dir, `${VOICE_LOG_FILE}.1`), "utf8"), "x".repeat(300));
	assert.equal(readFileSync(join(dir, VOICE_LOG_FILE), "utf8").trim().split("\n").length, 1);
});

test("an unwritable directory never throws", () => {
	const dir = join(scratch(), "missing", "deeper");
	const log = createVoiceLog({ dir: join(dir, "\0bad") });
	log("reading.start");
	assert.equal(existsSync(dir), false);
});
