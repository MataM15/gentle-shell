import type { ListenerLanguage, ListenerState } from "./voice-listener-protocol.ts";

// The display side of voice (T4, S5, odd/notes/voice-overlay-design.md): a small
// port the listener drives, and the pure helpers a window needs to draw a level
// meter. Nothing here opens a window, a socket or a device: the Windows overlay
// (T12) implements `VoiceOverlay` and the listener hands it snapshots and
// levels, so a window that dies or hangs can never take voice down with it.
//
// The detector keeps its own thresholds in scripts/voice-worker.cjs. The meter
// below only decides how loud the same microphone RMS looks, and it belongs
// here: normalization and smoothing are display concerns, and turning them into
// something the detector judged would change when a recording ends.

// Measured on the owner's WSLg microphone on 2026-11-02: a noise floor near
// 0.0031 RMS, speech from about 0.016. The same measurement the endpointer's
// comment records, used here for pixels rather than for decisions.
export const OVERLAY_FLOOR_RMS = 0.0031;
export const OVERLAY_SPEECH_RMS = 0.016;
// A bar jumps to the sound and drains slowly, so a syllable is visible without
// the meter flickering: 60% of the gap on the way up, 25% on the way down.
export const OVERLAY_ATTACK = 0.6;
export const OVERLAY_RELEASE = 0.25;

// What the overlay shows: the state, the language, and the session that owns
// the capture or the reading, so the window can name it. All of it is display
// data; nothing here is used to route a transcript.
export interface VoiceOverlaySnapshot {
	readonly state: ListenerState;
	readonly language: ListenerLanguage;
	readonly label?: string;
	readonly paneId?: string;
}

// The port the listener owns and drives. Every method may throw or reject: the
// listener logs `overlay.failed` once and goes on without it.
export interface VoiceOverlay {
	show(snapshot: VoiceOverlaySnapshot): void | Promise<void>;
	// A display level, already normalized to 0..1 and smoothed, one per 50 ms of
	// audio while a capture records.
	level(value: number): void | Promise<void>;
	dispose(): void | Promise<void>;
}

const clamp01 = (value: number): number => {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	return value >= 1 ? 1 : value;
};

// The microphone RMS as a fraction of the bar: nothing at or below the measured
// floor, a full bar at measured speech, and a straight line in between.
export function normalizeLevel(rms: number): number {
	const value = Number.isFinite(rms) ? rms : 0;
	return clamp01((value - OVERLAY_FLOOR_RMS) / (OVERLAY_SPEECH_RMS - OVERLAY_FLOOR_RMS));
}

// One step of the meter towards its next value: fast up, slow down, always in
// 0..1. A NaN from either side is treated as silence rather than drawn.
export function smoothLevel(previous: number, next: number): number {
	const from = clamp01(previous);
	const to = clamp01(next);
	return from + (to - from) * (to > from ? OVERLAY_ATTACK : OVERLAY_RELEASE);
}

// The meter of one recording: raw worker RMS in, display level out. The listener
// creates one per capture and resets it when the microphone closes.
export interface LevelMeter {
	push(rms: number): number;
	reset(): void;
}

export function createLevelMeter(): LevelMeter {
	let level = 0;
	return {
		push(rms) {
			level = smoothLevel(level, normalizeLevel(rms));
			return level;
		},
		reset() {
			level = 0;
		},
	};
}
