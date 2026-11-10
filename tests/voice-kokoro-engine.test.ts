import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createKokoroSpeechEngine, KOKORO_PLAYER_SCRIPT, kokoroChunks, type KokoroLaunch } from "../lib/voice-kokoro-engine.ts";
import { PLAYBACK_MARKER, type VoiceSpeechChunk } from "../lib/voice-speech-events.ts";
import { encodeWav } from "../lib/voice-robot.ts";
import { createFallbackSpeechEngine, type SpeechEngine } from "../lib/voice-speech.ts";

// The natural-voice engine (S6): text split for a quick first sentence, one
// synthesis worker feeding one PowerShell player, cancel and failure paths,
// and the fallback to the Windows voice. Fake processes only.

test("kokoroChunks reads the first sentence alone, then groups the rest within a bound", () => {
	assert.deepEqual(kokoroChunks("Hola. Ya está listo. Probé todo. ¿Seguimos?"), ["Hola.", "Ya está listo. Probé todo. ¿Seguimos?"]);
	const long = Array.from({ length: 12 }, (_value, index) => `Oración número ${index} con algo de texto.`).join(" ");
	const chunks = kokoroChunks(long);
	assert.equal(chunks[0], "Oración número 0 con algo de texto.");
	assert.ok(chunks.slice(1).every((chunk) => chunk.length <= 160), "later chunks stay short, so each one is ready before the previous one ends");
	assert.equal(chunks.join(" "), long, "nothing is lost or reordered");
	assert.deepEqual(kokoroChunks("   "), []);
	const single = "x".repeat(2500);
	assert.ok(kokoroChunks(single).every((chunk) => chunk.length <= 2000), "a sentence longer than the worker limit is split");
});

class FakeProc extends EventEmitter {
	readonly written: string[] = [];
	ended = false;
	readonly signals: NodeJS.Signals[] = [];
	stdin = { write: (chunk: string) => { this.written.push(chunk); return true; }, end: () => { this.ended = true; }, on: () => {} };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(signal: NodeJS.Signals) {
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
	say(message: Record<string, unknown>) {
		this.stdout.emit("data", `${JSON.stringify({ schema: "gentle.voice-tts/v1", ...message })}\n`);
	}
}

const LAUNCH: KokoroLaunch = {
	runtimeRoot: "/voice/runtime/r",
	core: { root: "/voice/models/core", files: [{ name: "model.onnx", size: 5 }, { name: "voices.bin", size: 6 }, { name: "tokens.txt", size: 6 }] },
	espeak: [
		{ root: "/voice/models/espeak", folder: "", files: [{ name: "phontab", size: 2 }] },
		{ root: "/voice/models/roa", folder: "lang/roa", files: [{ name: "es", size: 7 }] },
		{ root: "/voice/models/gmw", folder: "lang/gmw", files: [{ name: "en", size: 7 }] },
	],
};

function harness(launch: KokoroLaunch | null = LAUNCH, timeoutMs?: (text: string) => number, voices?: Parameters<typeof createKokoroSpeechEngine>[0]["voices"]) {
	const procs: Array<{ command: string; args: readonly string[]; options: Record<string, unknown>; proc: FakeProc }> = [];
	const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
		const proc = new FakeProc();
		procs.push({ command, args, options, proc });
		return proc;
	};
	const engine = createKokoroSpeechEngine({
		launch: async () => launch ?? undefined,
		powershell: "/mnt/c/Windows/powershell.exe",
		spawn,
		nodePath: "/usr/bin/node",
		workerPath: "/fixed/voice-tts-worker.cjs",
		env: { HOME: "/home/someone", SECRET_TOKEN: "abc", NODE_OPTIONS: "--require /evil.js" },
		timeoutMs,
		voices,
	});
	const worker = () => procs.find((entry) => entry.command === "/usr/bin/node")!;
	const player = () => procs.find((entry) => entry.command === "/mnt/c/Windows/powershell.exe")!;
	const until = async (check: () => boolean) => {
		for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(check(), "condition not reached");
	};
	return { engine, procs, worker, player, until };
}

