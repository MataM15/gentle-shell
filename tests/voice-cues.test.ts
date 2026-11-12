import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createCuePlayer, cueTones, cueWav } from "../lib/voice-cues.ts";

// Microphone cues: generated tones, played only through an available player,
// in a private temporary directory removed on dispose.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const roots: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-cues-"));
	roots.push(dir);
	return dir;
};
after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("cueWav builds a 16-bit mono WAV of the requested length", () => {
	const wav = cueWav([660, 990], 160);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
	assert.equal(wav.readUInt16LE(22), 1);
	assert.equal(wav.readUInt32LE(24), 22050);
	assert.equal(wav.readUInt32LE(40), Math.round(22050 * 0.16) * 2);
	assert.notDeepEqual(cueWav([660, 990]), cueWav([990, 660]), "the rising and falling cues differ");
});

test("cues play through an available player; warm plays silence first and dispose removes the files", async () => {
	const tempRoot = scratch();
	const played: string[] = [];
	let disposed = 0;
	const player = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: true }), play: async (path) => { played.push(path); }, dispose: () => { disposed++; } } });
	player.warm();
	player.play("open");
	player.play("close");
	await settle();
	assert.deepEqual(played.map((path) => path.split("/").at(-1)), ["silence.wav", "open.wav", "close.wav"]);
	const [dir] = readdirSync(tempRoot);
	assert.ok(dir!.startsWith("gentle-voice-cues-"));
	player.dispose();
	assert.equal(disposed, 1);
	assert.equal(existsSync(join(tempRoot, dir!)), false);
	player.play("open");
	await settle();
	assert.equal(played.length, 3, "nothing plays after dispose");
});

test("no cue plays when the player is unavailable or fails, and nothing is written", async () => {
	const tempRoot = scratch();
	const played: string[] = [];
	const unavailable = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: false }), play: async (path) => { played.push(path); } } });
	unavailable.play("open");
	await settle();
	assert.deepEqual(played, []);
	assert.deepEqual(readdirSync(tempRoot), []);
	const failing = createCuePlayer({ tempRoot, backend: { probe: async () => { throw new Error("no socket"); }, play: async () => {} } });
	failing.play("open");
	await settle();
	unavailable.dispose();
	failing.dispose();
});

test("outside Linux the cues are silent and touch nothing", async () => {
	const player = createCuePlayer({ platform: "win32" });
	player.warm();
	player.play("open");
	player.dispose();
});

// A cue reports what happened, so voice-events.log can tell a cue that was
// played from one the Pulse player never confirmed.

test("every caller plays the same tone bytes: the microphone cue files never depend on who asked", async () => {
	const tempRoot = scratch();
	const played: string[] = [];
	const player = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: true }), play: async (path) => { played.push(path); } } });
	// A conversation turn and a dictation both call play("open")/play("close"); the
	// player has no mode, so the file a cue plays is one fixed byte string.
	await player.play("open");
	await player.play("close");
	await player.play("open");
	assert.deepEqual(played.map((path) => path.split("/").at(-1)), ["open.wav", "close.wav", "open.wav"]);
	const [open, close] = [readFileSync(played[0]!), readFileSync(played[1]!)];
	assert.deepEqual(open, cueTones().open, "the rising cue is the same tone every time");
	assert.deepEqual(close, cueTones().close, "the falling cue is the same tone every time");
	assert.notDeepEqual(open, close);
	player.dispose();
});

test("a cue reports its name, whether it played and how long it took", async () => {
	const tempRoot = scratch();
	const player = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: true }), play: async () => {} } });
	const done = await player.play("open");
	assert.equal(done.name, "open");
	assert.equal(done.outcome, "done");
	assert.equal(typeof done.ms, "number");
	assert.ok(done.ms >= 0);
	player.dispose();
	const unavailable = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: false }), play: async () => { throw new Error("must not play"); } } });
	assert.deepEqual(await unavailable.play("close"), { name: "close", outcome: "unavailable", ms: 0 });
	unavailable.dispose();
	const failing = createCuePlayer({ tempRoot, backend: { probe: async () => ({ available: true }), play: async () => { throw new Error("worker retired"); } } });
	const failed = await failing.play("open");
	assert.equal(failed.outcome, "failed");
	assert.ok(failed.ms >= 0);
	failing.dispose();
	const silent = createCuePlayer({ platform: "win32" });
	assert.deepEqual(await silent.play("open"), { name: "open", outcome: "unavailable", ms: 0 });
	silent.dispose();
});

test("a cue that the player did not confirm plays again once after a short pause", async () => {
	const tempRoot = scratch();
	const attempts: number[] = [];
	const player = createCuePlayer({ tempRoot, backend: {
		probe: async () => ({ available: true }),
		play: async () => {
			attempts.push(Date.now());
			if (attempts.length === 1) throw new Error("worker retired");
		},
	} });
	const retried = await player.play("open");
	assert.equal(retried.outcome, "done");
	assert.equal(attempts.length, 2, "the failed cue is tried once more");
	assert.ok(attempts[1]! - attempts[0]! >= 140, `the retry waits about 150 ms, waited ${attempts[1]! - attempts[0]!}`);
	assert.equal((await player.play("open")).outcome, "done");
	assert.equal(attempts.length, 3, "a cue that played is not played twice");
	player.dispose();
});
