import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createOutputLevelMeter, levelToPercent, type VoiceOverlay } from "../lib/voice-overlay.ts";
import { createOverlayForEnvironment, createWindowsOverlay, type WindowsOverlayOptions } from "../lib/voice-overlay-windows.ts";

// The overlay window host (T12, S5, S10): one warm PowerShell process, a line
// protocol on stdin, state changes acknowledged and levels fire and forget. No
// test starts PowerShell, opens a window or touches a microphone.

interface FakeProc {
	argv: readonly string[];
	written: string[];
	killed: boolean;
	ended: boolean;
	stdout: EventEmitter;
	exit(code: number | null): void;
}

// A fake host. By default a `state` line is answered `ok state`; the script line
// and the fire-and-forget commands are never answered.
function fakeSpawn(answer: (line: string, proc: FakeProc) => string | undefined = (line) => (line.startsWith("state ") ? "ok state" : undefined)) {
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

const SCRIPT = "# the window script\nWrite-Output 'x'\n";
// The port allows a plain return; the tests always see a promise.
const promised = (overlay: VoiceOverlay) => ({
	show: (snapshot: Parameters<VoiceOverlay["show"]>[0]) => Promise.resolve(overlay.show(snapshot)),
	level: (value: number) => Promise.resolve(overlay.level(value)),
	dispose: () => overlay.dispose(),
});
const make = (spawn: ReturnType<typeof fakeSpawn>["spawn"], extra: Partial<WindowsOverlayOptions> = {}) =>
	promised(createWindowsOverlay({ powershell: "/mnt/c/ps.exe", readScript: () => SCRIPT, spawn, ...extra }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const levels = (proc: FakeProc) => proc.written.filter((line) => line.startsWith("level "));
const recs = (proc: FakeProc) => proc.written.filter((line) => line.startsWith("rec "));
const stateLine = (state: string, language: string, label?: string) =>
	`state ${state} ${language} ${label === undefined ? "-" : Buffer.from(label).toString("base64")}`;

test("the host starts once with an encoded bootstrap, receives the script on stdin and acknowledges a state", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn);
	assert.equal(procs.length, 0, "constructing starts nothing");
	await overlay.show({ state: "asleep", language: "es", recording: false });
	await overlay.show({ state: "reading", language: "en", label: "voice-control", recording: false });
	assert.equal(procs.length, 1, "one warm process serves every state");
	const [proc] = procs;
	assert.equal(proc!.argv[0], "/mnt/c/ps.exe");
	for (const flag of ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]) assert.ok(proc!.argv.includes(flag), flag);
	const argv = proc!.argv.join(" ");
	assert.ok(!argv.includes(Buffer.from(SCRIPT).toString("base64")), "the script never travels on the command line");
	assert.equal(Buffer.from(proc!.written[0]!, "base64").toString("utf8"), SCRIPT, "the script is the first stdin line");
	assert.deepEqual(proc!.written.slice(1), [stateLine("asleep", "es"), stateLine("reading", "en", "voice-control")]);
	overlay.dispose();
});

test("a label is sanitized and bounded before it reaches the host", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn);
	await overlay.show({ state: "listening", language: "es", label: `${"\u0007x\ny".repeat(100)}`, recording: false });
	const state = procs[0]!.written.find((line) => line.startsWith("state "))!;
	assert.ok(state.length < 200, `a small line: ${state.length}`);
	const decoded = Buffer.from(state.split(" ")[3]!, "base64").toString("utf8");
	assert.ok([...decoded].length <= 48);
	assert.ok(!/[\u0000-\u001f]/.test(decoded));
	overlay.dispose();
});

test("a snapshot that cannot be told is refused and starts nothing", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn);
	await assert.rejects(overlay.show({ state: "confirm" as never, language: "es", recording: false }));
	assert.equal(procs.length, 0);
	overlay.dispose();
});

