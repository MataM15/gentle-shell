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

// What the overlay shows: the state, the language, whether the microphone
// really records, and the session that owns the capture or the reading, so the
// window can name it. All of it is display data; nothing here is used to route a
// transcript.
export interface VoiceOverlaySnapshot {
	readonly state: ListenerState;
	readonly language: ListenerLanguage;
	// True from the moment the capture really records to the moment it stops
	// recording, and false at every other time in every state (S10). The listener
	// sets it from the worker's own report; a level never claims it.
	readonly recording: boolean;
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

// ---- the host protocol codec (T12) -----------------------------------------
// What the Windows window is told, one small line per command. Pure so the
// bounds and the sanitizing are tested without a window.

// A session label is display text only: control characters and runs of blanks
// go, and it is cut to this many characters so a line stays small.
export const OVERLAY_LABEL_MAX = 48;

export function sanitizeOverlayLabel(label: string | undefined): string {
	if (typeof label !== "string") return "";
	const clean = label.replace(/[\p{C}\p{Z}]+/gu, " ").trim();
	return [...clean].slice(0, OVERLAY_LABEL_MAX).join("").trim();
}

// A display level (0..1) as the whole percent the window takes, 0..100.
export function levelToPercent(value: number): number {
	return Math.round(clamp01(value) * 100);
}

const OVERLAY_STATES: readonly string[] = ["asleep", "listening", "transcribing", "reading"];
const OVERLAY_LANGUAGES: readonly string[] = ["es", "en"];

// `state <state> <language> <label in base64, or - when there is none>`: the
// label travels as base64 so no character of it can end or split the line. The
// recording flag is not part of it: it is the separate `rec 1`/`rec 0` line the
// window takes after the state was acknowledged, so the state line stays what it
// always was.
export function encodeOverlayState(snapshot: VoiceOverlaySnapshot): string {
	if (!OVERLAY_STATES.includes(snapshot.state)) throw new Error("overlay: unknown state");
	if (!OVERLAY_LANGUAGES.includes(snapshot.language)) throw new Error("overlay: unknown language");
	const label = sanitizeOverlayLabel(snapshot.label);
	return `state ${snapshot.state} ${snapshot.language} ${label ? Buffer.from(label, "utf8").toString("base64") : "-"}`;
}

// ---- the output meter (T12, T13) -------------------------------------------
// The reply voice publishes the loudness of the speech the player really
// started: an RMS on a 0..1 scale, typically 0.03 to 0.3, and digital silence
// (0) between words. The microphone meter above is tuned to a noisy WSLg input
// (floor 0.0031, speech 0.016) and would pin every bar of a reading at full, so
// a reading has its own preset. Same smoothing, different floor and ceiling.
export const OVERLAY_OUTPUT_FLOOR_RMS = 0.02;
export const OVERLAY_OUTPUT_SPEECH_RMS = 0.25;

export function normalizeOutputLevel(rms: number): number {
	const value = Number.isFinite(rms) ? rms : 0;
	return clamp01((value - OVERLAY_OUTPUT_FLOOR_RMS) / (OVERLAY_OUTPUT_SPEECH_RMS - OVERLAY_OUTPUT_FLOOR_RMS));
}

export function createOutputLevelMeter(): LevelMeter {
	let level = 0;
	return {
		push(rms) {
			level = smoothLevel(level, normalizeOutputLevel(rms));
			return level;
		},
		reset() {
			level = 0;
		},
	};
}

// The meter for what the overlay is showing: the played speech while reading,
// the microphone in every other state.
export function createLevelMeterFor(state: ListenerState): LevelMeter {
	return state === "reading" ? createOutputLevelMeter() : createLevelMeter();
}
