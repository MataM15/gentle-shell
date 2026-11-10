import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { encodeWav } from "../lib/voice-robot.ts";
import {
	createPlayerFeed,
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

test("the player is fed one chunk at a time, so its report never trails the audio by a chunk", () => {
	// WSL carries a Windows player's input and output over one interop relay:
	// while it still has chunk bytes to deliver, it does not pass on the marker
	// the player wrote. Writing every chunk up front therefore put each marker
	// one chunk behind the audio it describes, and the next chunk is written
	// only once the player reports it began the previous one.
	const written: string[] = [];
	const seen: VoiceSpeechChunk[] = [];
	const feed = createPlayerFeed({ write: (line) => { written.push(line); }, end: () => {}, onChunk: (chunk) => { seen.push(chunk); } });
	const first = encodeWav(tone(16_000, 0.2, 0.2), 16_000);
	const second = encodeWav(tone(16_000, 0.1, 0.1), 16_000);
	const line = (wav: Buffer) => `${wav.toString("base64")}\n`;
	feed.queue(first);
	assert.deepEqual(written, [line(first)], "the first chunk goes out at once, so the reading never waits");
	feed.queue(second);
	assert.equal(written.length, 1, "the next chunk is held back while the player still owes a marker");
	assert.deepEqual(seen, [], "nothing is reported before it plays");
	feed.play();
	assert.equal(seen.length, 1, "the marker reports the chunk that just began");
	assert.equal(seen[0]!.frameMs, 50);
	assert.equal(seen[0]!.durationMs, 200);
	assert.equal(seen[0]!.levels.length, 4);
	assert.deepEqual(written, [line(first), line(second)], "the marker releases exactly the next chunk");
	feed.play();
	assert.equal(seen.length, 2);
	assert.equal(seen[1]!.durationMs, 100, "each marker advances the queue exactly one chunk");
	assert.equal(written.length, 2);
	feed.play();
	assert.equal(seen.length, 2, "a marker with no chunk in the player reports nothing");
});

test("the player's input ends once every queued chunk was written, and only once", () => {
	const written: string[] = [];
	let ends = 0;
	const feed = createPlayerFeed({ write: (line) => { written.push(line); }, end: () => { ends++; } });
	feed.queue(encodeWav(tone(16_000, 0.2, 0.2), 16_000));
	feed.queue(encodeWav(tone(16_000, 0.1, 0.1), 16_000));
	feed.close();
	assert.equal(ends, 0, "a chunk still waiting keeps the input open");
	feed.play();
	assert.equal(written.length, 2);
	assert.equal(ends, 1, "the input closes as soon as the last chunk went out");
	feed.close();
	feed.play();
	assert.equal(ends, 1, "closing twice, or a late marker, never closes the input again");
});

test("a chunk that cannot be measured still plays, and is reported with no loudness", () => {
	const written: string[] = [];
	const seen: VoiceSpeechChunk[] = [];
	const feed = createPlayerFeed({ write: (line) => { written.push(line); }, end: () => {}, onChunk: (chunk) => { seen.push(chunk); } });
	const notWav = Buffer.from("not a wav");
	feed.queue(notWav);
	assert.deepEqual(written, [`${notWav.toString("base64")}\n`], "the reply is read even when its loudness cannot be measured");
	feed.play();
	assert.deepEqual(seen, [{ frameMs: VOICE_SPEECH_FRAME_MS, durationMs: 0, levels: [] }]);
});

test("a consumer that throws, a player that cannot be written to, and no callback at all never stop the reading", () => {
	const written: string[] = [];
	const throwing = createPlayerFeed({ write: (line) => { written.push(line); }, end: () => {}, onChunk: () => { throw new Error("consumer failed"); } });
	throwing.queue(encodeWav(tone(16_000, 0.1, 0.2), 16_000));
	throwing.queue(encodeWav(tone(16_000, 0.1, 0.2), 16_000));
	assert.doesNotThrow(() => throwing.play());
	assert.equal(written.length, 2, "a failing consumer never holds the next chunk back");
	const broken = createPlayerFeed({ write: () => { throw new Error("closed"); }, end: () => { throw new Error("closed"); }, onChunk: () => { throw new Error("consumer failed"); } });
	assert.doesNotThrow(() => {
		broken.queue(encodeWav(tone(16_000, 0.1, 0.2), 16_000));
		broken.play();
		broken.close();
	});
	const silent = createPlayerFeed({ write: () => {}, end: () => {} });
	assert.doesNotThrow(() => {
		silent.queue(Buffer.from("not a wav"));
		silent.play();
		silent.close();
	});
});
