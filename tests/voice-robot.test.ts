import assert from "node:assert/strict";
import test from "node:test";
import { decodeWav, encodeWav, levelVoice, robotize, robotizeStream } from "../lib/voice-robot.ts";

// The metallic "robot" effect the owner picked (R2): each short frame keeps the
// strength of every frequency and drops its phase, then the result is louder.

const RATE = 16000;
const sine = (frequency: number, seconds: number, gain = 0.3) =>
	Float32Array.from({ length: Math.round(RATE * seconds) }, (_value, index) => gain * Math.sin((2 * Math.PI * frequency * index) / RATE));
const rms = (samples: Float32Array, from = 0, to = samples.length) => {
	let sum = 0;
	for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
	return Math.sqrt(sum / Math.max(1, to - from));
};

test("robotize keeps the length, stays finite and within full scale, and silence stays silent", () => {
	const input = sine(220, 1);
	const output = robotize(input);
	assert.equal(output.length, input.length);
	assert.ok(output.every((value) => Number.isFinite(value) && value >= -1 && value <= 1));
	assert.deepEqual([...robotize(new Float32Array(4000))], [...new Float32Array(4000)]);
	assert.deepEqual(robotize(new Float32Array(0)).length, 0);
	assert.equal(robotize(new Float32Array(100)).length, 100, "shorter than one frame");
});

// Like ffmpeg's, the effect lowers the level a lot (the owner heard it as
// quiet): levelVoice brings it back up.
test("robotize changes the waveform and keeps an audible, much lower level", () => {
	const input = sine(220, 1);
	const output = robotize(input);
	const middle = [RATE * 0.25, RATE * 0.75] as const;
	const inLevel = rms(input, ...middle);
	const outLevel = rms(output, ...middle);
	assert.ok(outLevel > 0.005 && outLevel < inLevel, `level ${outLevel} vs ${inLevel}`);
	let difference = 0;
	for (let i = middle[0]; i < middle[1]; i++) difference += Math.abs(output[i]! - input[i]!);
	assert.ok(difference / (middle[1] - middle[0]) > 0.01, "the waveform is not passed through unchanged");
	assert.deepEqual([...robotize(input)], [...output], "deterministic");
});

test("a loud input is clipped to full scale instead of wrapping", () => {
	const output = robotize(sine(440, 0.5, 0.95));
	assert.ok(Math.max(...output.map(Math.abs)) <= 1);
});

test("encodeWav and decodeWav round-trip 16-bit mono PCM", () => {
	const samples = Float32Array.from([0, 0.5, -0.5, 0.25]);
	const wav = encodeWav(samples, 16000);
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	const decoded = decodeWav(wav);
	assert.equal(decoded.sampleRate, 16000);
	assert.deepEqual([...decoded.samples].map((value) => Math.round(value * 1000) / 1000), [0, 0.5, -0.5, 0.25]);
});

test("decodeWav reads a stereo file as mono, skips extra chunks, and rejects what it cannot read", () => {
	const fmt = Buffer.alloc(24);
	fmt.write("fmt ", 0, "ascii");
	fmt.writeUInt32LE(16, 4);
	fmt.writeUInt16LE(1, 8);
	fmt.writeUInt16LE(2, 10);
	fmt.writeUInt32LE(22050, 12);
	fmt.writeUInt32LE(22050 * 4, 16);
	fmt.writeUInt16LE(4, 20);
	fmt.writeUInt16LE(16, 22);
	const list = Buffer.concat([Buffer.from("LIST", "ascii"), Buffer.from([3, 0, 0, 0]), Buffer.from("abc\0", "ascii")]);
	const pcm = Buffer.alloc(8);
	pcm.writeInt16LE(16384, 0);
	pcm.writeInt16LE(0, 2);
	pcm.writeInt16LE(-16384, 4);
	pcm.writeInt16LE(-16384, 6);
	const data = Buffer.concat([Buffer.from("data", "ascii"), Buffer.from([8, 0, 0, 0]), pcm]);
	const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, list, data]);
	const head = Buffer.alloc(8);
	head.write("RIFF", 0, "ascii");
	head.writeUInt32LE(body.length, 4);
	const decoded = decodeWav(Buffer.concat([head, body]));
	assert.equal(decoded.sampleRate, 22050);
	assert.deepEqual([...decoded.samples], [0.25, -0.5]);
	assert.throws(() => decodeWav(Buffer.from("not a wav")));
});

test("robotize is ffmpeg's stream aligned with its input: the stream lags by 384 samples", () => {
	const input = sine(300, 0.5);
	const aligned = robotize(input);
	const padded = new Float32Array(input.length + 384);
	padded.set(input);
	const streamed = robotizeStream(padded);
	for (const at of [1000, 4000, 7000]) assert.ok(Math.abs(aligned[at]! - Math.max(-1, Math.min(1, streamed[at + 384]! * 1.6))) < 1e-6, String(at));
});

test("levelVoice lifts a quiet passage close to a loud one and leaves silence silent", () => {
	const loud = sine(200, 1, 0.2);
	const quiet = sine(200, 1, 0.03);
	const input = new Float32Array(RATE * 3);
	input.set(loud, 0);
	input.set(quiet, RATE * 2);
	const output = levelVoice(input, RATE);
	assert.equal(output.length, input.length);
	const loudLevel = rms(output, RATE * 0.3, RATE * 0.7);
	const quietLevel = rms(output, RATE * 2.3, RATE * 2.7);
	assert.ok(quietLevel > loudLevel * 0.6, `quiet ${quietLevel} vs loud ${loudLevel}`);
	assert.ok(quietLevel > rms(input, RATE * 2.3, RATE * 2.7) * 2, "the quiet passage got louder");
	assert.ok(rms(output, RATE * 1.3, RATE * 1.7) < 1e-6, "silence is not amplified");
	assert.ok(output.every((value) => value >= -1 && value <= 1));
});

test("levelVoice never boosts low noise between words", () => {
	const noise = Float32Array.from({ length: RATE }, (_value, i) => 0.002 * Math.sin(i * 1.7));
	assert.ok(rms(levelVoice(noise, RATE)) <= rms(noise) * 1.01);
});