test("levels are never sent before a window exists, and only while a wave is drawn", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { levelIntervalMs: 0 });
	await overlay.level(0.5);
	assert.equal(procs.length, 0, "a level starts no host");
	await overlay.show({ state: "transcribing", language: "es", label: "a", recording: false });
	await overlay.level(0.5);
	assert.deepEqual(procs[0]!.written.filter((line) => line.startsWith("level ") || line.startsWith("rec ")), [], "no wave while transcribing");
	await overlay.show({ state: "reading", language: "es", label: "a", recording: false });
	await overlay.level(0.25);
	assert.deepEqual(procs[0]!.written.slice(-1), [`level ${levelToPercent(createOutputLevelMeter().push(0.25))}`], "a reading's raw output RMS goes through the output meter");
	await overlay.level(0.001);
	assert.ok(Number(procs[0]!.written.at(-1)!.split(" ")[1]) < 60, "and drains slowly when the speech stops");
	assert.ok(!procs[0]!.written.includes("rec 1"), "a reading's level says nothing about the microphone");
	await overlay.show({ state: "asleep", language: "es", recording: false });
	const count = procs[0]!.written.length;
	await overlay.level(0.5);
	assert.equal(procs[0]!.written.length, count, "no wave while asleep");
	await overlay.show({ state: "listening", language: "es", label: "a", recording: false });
	await overlay.level(0.5);
	assert.deepEqual(procs[0]!.written.slice(-1), ["level 50"], "a level draws the wave and claims nothing");
	overlay.dispose();
});

test("'rec 1' and 'rec 0' come from the snapshot's recording flag, never from levels (S10)", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { levelIntervalMs: 0 });
	await overlay.show({ state: "listening", language: "es", label: "a", recording: false });
	assert.deepEqual(recs(procs[0]!), [], "listening without a recording claims nothing");
	await overlay.show({ state: "listening", language: "es", label: "a", recording: true });
	assert.deepEqual(procs[0]!.written.slice(-2), [stateLine("listening", "es", "a"), "rec 1"], "the flag opens the microphone form after the state is acknowledged");
	for (let i = 0; i < 20; i++) await overlay.level(0.2);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(recs(procs[0]!).filter((line) => line === "rec 0").length, 0, "a second without a level never withdraws the recording");
	assert.equal(recs(procs[0]!).filter((line) => line === "rec 1").length, 1, "and the levels do not claim it twice");
	await overlay.show({ state: "transcribing", language: "es", label: "a", recording: false });
	assert.equal(procs[0]!.written.at(-1), "rec 0", "the recording that ended is written from the flag, not measured");
	overlay.dispose();
});

test("a level arriving without the flag never turns recording on (S10)", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { levelIntervalMs: 0 });
	await overlay.show({ state: "listening", language: "es", label: "a", recording: false });
	for (let i = 1; i <= 50; i++) await overlay.level(i / 50);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.ok(levels(procs[0]!).length >= 1, "the wave still draws");
	assert.deepEqual(recs(procs[0]!), [], "a loud microphone on a closed capture is not a recording");
	overlay.dispose();
});

test("levels are coalesced and capped: only the newest value is ever kept", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { levelIntervalMs: 30 });
	await overlay.show({ state: "listening", language: "es", label: "a", recording: true });
	for (let i = 1; i <= 200; i++) overlay.level(i / 200);
	await new Promise((resolve) => setTimeout(resolve, 80));
	const sent = levels(procs[0]!);
	assert.ok(sent.length >= 2 && sent.length <= 4, `a burst of 200 became ${sent.length} writes`);
	assert.equal(sent.at(-1), "level 100", "the newest value wins");
	for (const line of sent) assert.match(line, /^level (\d|[1-9]\d|100)$/);
	overlay.dispose();
});

test("a host that exits is reported through the port and never started again", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn);
	await overlay.show({ state: "asleep", language: "es", recording: false });
	procs[0]!.exit(1);
	await tick();
	await assert.rejects(overlay.show({ state: "listening", language: "es", recording: false }), /exited/);
	await assert.rejects(overlay.show({ state: "reading", language: "es", recording: false }));
	assert.equal(procs.length, 1, "no respawn loop");
	overlay.dispose();
});

test("a host that dies while a state is pending rejects it without throwing", async () => {
	const { spawn, procs } = fakeSpawn(() => undefined);
	const overlay = make(spawn);
	const pending = overlay.show({ state: "listening", language: "es", recording: false });
	await tick();
	procs[0]!.exit(1);
	await assert.rejects(pending, /exited/);
	assert.doesNotThrow(() => overlay.level(0.5).catch(() => {}), "a level after the failure reports through the port, never throws");
	overlay.dispose();
});

