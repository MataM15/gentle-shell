import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRobotVoiceEngine, ONECORE_SYNTH_SCRIPT, processRobotVoice } from "../lib/voice-onecore.ts";
import { PLAYBACK_MARKER, type VoiceSpeechChunk } from "../lib/voice-speech-events.ts";
import { decodeWav, encodeWav } from "../lib/voice-robot.ts";

// The owner's voice (T8): Windows OneCore "Microsoft Raul" synthesized locally
// sentence by sentence, robotized and leveled in code, played by one player.
// Fake processes only.

class FakeProc extends EventEmitter {
	readonly written: string[] = [];
	ended = false;
	readonly signals: NodeJS.Signals[] = [];
	stdin = { write: (chunk: string) => { this.written.push(chunk); return true; }, end: () => { this.ended = true; }, on: () => {} };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(signal: NodeJS.Signals) {
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
	lines() {
		return this.written.join("").split("\n").filter(Boolean);
	}
}

const tone = (seconds = 0.2) => encodeWav(Float32Array.from({ length: Math.round(16000 * seconds) }, (_value, i) => 0.05 * Math.sin(i / 5)), 16000).toString("base64");

function harness(timeoutMs?: (text: string) => number, volume?: number) {
	const procs: Array<{ args: readonly string[]; options: Record<string, unknown>; proc: FakeProc }> = [];
	const engine = createRobotVoiceEngine({
		powershell: "/mnt/c/Windows/powershell.exe",
		spawn: (_command, args, options) => {
			const proc = new FakeProc();
			procs.push({ args, options, proc });
			return proc;
		},
		timeoutMs,
		volume,
	});
	const scriptOf = (entry: { args: readonly string[] }) => Buffer.from(entry.args.at(-1)!, "base64").toString("utf16le");
	const synth = () => procs.find((entry) => scriptOf(entry) === ONECORE_SYNTH_SCRIPT)!;
	const player = () => procs.find((entry) => scriptOf(entry) !== ONECORE_SYNTH_SCRIPT)!;
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(check(), "condition not reached");
	};
	return { engine, procs, synth, player, until };
}

