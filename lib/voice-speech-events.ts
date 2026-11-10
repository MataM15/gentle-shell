import type { EventEmitter } from "node:events";
import { decodeWav } from "./voice-robot.ts";

// Reply-reading speech events (docs/voice.md, "Speech events"). While a reply
// is read aloud, this module publishes on the extension event bus what a
// consumer outside the voice command needs to follow the voice: that a reading
// started, how loud each chunk the player actually began is, and that it ended.
// The payload carries no reply text, path, session or error message: only the
// voice name and the loudness of audio that already played. Importing this
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
	// The voice that reads the reply, for example "Microsoft Raul" or
	// "Microsoft David", not the chain that produced it.
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

// The chunks the player owes, and the line it is fed: one WAV at a time. An
// engine queues each chunk as it is synthesized and the feed writes it to the
// player, but only when the player is free, that is, only after it reported it
// began the previous one (the very first chunk goes out at once, so a reading
// never waits for itself). This is not pacing: nothing is measured here.
//
// It is what keeps the report on time. Under WSL the Windows player's input and
// output travel over one interop relay, and while that relay still has chunk
// bytes to deliver into the player's stdin it does not pass on the marker the
// player wrote. A player fed several chunks ahead therefore reports each one a
// chunk late, and the audio it names has already been heard: measured here with
// four 4 s chunks written up front, the first marker reached Node about 4.1 s
// after it was written, the rest arrived in pairs as the player drew them in,
// while the same player fed one chunk at a time reported every marker within
// 20 ms. With one chunk in the player, the relay has nothing left to deliver
// when the player writes its marker.
//
// With no onChunk nothing is measured or reported, and the feed still paces the
// writes, so a session that follows no events behaves the same way.
export interface PlayerFeed {
	// A chunk is synthesized: measured now and written when the player is free.
	queue(wav: Buffer): void;
	// The player began the chunk it was last given.
	play(): void;
	// No more chunks are coming: the input ends once every one was written.
	close(): void;
}

export interface PlayerFeedOptions {
	// Sends one base64 WAV line the player reads and plays.
	write(line: string): void;
	// Ends the player's input, so it stops after the last chunk it plays.
	end(): void;
	onChunk?: (chunk: VoiceSpeechChunk) => void;
}

export function createPlayerFeed(options: PlayerFeedOptions): PlayerFeed {
	const waiting: Array<{ line: string; chunk?: VoiceSpeechChunk }> = [];
	// The chunk the player has but did not begin yet: its marker releases the
	// next write and reports it.
	let inflight: { chunk?: VoiceSpeechChunk } | undefined;
	let closing = false;
	let ended = false;
	const endOnce = () => {
		if (ended) return;
		ended = true;
		try {
			options.end();
		} catch {
			/* a player that is already gone never breaks the reading */
		}
	};
	const flush = () => {
		if (!inflight && waiting.length > 0) {
			const next = waiting.shift()!;
			inflight = { chunk: next.chunk };
			try {
				options.write(next.line);
			} catch {
				/* a player that cannot be written to never breaks the reading */
			}
		}
		// The input ends behind the last chunk, so the player reads it whole and
		// stops after playing it.
		if (closing && waiting.length === 0) endOnce();
	};
	return {
		queue(wav) {
			let chunk: VoiceSpeechChunk | undefined;
			if (options.onChunk) {
				try {
					chunk = wavLevels(wav);
				} catch {
					// A chunk that cannot be measured is still played; it is reported
					// with no loudness rather than not at all.
					chunk = { frameMs: VOICE_SPEECH_FRAME_MS, durationMs: 0, levels: [] };
				}
			}
			waiting.push({ line: `${wav.toString("base64")}\n`, chunk });
			flush();
		},
		play() {
			const started = inflight;
			if (!started) return;
			inflight = undefined;
			if (started.chunk) {
				try {
					options.onChunk?.(started.chunk);
				} catch {
					/* the event is advisory: a consumer never breaks the player */
				}
			}
			flush();
		},
		close() {
			closing = true;
			flush();
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
