import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { CUE_VOLUME_ENV, createCuePlayer, cueTones, cueVolume } from "../lib/voice-cues.ts";
import { createWindowsCueBackend } from "../lib/voice-cues-windows.ts";

// Microphone cues on Windows (docs/voice.md, "Microphone cues"): one warm
// PowerShell process holds the tones and plays them on the Windows output the
// reply voice uses; PulseAudio is the fallback. No test plays real audio.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const roots: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-cues-win-"));
	roots.push(dir);
	return dir;
};
after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

interface FakeProc {
	argv: readonly string[];
	written: string[];
	killed: boolean;
	ended: boolean;
	stdout: EventEmitter;
	exit(code: number): void;
}

// A fake PowerShell cue host. `answer` decides what the script prints for each
// stdin line; by default every command succeeds.
function fakeSpawn(answer: (line: string, proc: FakeProc) => string | undefined = (line) => `ok ${line.split(" ").slice(0, 2).join(" ")}`) {
	const procs: FakeProc[] = [];
	const spawn = (command: string, args: readonly string[]) => {
		const events = new EventEmitter();
		const stdout = new EventEmitter();
		const proc: FakeProc = {
			argv: [command, ...args],
			written: [],
			killed: false,
			ended: false,
			stdout,
			exit: (code) => events.emit("exit", code),
		};
		procs.push(proc);
		return {
			stdin: {
				write: (chunk: string) => {
					for (const line of chunk.split("\n").filter(Boolean)) {
						proc.written.push(line);
						const reply = answer(line, proc);
						if (reply !== undefined) setImmediate(() => stdout.emit("data", `${reply}\n`));
					}
					return true;
				},
				end: () => {
					proc.ended = true;
				},
				on: () => {},
			},
			stdout,
			stderr: new EventEmitter(),
			kill: () => {
				proc.killed = true;
				setImmediate(() => events.emit("exit", null));
				return true;
			},
			once: (event: string, listener: (...args: unknown[]) => void) => events.once(event, listener),
		};
	};
	return { spawn, procs };
}

const SOUNDS = { open: Buffer.from("open-wav"), close: Buffer.from("close-wav") };

test("the Windows cue host loads each tone once over stdin and plays a cue on a one-word line", async () => {
	const { spawn, procs } = fakeSpawn();
	const backend = createWindowsCueBackend({ powershell: "/mnt/c/ps.exe", sounds: SOUNDS, spawn });
	assert.deepEqual(await backend.probe(), { available: true });
	await backend.play("open");
	await backend.play("close");
	await backend.play("open");
	assert.equal(procs.length, 1, "one warm process serves every cue");
	const [proc] = procs;
	assert.equal(proc!.argv[0], "/mnt/c/ps.exe");
	assert.ok(proc!.argv.includes("-EncodedCommand"));
	const argv = proc!.argv.join(" ");
	for (const bytes of Object.values(SOUNDS)) assert.ok(!argv.includes(bytes.toString("base64")), "tones never travel on the command line");
	assert.deepEqual(proc!.written, [
		`load open ${SOUNDS.open.toString("base64")}`,
		`load close ${SOUNDS.close.toString("base64")}`,
		"play open",
		"play close",
		"play open",
	]);
	backend.dispose();
	assert.equal(proc!.ended, true, "dispose closes the host's stdin");
});

test("a cue the host reports as failed, or a host that dies, rejects; the next cue starts a new host", async () => {
	let failNext = true;
	const { spawn, procs } = fakeSpawn((line) => {
		if (line.startsWith("play") && failNext) {
			failNext = false;
			return "error play";
		}
		return `ok ${line.split(" ").slice(0, 2).join(" ")}`;
	});
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn });
	await assert.rejects(backend.play("open"));
	await backend.play("open");
	procs[0]!.exit(1);
	await new Promise((resolve) => setImmediate(resolve));
	await backend.play("close");
	assert.equal(procs.length, 2, "a dead host is replaced");
	assert.deepEqual(procs[1]!.written.slice(-1), ["play close"]);
	backend.dispose();
});

test("a cue the host never answers times out and the host is stopped", async () => {
	const { spawn, procs } = fakeSpawn((line) => (line.startsWith("play") ? undefined : `ok ${line.split(" ").slice(0, 2).join(" ")}`));
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn, timeoutMs: 30 });
	await assert.rejects(backend.play("open"));
	assert.equal(procs[0]!.killed, true);
	backend.dispose();
});

test("an idle host retires on its own", async () => {
	const { spawn, procs } = fakeSpawn();
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn, idleMs: 20 });
	await backend.play("open");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(procs[0]!.ended, true);
	backend.dispose();
});

test("an unknown cue name is refused before it reaches PowerShell", async () => {
	const { spawn, procs } = fakeSpawn();
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn });
	await assert.rejects(backend.play("open; Remove-Item"));
	assert.equal(procs.length, 0);
	backend.dispose();
});

const WSL = { platform: "linux", kernelRelease: "6.18.54.1-microsoft-standard-WSL2", powershell: "/mnt/c/ps.exe" };

function pulseFake(available = true) {
	const played: string[] = [];
	return { played, backend: { probe: async () => ({ available }), play: async (path: string) => { played.push(path.split("/").at(-1)!); } } };
}