test("a reading starts the player and the worker, streams each WAV to the player, and ends when playback ends", async () => {
	const h = harness();
	const signal = new AbortController().signal;
	const spoken = h.engine.speak("Hola. Esto se escucha natural.", { language: "es", rate: 2, signal });
	await h.until(() => h.procs.length === 2);
	const { args: playerArgs, options: playerOptions } = h.player();
	assert.deepEqual(playerArgs.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
	assert.equal(Buffer.from(playerArgs.at(-1)!, "base64").toString("utf16le"), KOKORO_PLAYER_SCRIPT);
	assert.equal(playerOptions.shell, false);
	const { args, options, proc } = h.worker();
	assert.deepEqual(args, ["/fixed/voice-tts-worker.cjs"]);
	assert.equal(options.cwd, LAUNCH.runtimeRoot);
	assert.equal(options.shell, false);
	assert.deepEqual(Object.keys(options.env as object).sort(), ["GENTLE_PI_AGENTS_CHILD", "HOME", "NODE_NO_WARNINGS"], "the worker gets a scrubbed environment");
	const request = JSON.parse(proc.written.join("").trim());
	assert.deepEqual(
		{ ...request, runtime: undefined, core: undefined, espeak: undefined },
		{ schema: "gentle.voice-tts/v1", type: "start", lang: "es", sid: 28, speed: 1.18, numThreads: 4, chunks: ["Hola.", "Esto se escucha natural."], runtime: undefined, core: undefined, espeak: undefined },
	);
	assert.deepEqual(request.runtime, { root: LAUNCH.runtimeRoot });
	assert.deepEqual(request.core, LAUNCH.core);
	assert.deepEqual(request.espeak, LAUNCH.espeak);
	proc.say({ type: "audio", index: 0, wav: "UklGRg==" });
	proc.say({ type: "audio", index: 1, wav: "UklGRh==" });
	assert.deepEqual(h.player().proc.written, ["UklGRg==\n", "UklGRh==\n"]);
	proc.say({ type: "done" });
	proc.emit("exit", 0, null);
	assert.equal(h.player().proc.ended, true, "the player's input closes once every chunk is queued");
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("English replies use the English voice and language", async () => {
	const h = harness();
	const controller = new AbortController();
	const spoken = h.engine.speak("Done. All tests pass.", { language: "en", signal: controller.signal });
	await h.until(() => h.procs.length === 2);
	const request = JSON.parse(h.worker().proc.written.join("").trim());
	assert.equal(request.lang, "en-us");
	assert.equal(request.sid, 3);
	assert.equal(request.speed, 1.08, "the natural voice reads 8% faster than its normal pace");
	controller.abort();
	assert.equal(await spoken, "cancelled");
});

test("cancelling a reading kills both processes and settles as cancelled", async () => {
	const h = harness();
	const controller = new AbortController();
	const spoken = h.engine.speak("Hola. Una frase larga.", { language: "es", signal: controller.signal });
	await h.until(() => h.procs.length === 2);
	controller.abort();
	assert.equal(await spoken, "cancelled");
	assert.deepEqual(h.worker().proc.signals, ["SIGTERM"]);
	assert.deepEqual(h.player().proc.signals, ["SIGTERM"]);
});

test("a worker error, a player failure, an early exit or a timeout reject and stop both processes", async () => {
	for (const scenario of ["worker-error", "player-failure", "early-exit", "timeout"] as const) {
		const h = harness(LAUNCH, scenario === "timeout" ? () => 20 : undefined);
		const spoken = h.engine.speak("Hola.", { language: "es", signal: new AbortController().signal });
		await h.until(() => h.procs.length === 2);
		if (scenario === "worker-error") h.worker().proc.say({ type: "error", code: "runtime-load" });
		if (scenario === "player-failure") h.player().proc.emit("exit", 1, null);
		if (scenario === "early-exit") h.worker().proc.emit("exit", 1, null);
		await assert.rejects(spoken, (error: unknown) => error instanceof Error && !/C:\\\\|secret/.test(error.message), scenario);
		// Whatever did not exit by itself is killed.
		const killed = { "worker-error": [true, true], "player-failure": [true, false], "early-exit": [false, true], timeout: [true, true] }[scenario];
		assert.deepEqual([h.worker().proc.signals.length > 0, h.player().proc.signals.length > 0], killed, scenario);
	}
});

test("with no installed natural voice nothing is started and the reading rejects", async () => {
	const h = harness(null);
	await assert.rejects(h.engine.speak("Hola.", { signal: new AbortController().signal }));
	assert.equal(h.procs.length, 0);
	assert.equal(await h.engine.available(), false);
	assert.equal(await harness().engine.available(), true);
});

function scriptedEngine(id: string, behavior: "done" | "fail", log: string[]): SpeechEngine & { available(): Promise<boolean> } {
	return {
		id,
		available: async () => behavior !== "fail" || id !== "missing",
		speak: async (text) => {
			log.push(`${id}:${text}`);
			if (behavior === "fail") throw new Error("engine failed");
			return "done";
		},
	};
}

test("the fallback engine prefers the natural voice and reads with the Windows voice when it fails or is missing", async () => {
	const signal = new AbortController().signal;
	const log: string[] = [];
	const preferred = createFallbackSpeechEngine(scriptedEngine("kokoro", "done", log), scriptedEngine("windows", "done", log));
	assert.equal(await preferred.speak("uno", { signal }), "done");
	const failing = createFallbackSpeechEngine(scriptedEngine("kokoro", "fail", log), scriptedEngine("windows", "done", log));
	assert.equal(await failing.speak("dos", { signal }), "done");
	const missing = createFallbackSpeechEngine({ ...scriptedEngine("kokoro", "done", log), available: async () => false }, scriptedEngine("windows", "done", log));
	assert.equal(await missing.speak("tres", { signal }), "done");
	assert.deepEqual(log, ["kokoro:uno", "kokoro:dos", "windows:dos", "windows:tres"]);
	const controller = new AbortController();
	const aborting: SpeechEngine & { available(): Promise<boolean> } = { id: "kokoro", available: async () => true, speak: async () => { controller.abort(); throw new Error("killed"); } };
	assert.equal(await createFallbackSpeechEngine(aborting, scriptedEngine("windows", "done", log)).speak("cuatro", { signal: controller.signal }), "cancelled");
	assert.ok(!log.includes("windows:cuatro"), "a cancelled reading is not read again by the fallback");
});

test("a failure after audio was heard is marked audible; one before any audio is not", async () => {
	for (const heard of [false, true]) {
		const h = harness();
		const spoken = h.engine.speak("Hola. Segunda frase.", { language: "es", signal: new AbortController().signal });
		await h.until(() => h.procs.length === 2);
		if (heard) h.worker().proc.say({ type: "audio", index: 0, wav: "UklGRg==" });
		h.worker().proc.say({ type: "error", code: "generate" });
		await assert.rejects(spoken, (error: unknown) => (error as { audible?: boolean }).audible === heard);
	}
});

test("the fallback never reads a reply again after the natural voice was already heard", async () => {
	const log: string[] = [];
	const audibleFailure = Object.assign(new Error("failed mid-reply"), { audible: true });
	const preferred: SpeechEngine & { available(): Promise<boolean> } = { id: "kokoro", available: async () => true, speak: async () => { log.push("kokoro"); throw audibleFailure; } };
	const engine = createFallbackSpeechEngine(preferred, scriptedEngine("windows", "done", log));
	await assert.rejects(engine.speak("hola", { signal: new AbortController().signal }), (error: unknown) => error === audibleFailure);
	assert.deepEqual(log, ["kokoro"]);
});

test("a Piper voice reads Spanish with its single speaker and refuses other languages without starting anything", async () => {
	const h = harness({ ...LAUNCH, kind: "piper" }, undefined, { es: { lang: "es", sid: 0 } });
	const controller = new AbortController();
	const spoken = h.engine.speak("Hola. Soy Miro.", { language: "es", signal: controller.signal });
	await h.until(() => h.procs.length === 2);
	const request = JSON.parse(h.worker().proc.written.join("").trim());
	assert.equal(request.kind, "piper");
	assert.equal(request.sid, 0);
	assert.equal(request.lang, "es");
	controller.abort();
	assert.equal(await spoken, "cancelled");
	const english = harness({ ...LAUNCH, kind: "piper" }, undefined, { es: { lang: "es", sid: 0 } });
	await assert.rejects(english.engine.speak("Hello there.", { language: "en", signal: new AbortController().signal }), (error: unknown) => (error as { audible?: boolean }).audible === false);
	assert.equal(english.procs.length, 0);
});

test("kokoroChunks keeps every sentence of a long reply made of short sentences", () => {
	const text = Array.from({ length: 300 }, (_value, index) => `Frase corta número ${index}.`).join(" ");
	assert.equal(kokoroChunks(text).join(" "), text);
});

// --- speech events (S3, S4) ---------------------------------------------------------

// A 16 kHz tone of the given length, as the base64 WAV line the worker sends.
const wavLine = (seconds: number) => encodeWav(Float32Array.from({ length: Math.round(16_000 * seconds) }, (_value, i) => 0.1 * Math.sin((2 * Math.PI * 220 * i) / 16_000)), 16_000).toString("base64");

test("the shared player announces every line it plays on stdout before playback starts", () => {
	const lines = KOKORO_PLAYER_SCRIPT.split("\n");
	const announcement = lines.findIndex((line) => line.includes(`WriteLine('${PLAYBACK_MARKER}')`));
	const playSync = lines.findIndex((line) => line.includes("PlaySync()"));
	assert.ok(announcement >= 0, "the player reports each line it plays");
	assert.ok(announcement < playSync, "the report comes before the line is played, not after");
});

test("a chunk is published only when the player begins it, in the order it was queued", async () => {
	const h = harness();
	const chunks: VoiceSpeechChunk[] = [];
	const spoken = h.engine.speak("Hola. Una. Dos.", { language: "es", signal: new AbortController().signal, onChunk: (chunk) => { chunks.push(chunk); } });
	await h.until(() => h.procs.length === 2);
	h.worker().proc.say({ type: "audio", index: 0, wav: wavLine(0.2) });
	h.worker().proc.say({ type: "audio", index: 1, wav: wavLine(0.1) });
	assert.deepEqual(chunks, [], "audio waiting in the player is not reported as played");
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	assert.equal(chunks.length, 1, "the marker reports the chunk that just started");
	assert.equal(chunks[0]!.frameMs, 50);
	assert.equal(chunks[0]!.durationMs, 200);
	assert.equal(chunks[0]!.levels.length, 4);
	assert.equal(Math.max(...chunks[0]!.levels), 1, "the loudness is normalized to the chunk's peak frame");
	h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`);
	assert.equal(chunks[1]!.durationMs, 100, "each marker advances the queue exactly one chunk");
	h.worker().proc.say({ type: "done" });
	h.worker().proc.emit("exit", 0, null);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
	assert.equal(chunks.length, 2);
});

test("a consumer that throws on a chunk never breaks or delays the reading", async () => {
	const h = harness();
	const spoken = h.engine.speak("Hola. Una frase.", { language: "es", signal: new AbortController().signal, onChunk: () => { throw new Error("consumer failed"); } });
	await h.until(() => h.procs.length === 2);
	h.worker().proc.say({ type: "audio", index: 0, wav: wavLine(0.1) });
	assert.doesNotThrow(() => h.player().proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`));
	h.worker().proc.say({ type: "done" });
	h.worker().proc.emit("exit", 0, null);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("a player that prints nothing worth reading still reads the reply to the end", async () => {
	const h = harness();
	const chunks: VoiceSpeechChunk[] = [];
	const spoken = h.engine.speak("Hola. Una frase.", { language: "es", signal: new AbortController().signal, onChunk: (chunk) => { chunks.push(chunk); } });
	await h.until(() => h.procs.length === 2);
	h.worker().proc.say({ type: "audio", index: 0, wav: wavLine(0.1) });
	h.player().proc.stdout.emit("data", "played\n");
	h.player().proc.stdout.emit("data", "progress: 50%\n");
	assert.deepEqual(chunks, [], "only the player's own marker reports a chunk");
	h.worker().proc.say({ type: "done" });
	h.worker().proc.emit("exit", 0, null);
	h.player().proc.emit("exit", 0, null);
	assert.equal(await spoken, "done", "unrelated player output changes nothing");
});
