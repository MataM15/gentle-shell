import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativePulsePlayer } from "./notification-audio-native.ts";

// Microphone cues (docs/voice.md, "Microphone cues"): a short rising tone when
// the microphone really starts recording and a falling one when it stops, so
// the speaker knows when to talk. They play through the native PulseAudio
// player the notifications use, which answers in about 20 ms once its worker is
// awake; the Windows players start PowerShell and arrive a second late, so no
// cue plays where PulseAudio is not available. The tones are generated here,
// written once into a private temporary directory, and removed on dispose.

export type CueName = "open" | "close";

// What became of one cue. "unavailable" means no PulseAudio player is reachable
// at all, "failed" that the player was asked and did not confirm the play, and
// "done" that it reported the tone drained to the sink. `ms` is how long the
// player took, including the single retry when there was one.
export type CueOutcome = "done" | "failed" | "unavailable";
export interface CueResult {
	readonly name: CueName;
	readonly outcome: CueOutcome;
	readonly ms: number;
}

export interface CuePlayer {
	play(name: CueName): Promise<CueResult>;
	// Starts the player's worker ahead of the first cue.
	warm(): void;
	dispose(): void;
}

const RATE = 22_050;

// How long a cue the player did not confirm waits before its one retry.
const RETRY_PAUSE_MS = 150;

// A 160 ms two-step tone with soft edges, at a quarter of full scale.
export function cueWav(steps: readonly number[], ms = 160, gain = 0.25): Buffer {
	const samples = Math.round((RATE * ms) / 1000);
	const pcm = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		const frequency = steps[Math.min(steps.length - 1, Math.floor((i / samples) * steps.length))] ?? 0;
		const envelope = Math.min(1, i / 200, (samples - i) / 400);
		pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / RATE) * gain * envelope * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(RATE, 24);
	header.writeUInt32LE(RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

const CUES: Record<CueName | "silence", Buffer> = {
	open: cueWav([660, 990]),
	close: cueWav([990, 660]),
	silence: cueWav([0], 20, 0),
};

interface CueBackend {
	probe(): Promise<{ available: boolean }>;
	play(path: string): Promise<void>;
	dispose?(): void;
}

export function createCuePlayer(options: { platform?: string; env?: NodeJS.ProcessEnv; backend?: CueBackend; tempRoot?: string } = {}): CuePlayer {
	const platform = options.platform ?? process.platform;
	if (!options.backend && platform !== "linux")
		return { play: async (name) => ({ name, outcome: "unavailable" as const, ms: 0 }), warm: () => {}, dispose: () => {} };
	const backend: CueBackend = options.backend ?? new NativePulsePlayer({ platform, env: options.env ?? process.env });
	let dir: string | undefined;
	let available: Promise<boolean> | undefined;
	let disposed = false;
	const pathOf = (name: keyof typeof CUES): string | undefined => {
		try {
			if (!dir) {
				dir = mkdtempSync(join(options.tempRoot ?? tmpdir(), "gentle-voice-cues-"));
				for (const [cue, bytes] of Object.entries(CUES)) writeFileSync(join(dir, `${cue}.wav`), bytes, { mode: 0o600 });
			}
			return join(dir, `${name}.wav`);
		} catch {
			return undefined;
		}
	};
	const ready = () => (available ??= backend.probe().then((result) => result.available, () => false));
	// One attempt, measured only when the player was really asked to play.
	const attempt = async (name: keyof typeof CUES): Promise<{ outcome: CueOutcome; ms: number }> => {
		if (!(await ready())) return { outcome: "unavailable", ms: 0 };
		const path = disposed ? undefined : pathOf(name);
		if (!path) return { outcome: "failed", ms: 0 };
		const started = Date.now();
		try {
			await backend.play(path);
			return { outcome: "done", ms: Date.now() - started };
		} catch {
			return { outcome: "failed", ms: Date.now() - started };
		}
	};
	// A cue the player did not confirm is tried once more, after a short pause:
	// the Pulse worker retires when it idles out, so the first cue after a long
	// reading can reach a worker that is already on its way out. A cue that
	// played is never played twice, and one with no player at all is not retried.
	const playCue = async (name: keyof typeof CUES): Promise<CueOutcome> => {
		const first = await attempt(name);
		if (first.outcome !== "failed" || disposed) return first.outcome;
		await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
		return (await attempt(name)).outcome;
	};
	const play = async (name: CueName): Promise<CueResult> => {
		const started = Date.now();
		const outcome = await playCue(name);
		return { name, outcome, ms: outcome === "unavailable" ? 0 : Date.now() - started };
	};
	return {
		play,
		// A silence cue now, so a real one does not pay the worker's start-up.
		warm: () => {
			void playCue("silence");
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			try {
				backend.dispose?.();
			} catch {
				/* already gone */
			}
			if (dir) rmSync(dir, { recursive: true, force: true });
		},
	};
}
