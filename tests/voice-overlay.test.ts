import assert from "node:assert/strict";
import test from "node:test";
import { createLevelMeter, normalizeLevel, OVERLAY_ATTACK, OVERLAY_FLOOR_RMS, OVERLAY_RELEASE, OVERLAY_SPEECH_RMS, smoothLevel } from "../lib/voice-overlay.ts";

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
