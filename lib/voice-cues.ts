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

export interface CuePlayer {
	play(name: CueName): void;
	// Starts the player's worker ahead of the first cue.
	warm(): void;
	dispose(): void;
}

const RATE = 22_050;

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
	if (!options.backend && platform !== "linux") return { play: () => {}, warm: () => {}, dispose: () => {} };
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
	const playFile = (name: keyof typeof CUES) => {
		if (disposed) return;
		void ready().then((ok) => {
			const path = ok && !disposed ? pathOf(name) : undefined;
			if (path) return backend.play(path);
			return undefined;
		}).catch(() => {
			/* a cue is advisory */
		});
	};
	return {
		play: (name) => playFile(name),
		warm: () => playFile("silence"),
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
