import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createCuePlayer, cueWav } from "../lib/voice-cues.ts";

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
