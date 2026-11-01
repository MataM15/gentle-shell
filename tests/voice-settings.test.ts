import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import {
	readVoicePushToTalk,
	readVoiceSessions,
	VOICE_SESSIONS_FILE,
	VOICE_SESSIONS_LIMIT,
	VOICE_SESSIONS_SCHEMA,
	VOICE_SETTINGS_FILE,
	VOICE_SETTINGS_SCHEMA,
	writeVoicePushToTalk,
	writeVoiceSessions,
} from "../lib/voice-settings.ts";

// The persisted push-to-talk toggle, in a scratch config home inside the
// workspace tmp/ directory.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const homes: string[] = [];
const scratchHome = () => {
	const home = mkdtempSync(join(scratchRoot, "voice-ptt-"));
	homes.push(home);
	return home;
};
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("push-to-talk is off until written, and a written value survives a fresh read", () => {
	const home = scratchHome();
	const options = { gentlePiConfigHome: home };
	assert.equal(readVoicePushToTalk(options), false);
	const path = writeVoicePushToTalk(true, options);
	assert.equal(path, join(home, VOICE_SETTINGS_FILE));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: VOICE_SETTINGS_SCHEMA, pushToTalk: true });
	// A reload only re-reads the file.
	assert.equal(readVoicePushToTalk({ gentlePiConfigHome: home }), true);
	writeVoicePushToTalk(false, options);
	assert.equal(readVoicePushToTalk(options), false);
});

test("a malformed or foreign settings file reads as off", () => {
	const home = scratchHome();
	const path = join(home, VOICE_SETTINGS_FILE);
	for (const raw of ["not json", "[]", `{"schema":"${VOICE_SETTINGS_SCHEMA}","pushToTalk":"yes"}`, `{"schema":"other","pushToTalk":true}`, `{"schema":"${VOICE_SETTINGS_SCHEMA}","pushToTalk":true,"extra":1}`]) {
		writeFileSync(path, raw);
		assert.equal(readVoicePushToTalk({ gentlePiConfigHome: home }), false, raw);
	}
});

test("the config home follows the environment when no home is given", () => {
	const home = scratchHome();
	writeVoicePushToTalk(true, { gentlePiConfigHome: home });
	assert.equal(readVoicePushToTalk({ env: { GENTLE_PI_CONFIG_HOME: home } }), true);
});

// Voice sessions live in their own file, so the push-to-talk file and its
// strict parser stay exactly as they were.

test("voice sessions are empty until written, round-trip, and leave push-to-talk alone", () => {
	const home = scratchHome();
	const options = { gentlePiConfigHome: home };
	assert.deepEqual(readVoiceSessions(options), []);
	writeVoicePushToTalk(true, options);
	const path = writeVoiceSessions(["session-a", "session-b"], options);
	assert.equal(path, join(home, VOICE_SESSIONS_FILE));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: VOICE_SESSIONS_SCHEMA, sessions: ["session-a", "session-b"] });
	assert.deepEqual(readVoiceSessions(options), ["session-a", "session-b"]);
	writeVoiceSessions(["session-b"], options);
	assert.deepEqual(readVoiceSessions(options), ["session-b"]);
	assert.equal(readVoicePushToTalk(options), true, "push-to-talk is untouched");
});

test("only the most recent voice sessions are kept, without duplicates or blanks", () => {
	const home = scratchHome();
	const many = Array.from({ length: 80 }, (_value, index) => `session-${index}`);
	writeVoiceSessions([...many, "session-79", "", "  "], { gentlePiConfigHome: home });
	const kept = readVoiceSessions({ gentlePiConfigHome: home });
	assert.equal(kept.length, VOICE_SESSIONS_LIMIT);
	assert.deepEqual(kept, many.slice(-VOICE_SESSIONS_LIMIT));
});

test("a malformed or foreign voice sessions file reads as empty", () => {
	const home = scratchHome();
	const path = join(home, VOICE_SESSIONS_FILE);
	const schema = VOICE_SESSIONS_SCHEMA;
	for (const raw of ["not json", "[]", `{"schema":"other","sessions":["a"]}`, `{"schema":"${schema}","sessions":"a"}`, `{"schema":"${schema}","sessions":["a",3]}`, `{"schema":"${schema}","sessions":["a"],"extra":1}`]) {
		writeFileSync(path, raw);
		assert.deepEqual(readVoiceSessions({ gentlePiConfigHome: home }), [], raw);
	}
});
