import assert from "node:assert/strict";
import test from "node:test";
import { createLevelMeter, createLevelMeterFor, createOutputLevelMeter, normalizeLevel, normalizeOutputLevel, OVERLAY_OUTPUT_FLOOR_RMS, OVERLAY_OUTPUT_SPEECH_RMS, OVERLAY_ATTACK, OVERLAY_FLOOR_RMS, OVERLAY_RELEASE, OVERLAY_SPEECH_RMS, smoothLevel } from "../lib/voice-overlay.ts";

// The display side of the level meter (T4, S5, odd/notes/voice-overlay-design.md).
// The detector keeps its own measured thresholds; the meter only turns the same
// microphone RMS into something a window can draw. Pure functions, no window.

test("the measured WSLg floor draws nothing and measured speech draws a full bar", () => {
	// Measured on the owner's WSLg microphone on 2026-11-02: a floor near
	// 0.0031 RMS with speech around 0.016.
	assert.equal(normalizeLevel(OVERLAY_FLOOR_RMS), 0);
	assert.equal(normalizeLevel(OVERLAY_SPEECH_RMS), 1);
	assert.equal(normalizeLevel(0), 0, "a silent microphone draws nothing");
	assert.equal(normalizeLevel(0.001), 0, "below the floor stays empty rather than flickering");
	assert.equal(normalizeLevel(0.05), 1, "loud speech cannot overflow the bar");
	assert.equal(normalizeLevel(0.002), 0, "just under the floor");
	const middle = normalizeLevel((OVERLAY_FLOOR_RMS + OVERLAY_SPEECH_RMS) / 2);
	assert.ok(middle > 0.4 && middle < 0.6, `halfway between floor and speech: ${middle}`);
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.02]) assert.equal(normalizeLevel(bad), 0, String(bad));
});

test("smoothing rises fast and falls slowly, and never leaves the bar", () => {
	assert.equal(smoothLevel(0, 1), OVERLAY_ATTACK, "a first sound jumps most of the way");
	assert.equal(smoothLevel(1, 0), 1 - OVERLAY_RELEASE, "silence drains slowly instead of dropping out");
	assert.ok(OVERLAY_ATTACK > OVERLAY_RELEASE);
	assert.equal(smoothLevel(0.5, 0.5), 0.5, "a steady level stays put");
	assert.equal(smoothLevel(0, 1.5), OVERLAY_ATTACK, "an out-of-range target is clamped first");
	assert.equal(smoothLevel(2, 0), 1 - OVERLAY_RELEASE, "an out-of-range previous value is clamped first");
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		assert.equal(smoothLevel(bad, bad), 0, String(bad));
	}
});

test("a meter follows one recording: fast attack, slow release, reset per capture", () => {
	const meter = createLevelMeter();
	assert.equal(meter.push(OVERLAY_FLOOR_RMS), 0, "the floor is nothing");
	assert.equal(meter.push(OVERLAY_SPEECH_RMS), OVERLAY_ATTACK, "speech rises at once");
	const second = meter.push(OVERLAY_SPEECH_RMS);
	assert.ok(second > OVERLAY_ATTACK, `the bar keeps filling: ${second}`);
	assert.ok(second < 1);
	const falling = meter.push(OVERLAY_FLOOR_RMS);
	assert.ok(falling > 0 && falling < second, `it drains rather than dropping: ${falling}`);
	assert.ok(Math.abs(falling - second * (1 - OVERLAY_RELEASE)) < 1e-9);
	meter.reset();
	assert.equal(meter.push(OVERLAY_FLOOR_RMS), 0, "a new recording starts empty");
});

// The host protocol codec (T12): what the window is told, one small line per
// command, bounded and free of anything that could split a line.
import { encodeOverlayState, levelToPercent, OVERLAY_LABEL_MAX, sanitizeOverlayLabel } from "../lib/voice-overlay.ts";