test("under WSL the cues play through Windows, not PulseAudio", async () => {
	const { spawn, procs } = fakeSpawn();
	const pulse = pulseFake();
	const player = createCuePlayer({ ...WSL, spawn, pulse: pulse.backend, tempRoot: scratch() });
	const result = await player.play("open");
	assert.equal(result.outcome, "done");
	assert.deepEqual(procs[0]!.written.filter((line) => line.startsWith("play")), ["play open"]);
	assert.deepEqual(pulse.played, []);
	player.dispose();
});

test("when the Windows host fails, the cue falls back to PulseAudio", async () => {
	const { spawn } = fakeSpawn((line) => (line.startsWith("play") ? "error play" : `ok ${line.split(" ").slice(0, 2).join(" ")}`));
	const pulse = pulseFake();
	const player = createCuePlayer({ ...WSL, spawn, pulse: pulse.backend, tempRoot: scratch() });
	const result = await player.play("close");
	assert.equal(result.outcome, "done");
	assert.deepEqual(pulse.played, ["close.wav"]);
	player.dispose();
});

test("outside WSL, or without PowerShell, Linux keeps the PulseAudio cues", async () => {
	for (const options of [{ ...WSL, kernelRelease: "6.8.0-generic" }, { ...WSL, powershell: undefined }]) {
		const { spawn, procs } = fakeSpawn();
		const pulse = pulseFake();
		const player = createCuePlayer({ ...options, spawn, pulse: pulse.backend, tempRoot: scratch() });
		assert.equal((await player.play("open")).outcome, "done");
		assert.deepEqual(pulse.played, ["open.wav"]);
		assert.equal(procs.length, 0);
		player.dispose();
	}
});

test("GENTLE_PI_VOICE_CUE_VOLUME sets the cue loudness from 0 to 1; anything else keeps the default", () => {
	assert.equal(CUE_VOLUME_ENV, "GENTLE_PI_VOICE_CUE_VOLUME");
	assert.equal(cueVolume({}), 0.6);
	assert.equal(cueVolume({ GENTLE_PI_VOICE_CUE_VOLUME: "0.3" }), 0.3);
	assert.equal(cueVolume({ GENTLE_PI_VOICE_CUE_VOLUME: "0" }), 0);
	assert.equal(cueVolume({ GENTLE_PI_VOICE_CUE_VOLUME: "1" }), 1);
	for (const bad of ["2", "-0.1", "loud", ""]) assert.equal(cueVolume({ GENTLE_PI_VOICE_CUE_VOLUME: bad }), 0.6, bad);
});

const peak = (wav: Buffer) => {
	let max = 0;
	for (let at = 44; at + 1 < wav.length; at += 2) max = Math.max(max, Math.abs(wav.readInt16LE(at)));
	return max;
};
const ms = (wav: Buffer) => Math.round(((wav.length - 44) / 2 / 22_050) * 1000);

test("open is two short rising notes with a gap; close is one longer falling note; both clearly louder than before", () => {
	const { open, close } = cueTones(0.6);
	assert.notDeepEqual(open, close);
	assert.ok(ms(open) >= 260 && ms(open) <= 340, `open lasts ${ms(open)} ms`);
	assert.ok(ms(close) >= 230 && ms(close) <= 300, `close lasts ${ms(close)} ms`);
	const louder = 0.25 * 32767;
	assert.ok(peak(open) > louder * 2 && peak(open) <= 0.6 * 32767 + 1, `open peaks at ${peak(open)}`);
	assert.ok(peak(close) > louder * 2 && peak(close) <= 0.6 * 32767 + 1, `close peaks at ${peak(close)}`);
	// The gap between the two open notes is silent.
	const middle = 44 + Math.round(22_050 * 0.14) * 2;
	assert.equal(open.readInt16LE(middle), 0, "the open cue has a silent gap between its notes");
	assert.equal(peak(cueTones(0.3).open) <= 0.3 * 32767 + 1, true, "the volume scales the tones");
});

test("a warm-up queued before dispose never starts a host", async () => {
	const { spawn, procs } = fakeSpawn();
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn, timeoutMs: 50 });
	const slow = backend.play("open");
	backend.warm();
	backend.dispose();
	await slow.catch(() => {});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.ok(procs.length <= 1, "only the host of the cue already in flight may exist");
	assert.ok(procs.every((proc) => proc.ended || proc.killed), "no host outlives dispose");
});

test("a retired host that exits late never fails the cue its replacement is playing", async () => {
	let holdPlay = false;
	const { spawn, procs } = fakeSpawn((line) => (holdPlay && line.startsWith("play") ? undefined : `ok ${line.split(" ").slice(0, 2).join(" ")}`));
	const backend = createWindowsCueBackend({ powershell: "ps.exe", sounds: SOUNDS, spawn, timeoutMs: 40 });
	holdPlay = true;
	await assert.rejects(backend.play("open"), "the first host times out and is stopped");
	holdPlay = false;
	const second = backend.play("close");
	await new Promise((resolve) => setImmediate(resolve));
	procs[0]!.exit(1);
	await second;
	assert.equal(procs.length, 2);
	backend.dispose();
});