test("a host that refuses a state rejects it", async () => {
	const { spawn, procs } = fakeSpawn((line) => (line.startsWith("state ") ? "error state" : undefined));
	const overlay = make(spawn);
	await assert.rejects(overlay.show({ state: "listening", language: "es", recording: false }), /refused/);
	assert.equal(procs[0]!.killed, true, "a failed overlay leaves no window up saying a stale state");
	overlay.dispose();
});

test("a host that never answers times out, is stopped, and is not replaced", async () => {
	const { spawn, procs } = fakeSpawn(() => undefined);
	const overlay = make(spawn, { timeoutMs: 30 });
	await assert.rejects(overlay.show({ state: "listening", language: "es", recording: false }), /timed out/);
	assert.equal(procs[0]!.killed, true);
	await tick();
	await assert.rejects(overlay.show({ state: "asleep", language: "es", recording: false }));
	assert.equal(procs.length, 1, "no respawn after a timeout");
	overlay.dispose();
});

test("a script that cannot be read rejects the first state and starts nothing", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, {
		readScript: () => {
			throw new Error("ENOENT");
		},
	});
	await assert.rejects(overlay.show({ state: "asleep", language: "es", recording: false }));
	assert.equal(procs.length, 0);
	await assert.rejects(overlay.show({ state: "asleep", language: "es", recording: false }), "and it is not retried in a loop");
	overlay.dispose();
});

test("dispose closes the host's stdin after a quit, and nothing is written afterwards", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { levelIntervalMs: 0 });
	await overlay.show({ state: "listening", language: "es", label: "a", recording: true });
	overlay.dispose();
	assert.equal(procs[0]!.ended, true);
	assert.equal(procs[0]!.written.at(-1), "quit");
	const count = procs[0]!.written.length;
	overlay.level(0.5);
	await assert.rejects(overlay.show({ state: "asleep", language: "es", recording: false }));
	assert.equal(procs[0]!.written.length, count);
	assert.doesNotThrow(() => overlay.dispose(), "dispose twice is harmless");
});

test("dispose releases a state that is still waiting for its answer", async () => {
	const { spawn } = fakeSpawn(() => undefined);
	const overlay = make(spawn, { timeoutMs: 5_000 });
	const pending = overlay.show({ state: "listening", language: "es", recording: false });
	await tick();
	overlay.dispose();
	await assert.rejects(pending, /disposed/);
});

test("an idle host retires on its own and a later state starts a new one", async () => {
	const { spawn, procs } = fakeSpawn();
	const overlay = make(spawn, { idleMs: 20 });
	await overlay.show({ state: "asleep", language: "es", recording: false });
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(procs[0]!.ended, true);
	await tick();
	await overlay.show({ state: "asleep", language: "es", recording: false });
	assert.equal(procs.length, 2, "retiring is not a failure");
	overlay.dispose();
});

test("no overlay is built when it is turned off, off Windows and WSL, or without PowerShell", () => {
	const { spawn, procs } = fakeSpawn();
	const wsl = { platform: "linux", kernelRelease: "5.15.0-microsoft-standard-WSL2", powershell: "/mnt/c/ps.exe", spawn, readScript: () => SCRIPT };
	assert.ok(createOverlayForEnvironment({ ...wsl, env: {} }), "WSL with PowerShell builds one");
	for (const value of ["off", "OFF", " off "]) assert.equal(createOverlayForEnvironment({ ...wsl, env: { GENTLE_PI_VOICE_OVERLAY: value } }), undefined, value);
	assert.ok(createOverlayForEnvironment({ ...wsl, env: { GENTLE_PI_VOICE_OVERLAY: "on" } }), "anything but off leaves it on");
	assert.equal(createOverlayForEnvironment({ ...wsl, env: {}, powershell: null }), undefined, "no PowerShell, no window");
	assert.equal(createOverlayForEnvironment({ ...wsl, env: {}, kernelRelease: "6.1.0-generic" }), undefined, "plain Linux has no Windows desktop");
	assert.equal(createOverlayForEnvironment({ ...wsl, env: {}, platform: "darwin" }), undefined);
	assert.ok(createOverlayForEnvironment({ ...wsl, env: {}, platform: "win32", powershell: "powershell.exe" }));
	assert.equal(procs.length, 0, "building starts no host");
});
