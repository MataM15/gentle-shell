import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { encodeWav } from "../lib/voice-robot.ts";
import {
	createChunkSink,
	createVoiceSpeechPublisher,
	PLAYBACK_MARKER,
	readPlaybackMarkers,
	VOICE_SPEECH_EVENT,
	VOICE_SPEECH_FRAME_MS,
	VOICE_SPEECH_SCHEMA,
	wavLevels,
	type VoiceSpeechChunk,
} from "../lib/voice-speech-events.ts";

// The reply-reading speech events (S2-S5): one channel and three payloads on
// the extension event bus, the loudness envelope of a played WAV, and the
// playback markers the PowerShell player writes. Nothing here starts a process
// or reads a file.

const SCHEMA = "gentle-pi.voice-speech/v1";

test("the channel and schema are the documented ones", () => {
	assert.equal(VOICE_SPEECH_EVENT, "gentle-ai:voice-speech");
	assert.equal(VOICE_SPEECH_SCHEMA, SCHEMA);
	assert.equal(VOICE_SPEECH_FRAME_MS, 50);
	assert.equal(PLAYBACK_MARKER, "play");
});

// A 16 kHz tone at the given amplitude.
const tone = (sampleRate: number, seconds: number, amplitude: number) =>
	Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_value, index) => amplitude * Math.sin((2 * Math.PI * 220 * index) / sampleRate));

test("wavLevels measures one RMS value per 50 ms of audio, normalized to the loudest frame of the chunk", () => {
	const sampleRate = 16_000;
	const samples = new Float32Array([...tone(sampleRate, 0.05, 0.2), ...tone(sampleRate, 0.05, 0.1), ...tone(sampleRate, 0.06, 0.05)]);
	const envelope = wavLevels(encodeWav(samples, sampleRate));
	assert.equal(envelope.frameMs, 50);
	assert.equal(envelope.levels.length, 4, "one frame per 50 ms, the last frame taking the leftover samples");
	assert.equal(envelope.levels[0], 1, "the loudest frame is 1");
	assert.ok(Math.abs(envelope.levels[1]! - 0.5) < 0.01, `second frame halved, got ${envelope.levels[1]}`);
	assert.ok(Math.abs(envelope.levels[2]! - 0.25) < 0.01, `third frame a quarter, got ${envelope.levels[2]}`);
	assert.ok(Math.abs(envelope.levels[3]! - 0.25) < 0.01, `the leftover frame keeps its level, got ${envelope.levels[3]}`);
	assert.equal(envelope.durationMs, 160);
});

test("wavLevels reports silence as zeros and keeps the payload within 0..1", () => {
	const silent = new Float32Array(1600);
	const envelope = wavLevels(encodeWav(silent, 16_000));
	assert.deepEqual(envelope.levels, [0, 0], "a silent chunk peaks at zero, so every frame is zero");
	assert.ok(envelope.levels.every((level) => level >= 0 && level <= 1));
});

test("a reading publishes start, every played chunk and exactly one end, in order", () => {
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const publisher = createVoiceSpeechPublisher({ emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); } });
	const reading = publisher.begin("kokoro");
	assert.deepEqual(emitted, [{ channel: "gentle-ai:voice-speech", data: { schema: SCHEMA, phase: "start", engine: "kokoro" } }]);
	reading.chunk({ frameMs: 50, durationMs: 300, levels: [1, 0.4] });
	assert.deepEqual(emitted[1]!.data, { schema: SCHEMA, phase: "chunk", engine: "kokoro", frameMs: 50, durationMs: 300, levels: [1, 0.4] });
	reading.end("done");
	assert.deepEqual(emitted[2]!.data, { schema: SCHEMA, phase: "end", engine: "kokoro", outcome: "done" });
	reading.end("done");
	reading.chunk({ frameMs: 50, durationMs: 300, levels: [1] });
	assert.equal(emitted.length, 3, "one end per start, and nothing is published after it");
});

test("each reading gets its own start, so a skipped and a failed reading each end once", () => {
	const emitted: unknown[] = [];
	const publisher = createVoiceSpeechPublisher({ emit: (_channel: string, data: unknown) => { emitted.push(data); } });
	publisher.begin("miro").end("skipped");
	publisher.begin("miro").end("error");
	const phases = (emitted as Array<{ phase: string; outcome?: string }>).map((event) => event.phase);
	assert.deepEqual(phases, ["start", "end", "start", "end"]);
	assert.deepEqual((emitted as Array<{ outcome?: string }>).filter((event) => event.outcome).map((event) => event.outcome), ["skipped", "error"]);
});

test("a listener that throws, and a missing event bus, never reach the reading", () => {
	const publisher = createVoiceSpeechPublisher({ emit: () => { throw new Error("listener failed"); } });
	const reading = publisher.begin("kokoro");
	assert.doesNotThrow(() => reading.chunk({ frameMs: 50, durationMs: 10, levels: [1] }));
	assert.doesNotThrow(() => reading.end("done"));
	const inert = createVoiceSpeechPublisher(undefined);
	assert.doesNotThrow(() => inert.begin("windows").end("done"));
});

test("the player's markers are read line by line, even when a line arrives in pieces", () => {
	const stream = new EventEmitter();
	const plays: number[] = [];
	readPlaybackMarkers(stream, () => { plays.push(plays.length + 1); });
	stream.emit("data", `${PLAYBACK_MARKER}\n`);
	stream.emit("data", "pl");
	stream.emit("data", `ay\r\n`);
	stream.emit("data", "progress: something else\n");
	stream.emit("data", `played\n`);
	assert.deepEqual(plays, [1, 2], "only an exact marker counts, and a split line still counts once");
	readPlaybackMarkers(null, () => { plays.push(99); });
	assert.deepEqual(plays, [1, 2], "a player without output is inert");
});

test("queued chunks are reported in FIFO order when the player begins each one", () => {
	const seen: VoiceSpeechChunk[] = [];
	const sink = createChunkSink((chunk) => { seen.push(chunk); });
	const first = { frameMs: 50, durationMs: 200, levels: [1, 0.3, 0.3, 0.3] };
	const second = { frameMs: 50, durationMs: 100, levels: [1, 0.3] };
	sink.queue(encodeWav(tone(16_000, 0.2, 0.2), 16_000));
	sink.queue(encodeWav(tone(16_000, 0.1, 0.1), 16_000));
	assert.deepEqual(seen, [], "nothing is reported before it plays");
	sink.play();
	assert.deepEqual(seen.length, 1);
	assert.equal(seen[0]!.frameMs, first.frameMs);
	assert.equal(seen[0]!.durationMs, first.durationMs);
	assert.equal(seen[0]!.levels.length, first.levels.length);
	sink.play();
	assert.equal(seen[1]!.durationMs, second.durationMs);
	sink.play();
	assert.equal(seen.length, 2, "a marker with nothing queued reports nothing");
});

test("a chunk callback that throws, or none at all, never breaks playback", () => {
	const throwing = createChunkSink(() => { throw new Error("consumer failed"); });
	assert.doesNotThrow(() => throwing.queue(encodeWav(tone(16_000, 0.1, 0.2), 16_000)));
	assert.doesNotThrow(() => throwing.play());
	const silent = createChunkSink(undefined);
	assert.doesNotThrow(() => silent.queue(Buffer.from("not a wav")));
	assert.doesNotThrow(() => silent.play());
});
