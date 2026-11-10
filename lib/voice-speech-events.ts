import type { EventEmitter } from "node:events";
import { decodeWav } from "./voice-robot.ts";

// Reply-reading speech events (docs/voice.md, "Speech events"). While a reply
// is read aloud, this module publishes on the extension event bus what a
// consumer outside the voice command needs to follow the voice: that a reading
// started, how loud each chunk the player actually began is, and that it ended.
// The payload carries no reply text, path, session or error message: only the
// engine chain and the loudness of audio that already played. Importing this
// module has no side effects; nothing is published unless a reading calls it.

export const VOICE_SPEECH_EVENT = "gentle-ai:voice-speech";
export const VOICE_SPEECH_SCHEMA = "gentle-pi.voice-speech/v1";

// The loudness frame width. One value per 50 ms of audio: fine enough to follow
// a syllable or a word, coarse enough that a payload stays small.
export const VOICE_SPEECH_FRAME_MS = 50;

// The line the shared PowerShell player writes on stdout right before it starts
// playing the WAV line it just read. One marker per played line, so Node can
// pair each marker with the chunk it queued, in order.
export const PLAYBACK_MARKER = "play";

export interface VoiceSpeechChunk {
	frameMs: number;
	durationMs: number;
	levels: number[];
}

export interface VoiceSpeechStart {
	schema: typeof VOICE_SPEECH_SCHEMA;
	phase: "start";
	// The engine chain that reads the reply, for example "windows" or
	// "raul-robot+miro+kokoro+windows" when a fallback is in the chain.
	engine: string;
}

export interface VoiceSpeechChunkEvent extends VoiceSpeechChunk {
	schema: typeof VOICE_SPEECH_SCHEMA;
	phase: "chunk";
	engine: string;
}

export interface VoiceSpeechEnd {
	schema: typeof VOICE_SPEECH_SCHEMA;
	phase: "end";
	engine: string;
	// The outcome the reading log records: done, skipped (Esc), cancelled,
	// empty, unavailable or error.
	outcome: string;
}

export type VoiceSpeechEvent = VoiceSpeechStart | VoiceSpeechChunkEvent | VoiceSpeechEnd;

// The event bus a publisher writes to, as Pi's extension API exposes it.
export type VoiceSpeechBus = { emit(channel: string, data: unknown): unknown } | undefined;

export interface VoiceSpeechReading {
	// Ignored once the reading ended: a chunk that arrives late, after the
	// reading settled, is not part of it.
	chunk(chunk: VoiceSpeechChunk): void;
	// Ends the reading once. Every later call is ignored, so one start always
	// pairs with exactly one end.
	end(outcome: string): void;
}

export interface VoiceSpeechPublisher {
	// Publishes the start and returns the handle that ends it.
	begin(engine: string): VoiceSpeechReading;
}

// One publisher per voice command. Publishing is advisory: a consumer that
// throws while handling the event, and a session without an event bus, leave
// the reading exactly as it was.
export function createVoiceSpeechPublisher(bus: VoiceSpeechBus): VoiceSpeechPublisher {
	const publish = (event: VoiceSpeechEvent): void => {
		try {
			bus?.emit(VOICE_SPEECH_EVENT, event);
		} catch {
			/* the event is advisory: a listener never breaks the reading */
		}
	};
	return {
		begin(engine) {
			publish({ schema: VOICE_SPEECH_SCHEMA, phase: "start", engine });
			let ended = false;
			return {
				chunk(chunk) {
					if (ended) return;
					publish({ schema: VOICE_SPEECH_SCHEMA, phase: "chunk", engine, frameMs: chunk.frameMs, durationMs: chunk.durationMs, levels: chunk.levels });
				},
				end(outcome) {
					if (ended) return;
					ended = true;
					publish({ schema: VOICE_SPEECH_SCHEMA, phase: "end", engine, outcome });
				},
			};
		},
	};
}

// The loudness envelope of one chunk, measured from the same 16-bit WAV bytes
// the player receives: the RMS of every VOICE_SPEECH_FRAME_MS of audio,
// normalized so the loudest frame of this chunk is exactly 1. Per chunk, not
// absolute: a quiet sentence still shows its own shape, and a consumer scales
// it to its own effect. A silent chunk reports zeros.
export function wavLevels(wav: Buffer, frameMs = VOICE_SPEECH_FRAME_MS): VoiceSpeechChunk {
	const { samples, sampleRate } = decodeWav(wav);
	const frame = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
	const raw: number[] = [];
	for (let start = 0; start < samples.length; start += frame) {
		let sum = 0;
		const end = Math.min(samples.length, start + frame);
		for (let at = start; at < end; at++) sum += samples[at]! * samples[at]!;
		raw.push(Math.sqrt(sum / Math.max(1, end - start)));
	}
	const peak = raw.reduce((highest, level) => (level > highest ? level : highest), 0);
	const levels = peak > 0 ? raw.map((level) => Math.round((level / peak) * 1000) / 1000) : raw.map(() => 0);
	return { frameMs, durationMs: Math.round((samples.length / sampleRate) * 1000), levels };
}

// The chunks a player still owes: an engine queues one per WAV line it writes,
// and every marker shifts exactly one off the front, so each chunk is reported
// when it really begins playing, in the order it was queued. With no callback
// nothing is measured or reported.
export interface ChunkSink {
	queue(wav: Buffer): void;
	play(): void;
}

export function createChunkSink(onChunk?: (chunk: VoiceSpeechChunk) => void): ChunkSink {
	if (!onChunk) return { queue: () => {}, play: () => {} };
	const queued: VoiceSpeechChunk[] = [];
	return {
		queue(wav) {
			try {
				queued.push(wavLevels(wav));
			} catch {
				// A chunk that cannot be measured is still played; it is reported
				// with no loudness rather than not at all.
				queued.push({ frameMs: VOICE_SPEECH_FRAME_MS, durationMs: 0, levels: [] });
			}
		},
		play() {
			const next = queued.shift();
			if (!next) return;
			try {
				onChunk(next);
			} catch {
				/* the event is advisory: a consumer never breaks the player */
			}
		},
	};
}

// Reads the player's stdout line by line and calls onPlay for every playback
// marker. The rest of the output is native noise that is drained, never shown.
export function readPlaybackMarkers(stream: EventEmitter | null, onPlay: () => void): void {
	if (!stream) return;
	let buffered = "";
	stream.on("data", (data: unknown) => {
		buffered += String(data);
		// A player that floods one line never grows the buffer without bound.
		if (buffered.length > 64_000) buffered = "";
		let newline: number;
		while ((newline = buffered.indexOf("\n")) !== -1) {
			const line = buffered.slice(0, newline).replace(/\r/g, "").trim();
			buffered = buffered.slice(newline + 1);
			if (line === PLAYBACK_MARKER) {
				try {
					onPlay();
				} catch {
					/* the event is advisory: a consumer never breaks the player */
				}
			}
		}
	});
}
