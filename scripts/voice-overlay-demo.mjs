#!/usr/bin/env node
// Shows the Gentle Voice overlay window on the desktop, state by state, with
// synthetic levels: no microphone is opened and no audio is played. It is for
// looking at the real window while working on it (docs/voice.md, "Voice
// listener"). The window is click-through and closes itself when the demo ends.
//
//   node --experimental-strip-types scripts/voice-overlay-demo.mjs
import { createOverlayForEnvironment } from "../lib/voice-overlay-windows.ts";

const FRAME_MS = 50;
// The demo always ends, even if the window host hangs.
const HARD_LIMIT_MS = 70_000;

// One row per thing to look at. `level` says what the port would receive in that
// state: a display value 0..1 while listening, the raw loudness of the played
// speech while reading, nothing otherwise.
const STEPS = [
	{ title: "listening, microphone recording", state: "listening", language: "es", label: "Gentle Voice", seconds: 8, level: "display" },
	{ title: "transcribing", state: "transcribing", language: "es", label: "Gentle Voice", seconds: 5 },
	{ title: "reading, bars follow the speech", state: "reading", language: "es", label: "voice-control", seconds: 8, level: "output" },
	{ title: "asleep", state: "asleep", language: "es", seconds: 5 },
	{ title: "listening in English", state: "listening", language: "en", label: "Gentle Voice", seconds: 5, level: "display" },
	{ title: "awake, microphone closed", state: "listening", language: "es", label: "Gentle Voice", seconds: 5 },
];

// A speech-like envelope, 0..1: syllables inside phrases, with pauses.
function envelope(seconds) {
	const syllable = Math.abs(Math.sin(seconds * 9.5));
	const speaking = Math.sin(seconds * 1.3) > -0.35 ? 1 : 0;
	const drift = 0.6 + 0.4 * Math.sin(seconds * 0.7 + 1);
	return Math.max(0, Math.min(1, speaking * drift * (0.25 + 0.75 * syllable)));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = { ...process.env };
delete env.GENTLE_PI_VOICE_OVERLAY;
const overlay = createOverlayForEnvironment({ env });
if (!overlay) {
	console.error("voice-overlay-demo: no overlay here (needs Windows or WSL with PowerShell)");
	process.exit(1);
}

let closed = false;
async function close(code) {
	if (closed) return;
	closed = true;
	try {
		await overlay.dispose();
	} catch {
		// The window host is already gone.
	}
	process.exit(code);
}

setTimeout(() => void close(2), HARD_LIMIT_MS).unref();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => void close(130));

try {
	for (const step of STEPS) {
		console.log(`voice-overlay-demo: ${step.title} (${step.seconds} s)`);
		await overlay.show({ state: step.state, language: step.language, label: step.label });
		const frames = Math.round((step.seconds * 1000) / FRAME_MS);
		for (let frame = 0; frame < frames && !closed; frame++) {
			if (step.level) {
				const value = envelope((frame * FRAME_MS) / 1000);
				await overlay.level(step.level === "output" ? 0.02 + value * 0.23 : value);
			}
			await sleep(FRAME_MS);
		}
	}
	await close(0);
} catch (error) {
	console.error(`voice-overlay-demo: the window failed (${error instanceof Error ? error.message : "unknown error"})`);
	await close(1);
}
