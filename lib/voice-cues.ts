import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import { NativePulsePlayer } from "./notification-audio-native.ts";
import { createWindowsCueBackend, type WindowsCueOptions } from "./voice-cues-windows.ts";
import { resolvePowerShell } from "./voice-speech.ts";

// Microphone cues (docs/voice.md, "Microphone cues"): two short rising notes
// when the microphone really starts recording and one longer falling note when
// it stops, so the speaker knows when to talk without looking. Under WSL they
// play on Windows, on the output the reply voice uses, through one warm
// PowerShell host (lib/voice-cues-windows.ts); when that host fails, and on
// plain Linux, they play through the native PulseAudio player the
// notifications use. The tones are generated here, written once into a private
// temporary directory for PulseAudio, and removed on dispose.

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

// GENTLE_PI_VOICE_CUE_VOLUME sets how loud the cues are, from 0 (silent) to 1
// (full scale); anything else keeps the default, so a typo never mutes them.
export const CUE_VOLUME_ENV = "GENTLE_PI_VOICE_CUE_VOLUME";
const DEFAULT_CUE_VOLUME = 0.6;

export function cueVolume(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[CUE_VOLUME_ENV]?.trim();
	if (!raw) return DEFAULT_CUE_VOLUME;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 && value <= 1 ? value : DEFAULT_CUE_VOLUME;
}

// One note sweeps from `from` to `to` Hz; a note of 0 Hz is a silent gap.
interface Note {
	readonly from: number;
	readonly to: number;
	readonly ms: number;
}

function notesWav(notes: readonly Note[], gain: number): Buffer {
	const pcm: number[] = [];
	for (const note of notes) {
		const samples = Math.round((RATE * note.ms) / 1000);
		let phase = 0;
		for (let i = 0; i < samples; i++) {
			if (note.from === 0) {
				pcm.push(0);
				continue;
			}
			const frequency = note.from + ((note.to - note.from) * i) / samples;
			phase += (2 * Math.PI * frequency) / RATE;
			const envelope = Math.min(1, i / 220, (samples - i) / 660);
			pcm.push(Math.round(Math.sin(phase) * gain * envelope * 32767));
		}
	}
	const data = Buffer.alloc(pcm.length * 2);
	pcm.forEach((sample, i) => data.writeInt16LE(sample, i * 2));
	// The same 16-bit mono header cueWav writes, sized for these samples.
	const header = Buffer.from(cueWav([0], 0, 0).subarray(0, 44));
	header.writeUInt32LE(36 + data.length, 4);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

// Open: two short rising notes with a gap (G5 then D6). Close: one longer note
// falling from E5 to A4. Different in shape, pitch and length, so neither can
// be taken for the other through a speaker across the room.
export function cueTones(gain: number = DEFAULT_CUE_VOLUME): { open: Buffer; close: Buffer } {
	return {
		open: notesWav([{ from: 784, to: 784, ms: 120 }, { from: 0, to: 0, ms: 40 }, { from: 1175, to: 1175, ms: 120 }], gain),
		close: notesWav([{ from: 659, to: 440, ms: 260 }], gain),
	};
}

interface CueBackend {
	probe(): Promise<{ available: boolean }>;
	play(path: string, name: CueName | "silence"): Promise<void>;
	warm?(): void;
	dispose?(): void;
}

// Windows first; PulseAudio when the Windows host fails.
function windowsThenPulse(windows: ReturnType<typeof createWindowsCueBackend>, pulse: CueBackend): CueBackend {
	let pulseReady: Promise<boolean> | undefined;
	const pulseAvailable = () => (pulseReady ??= pulse.probe().then((result) => result.available, () => false));
	return {
		probe: async () => ({ available: true }),
		play: async (path, name) => {
			if (name === "silence") return;
			try {
				await windows.play(name);
			} catch (error) {
				if (!(await pulseAvailable())) throw error;
				await pulse.play(path, name);
			}
		},
		warm: () => windows.warm(),
		dispose: () => {
			windows.dispose();
			pulse.dispose?.();
		},
	};
}

// The native player takes only the file; the cue name is for the Windows host.
function pulseBackend(native: NativePulsePlayer): CueBackend {
	return { probe: () => native.probe(), play: (path) => native.play(path), dispose: () => native.dispose() };
}

export interface CuePlayerOptions {
	platform?: string;
	env?: NodeJS.ProcessEnv;
	backend?: CueBackend;
	tempRoot?: string;
	// The kernel release, to tell WSL apart (os.release() when absent).
	kernelRelease?: string;
	// The Windows PowerShell to play through; resolved when the key is absent.
	powershell?: string;
	spawn?: WindowsCueOptions["spawn"];
	// The PulseAudio player (the native one when absent).
	pulse?: CueBackend;
}

export function createCuePlayer(options: CuePlayerOptions = {}): CuePlayer {
	const platform = options.platform ?? process.platform;
	if (!options.backend && platform !== "linux")
		return { play: async (name) => ({ name, outcome: "unavailable" as const, ms: 0 }), warm: () => {}, dispose: () => {} };
	const env = options.env ?? process.env;
	const tones = cueTones(cueVolume(env));
	const CUES: Record<CueName | "silence", Buffer> = { ...tones, silence: cueWav([0], 20, 0) };
	const backend: CueBackend = options.backend ?? (() => {
		const pulse = options.pulse ?? pulseBackend(new NativePulsePlayer({ platform, env }));
		const wsl = /microsoft/i.test(options.kernelRelease ?? release());
		const powershell = "powershell" in options ? options.powershell : resolvePowerShell(platform, env);
		if (!wsl || !powershell) return pulse;
		return windowsThenPulse(createWindowsCueBackend({ powershell, sounds: tones, spawn: options.spawn }), pulse);
	})();
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
			await backend.play(path, name);
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
			if (backend.warm) backend.warm();
			else void playCue("silence");
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