test("a session label is display text: controls and runs of blanks go, and it is cut to 48 characters", () => {
	assert.equal(sanitizeOverlayLabel("  voice-control  "), "voice-control");
	assert.equal(sanitizeOverlayLabel("a\r\nb\tc\u0000d\u001b[31m"), "a b c d [31m");
	assert.equal(sanitizeOverlayLabel(undefined), "");
	assert.equal(sanitizeOverlayLabel(42 as unknown as string), "");
	const long = sanitizeOverlayLabel("x".repeat(500));
	assert.equal([...long].length, OVERLAY_LABEL_MAX);
	assert.equal([...sanitizeOverlayLabel("ñ".repeat(60))].length, OVERLAY_LABEL_MAX, "counted in characters, not bytes");
	assert.equal(sanitizeOverlayLabel("😀".repeat(60)), "😀".repeat(OVERLAY_LABEL_MAX), "never splits a surrogate pair");
});

test("a display level travels as a whole percent from 0 to 100", () => {
	assert.equal(levelToPercent(0), 0);
	assert.equal(levelToPercent(1), 100);
	assert.equal(levelToPercent(0.256), 26);
	for (const bad of [Number.NaN, -1, Number.NEGATIVE_INFINITY]) assert.equal(levelToPercent(bad), 0);
	assert.equal(levelToPercent(7), 100);
});

test("the state line carries the label as base64 so nothing can end or split it", () => {
	const line = encodeOverlayState({ state: "listening", language: "es", label: "Gentle\nVoice ñ" });
	const parts = line.split(" ");
	assert.deepEqual(parts.slice(0, 3), ["state", "listening", "es"]);
	assert.equal(Buffer.from(parts[3]!, "base64").toString("utf8"), "Gentle Voice ñ");
	assert.ok(!line.includes("\n"));
	assert.equal(encodeOverlayState({ state: "asleep", language: "en" }), "state asleep en -");
	assert.equal(encodeOverlayState({ state: "reading", language: "es", label: " \n " }), "state reading es -");
	assert.throws(() => encodeOverlayState({ state: "confirm" as never, language: "es" }));
	assert.throws(() => encodeOverlayState({ state: "asleep", language: "fr" as never }));
});

// The output meter (T12/T13): a reading's level is the RMS of the speech the
// player played, not of a noisy microphone.
test("the output meter draws played speech: silence is empty, typical speech fills the bars", () => {
	assert.equal(normalizeOutputLevel(0), 0, "digital silence between words");
	assert.equal(normalizeOutputLevel(OVERLAY_OUTPUT_FLOOR_RMS), 0);
	assert.equal(normalizeOutputLevel(OVERLAY_OUTPUT_SPEECH_RMS), 1);
	assert.equal(normalizeOutputLevel(1), 1, "cannot overflow");
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -0.2]) assert.equal(normalizeOutputLevel(bad), 0, String(bad));
	const quiet = normalizeOutputLevel(0.03);
	const loud = normalizeOutputLevel(0.3);
	assert.ok(quiet > 0 && quiet < 0.2, `quiet speech is a short bar: ${quiet}`);
	assert.equal(loud, 1);
	// The microphone preset would pin the same values at a full bar.
	assert.equal(normalizeLevel(0.03), 1);
	assert.ok(normalizeOutputLevel(0.1) > 0.3 && normalizeOutputLevel(0.1) < 0.5, "a normal level is in the middle of the bar");
});

test("the output meter jumps up and drains slowly like the microphone meter, and resets", () => {
	const meter = createOutputLevelMeter();
	const up = meter.push(0.25);
	assert.ok(up > 0.5 && up <= 1, `fast up: ${up}`);
	const down = meter.push(0);
	assert.ok(down < up && down > 0, `slow down: ${down}`);
	meter.reset();
	assert.equal(meter.push(0), 0);
});

test("the meter follows what the overlay shows: output for a reading, microphone otherwise", () => {
	assert.equal(createLevelMeterFor("reading").push(0.03), createOutputLevelMeter().push(0.03));
	for (const state of ["listening", "transcribing", "asleep"] as const) assert.equal(createLevelMeterFor(state).push(0.03), createLevelMeter().push(0.03), state);
	assert.notEqual(createLevelMeterFor("reading").push(0.03), createLevelMeterFor("listening").push(0.03));
	// The microphone preset is untouched.
	assert.equal(normalizeLevel(OVERLAY_SPEECH_RMS), 1);
	assert.equal(normalizeLevel(OVERLAY_FLOOR_RMS), 0);
});