test("each sentence goes to the synthesizer as base64 JSON, and comes back robotized and leveled to the player", async () => {
	const h = harness();
	const spoken = h.engine.speak("Hola. Esto suena a robot.", { language: "es", signal: new AbortController().signal });
	await h.until(() => h.procs.length === 2 && h.synth().proc.lines().length === 2);
	const requests = h.synth().proc.lines().map((line) => JSON.parse(Buffer.from(line, "base64").toString("utf8")));
	assert.deepEqual(requests, [{ text: "Hola." }, { text: "Esto suena a robot." }]);
	assert.equal(h.synth().proc.ended, true, "every sentence is queued at once");
	for (const entry of h.procs) {
		assert.deepEqual(entry.args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
		assert.equal(entry.options.shell, false);
	}
	const original = tone();
	h.synth().proc.stdout.emit("data", `audio:${original}\naudio:${tone()}\n`);
	await h.until(() => h.player().proc.lines().length === 1);
	assert.equal(h.player().proc.lines().length, 1, "the next sentence waits until the player begins the previous one");
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	await h.until(() => h.player().proc.lines().length === 2);
	const played = decodeWav(Buffer.from(h.player().proc.lines()[0]!, "base64"));
	assert.equal(played.sampleRate, 16000);
	assert.notDeepEqual([...played.samples.slice(2000, 2010)], [...decodeWav(Buffer.from(original, "base64")).samples.slice(2000, 2010)], "the audio is processed before playing");
	h.synth().proc.emit("exit", 0, null);
	assert.equal(h.player().proc.ended, true);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("English replies and empty text start nothing; English is refused so the next voice reads it", async () => {
	const h = harness();
	await assert.rejects(h.engine.speak("Done, all tests pass.", { language: "en", signal: new AbortController().signal }), (error: unknown) => (error as { audible?: boolean }).audible === false);
	assert.equal(await h.engine.speak("   ", { language: "es", signal: new AbortController().signal }), "done");
	assert.equal(h.procs.length, 0);
});

test("a missing Raúl voice before any audio is refused without audio, so Miro reads instead", async () => {
	const h = harness();
	const spoken = h.engine.speak("Hola.", { language: "es", signal: new AbortController().signal });
	await h.until(() => h.procs.length === 2);
	h.synth().proc.stdout.emit("data", "error:no-voice\n");
	await assert.rejects(spoken, (error: unknown) => (error as { audible?: boolean }).audible === false && /Raúl/.test((error as Error).message));
	assert.ok(h.player().proc.signals.length > 0, "the player is stopped");
});

test("a failure after audio was played is marked audible, and cancel or timeout stop both processes", async () => {
	const h = harness();
	const spoken = h.engine.speak("Uno. Dos.", { language: "es", signal: new AbortController().signal });
	await h.until(() => h.procs.length === 2);
	h.synth().proc.stdout.emit("data", `audio:${tone()}\n`);
	await h.until(() => h.player().proc.lines().length === 1);
	h.synth().proc.stdout.emit("data", "error:synthesis\n");
	await assert.rejects(spoken, (error: unknown) => (error as { audible?: boolean }).audible === true);

	const c = harness();
	const controller = new AbortController();
	const cancelled = c.engine.speak("Hola.", { language: "es", signal: controller.signal });
	await c.until(() => c.procs.length === 2);
	controller.abort();
	assert.equal(await cancelled, "cancelled");
	assert.ok(c.procs.every((entry) => entry.proc.signals.includes("SIGTERM")));

	const t = harness(() => 20);
	const timedOut = t.engine.speak("Hola.", { language: "es", signal: new AbortController().signal });
	await assert.rejects(timedOut, /took too long/);
});

test("unreadable synthesizer output fails cleanly", async () => {
	const h = harness();
	const spoken = h.engine.speak("Hola.", { language: "es", signal: new AbortController().signal });
	await h.until(() => h.procs.length === 2);
	h.synth().proc.stdout.emit("data", "audio:bm90IGEgd2F2\n");
	await assert.rejects(spoken, (error: unknown) => (error as { audible?: boolean }).audible === false);
});

test("GENTLE_PI_VOICE_VOLUME quiets the robotized audio the player gets, after the leveling", async () => {
	const h = harness(undefined, 0.5);
	const spoken = h.engine.speak("Hola.", { language: "es", signal: new AbortController().signal });
	await h.until(() => h.procs.length === 2);
	const original = tone();
	h.synth().proc.stdout.emit("data", `audio:${original}\n`);
	await h.until(() => h.player().proc.lines().length === 1);
	const unscaled = decodeWav(processRobotVoice(Buffer.from(original, "base64")));
	const played = decodeWav(Buffer.from(h.player().proc.lines()[0]!, "base64"));
	const peakOf = (samples: Float32Array) => samples.reduce((highest, sample) => Math.max(highest, Math.abs(sample)), 0);
	assert.ok(Math.abs(peakOf(played.samples) - peakOf(unscaled.samples) * 0.5) < 0.01, "the volume applies to the processed audio, so the leveling never undoes it");
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	h.synth().proc.emit("exit", 0, null);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("each sentence publishes its loudness when the player begins it, measured on the processed audio", async () => {
	const h = harness();
	const chunks: VoiceSpeechChunk[] = [];
	const spoken = h.engine.speak("Uno. Dos.", { language: "es", signal: new AbortController().signal, onChunk: (chunk) => { chunks.push(chunk); } });
	await h.until(() => h.procs.length === 2);
	h.synth().proc.stdout.emit("data", `audio:${tone(0.2)}\naudio:${tone(0.1)}\n`);
	await h.until(() => h.player().proc.lines().length === 1);
	assert.deepEqual(chunks, [], "sentences waiting in the player are not reported as played");
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	await h.until(() => h.player().proc.lines().length === 2);
	assert.equal(chunks.length, 1);
	assert.equal(chunks[0]!.frameMs, 50);
	assert.equal(chunks[0]!.durationMs, 200);
	assert.equal(chunks[0]!.levels.length, 4);
	assert.equal(Math.max(...chunks[0]!.levels), 1);
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	assert.equal(chunks[1]!.durationMs, 100);
	h.synth().proc.emit("exit", 0, null);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
	assert.equal(chunks.length, 2);
});
