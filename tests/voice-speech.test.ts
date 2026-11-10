import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	createRetrySpeechEngine,
	createWindowsSpeechEngine,
	guessReplyLanguage,
	resolvePowerShell,
	SpeechEngineError,
	speechFailureCode,
	spokenText,
	voiceRate,
	voiceRates,
	voiceVolume,
	windowsSpeechAvailable,
	WINDOWS_SPEECH_SCRIPT,
	VOICE_RATE_ENV,
	type SpeechEngine,
	type SpeechOptions,
} from "../lib/voice-speech.ts";

// Spoken replies (S1, S5): what is read aloud, which voice language a reply
// asks for, where the Windows voice exists, and the engine's process contract.

test("spokenText drops code blocks, tables, link targets, URLs and long paths", () => {
	const reply = [
		"## Resultado",
		"",
		"Arreglé el **parser** y lo probé con `node --test`.",
		"",
		"```ts",
		"const secret = compute();",
		"```",
		"",
		"| Archivo | Estado |",
		"| --- | --- |",
		"| lib/a.ts | ok |",
		"",
		"Mirá [la guía](https://example.com/guide) o https://example.com/raw.",
		"El cambio está en `/home/pablo/proyectos/gentle-shell/lib/voice-speech.ts`.",
	].join("\n");
	const spoken = spokenText(reply);
	assert.equal(
		spoken,
		"Resultado. Arreglé el parser y lo probé con node --test. Mirá la guía o. El cambio está en voice-speech.ts.",
	);
	for (const unwanted of ["const secret", "|", "https://", "/home/pablo", "**", "`", "#"]) {
		assert.ok(!spoken.includes(unwanted), `"${unwanted}" is not spoken`);
	}
});

test("spokenText reads list items as separate sentences", () => {
	assert.equal(spokenText("Pasos:\n- instalar\n- probar\n1. cerrar"), "Pasos: instalar. probar. cerrar.");
});

test("spokenText keeps a reply within the limit by ending at a sentence", () => {
	const reply = "Primera oración corta. Segunda oración un poco más larga. Tercera oración que ya no entra.";
	assert.equal(spokenText(reply, 60), "Primera oración corta. Segunda oración un poco más larga.");
	assert.equal(spokenText("x".repeat(80), 20), "x".repeat(20));
});

test("spokenText of a reply with nothing readable is empty", () => {
	assert.equal(spokenText("```\nonly code\n```\n| a | b |\n|---|---|"), "");
	assert.equal(spokenText("   "), "");
});

test("guessReplyLanguage tells Spanish from English and stays unsure otherwise", () => {
	assert.equal(guessReplyLanguage("Listo, ya está funcionando y lo probé con los tests de la extensión."), "es");
	assert.equal(guessReplyLanguage("Done, it is working and I tested it with the extension tests."), "en");
	assert.equal(guessReplyLanguage("ok 123"), undefined);
	assert.equal(guessReplyLanguage(""), undefined);
});

test("windowsSpeechAvailable is true on Windows and WSL only", () => {
	assert.equal(windowsSpeechAvailable({ platform: "win32", kernelRelease: "10.0.22631" }), true);
	assert.equal(windowsSpeechAvailable({ platform: "linux", kernelRelease: "6.18.54.1-microsoft-standard-WSL2" }), true);
	assert.equal(windowsSpeechAvailable({ platform: "linux", kernelRelease: "6.8.0-45-generic" }), false);
	assert.equal(windowsSpeechAvailable({ platform: "darwin", kernelRelease: "24.0.0" }), false);
});

test("resolvePowerShell finds it on the PATH, then at the standard WSL path, else nowhere", () => {
	const onPath = "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0";
	assert.equal(resolvePowerShell("win32", {}, () => false), "powershell.exe");
	assert.equal(resolvePowerShell("linux", { PATH: `/usr/bin:${onPath}` }, (path) => path === `${onPath}/powershell.exe`), `${onPath}/powershell.exe`);
	const standard = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
	assert.equal(resolvePowerShell("linux", { PATH: "/usr/bin" }, (path) => path === standard), standard);
	assert.equal(resolvePowerShell("linux", { PATH: "/usr/bin" }, () => false), undefined);
});

class FakeChild extends EventEmitter {
	readonly written: string[] = [];
	ended = false;
	readonly signals: NodeJS.Signals[] = [];
	stdin = { write: (chunk: string) => { this.written.push(chunk); return true; }, end: () => { this.ended = true; }, on: () => {} };
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		queueMicrotask(() => this.emit("exit", null, signal));
		return true;
	}
}

function fakeSpawn() {
	const calls: { command: string; args: readonly string[]; options: Record<string, unknown>; child: FakeChild }[] = [];
	const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
		const child = new FakeChild();
		calls.push({ command, args, options, child });
		return child;
	};
	return { calls, spawn };
}

const decodePayload = (child: FakeChild) => JSON.parse(Buffer.from(child.written.join("").trim(), "base64").toString("utf8"));

test("the Windows engine runs a fixed script and sends the text only through stdin", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const spoken = engine.speak("Hola, ¿qué tal? Acentos: canción, pingüino.", { language: "es", rate: 1, signal: new AbortController().signal });
	assert.equal(calls.length, 1);
	const [{ command, args, options, child }] = calls;
	assert.equal(command, "powershell.exe");
	assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
	assert.equal(Buffer.from(args.at(-1)!, "base64").toString("utf16le"), WINDOWS_SPEECH_SCRIPT, "the command is the fixed script");
	assert.ok(!args.join(" ").includes("Hola"), "the text never appears in the arguments");
	assert.equal(options.shell, false);
	assert.equal(options.windowsHide, true);
	assert.deepEqual(decodePayload(child), { text: "Hola, ¿qué tal? Acentos: canción, pingüino.", language: "es", rate: 1 });
	assert.equal(child.ended, true, "stdin is closed after the payload");
	child.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("the Windows engine sends no language when the reply language is unknown and clamps the rate", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const spoken = engine.speak("ok", { rate: 42, signal: new AbortController().signal });
	assert.deepEqual(decodePayload(calls[0].child), { text: "ok", rate: 10 });
	calls[0].child.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("GENTLE_PI_VOICE_VOLUME reads as full volume unless it is a number from 0 to 1", () => {
	assert.equal(voiceVolume({}), 1, "unset reads as full volume");
	assert.equal(voiceVolume({ GENTLE_PI_VOICE_VOLUME: "0.8" }), 0.8);
	assert.equal(voiceVolume({ GENTLE_PI_VOICE_VOLUME: " 0.25 " }), 0.25, "surrounding spaces are ignored");
	assert.equal(voiceVolume({ GENTLE_PI_VOICE_VOLUME: "0" }), 0, "zero mutes the reading");
	assert.equal(voiceVolume({ GENTLE_PI_VOICE_VOLUME: "1" }), 1);
	for (const bad of ["", "8", "80%", "-0.2", "1.5", "loud"]) {
		assert.equal(voiceVolume({ GENTLE_PI_VOICE_VOLUME: bad }), 1, `"${bad}" never mutes a reply or makes it louder`);
	}
});

test("the Windows voice sets the synthesizer volume from the reply volume", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe", volume: 0.8 });
	const spoken = engine.speak("hola", { signal: new AbortController().signal });
	assert.deepEqual(decodePayload(calls[0].child), { text: "hola", volume: 80 }, "the volume goes to PowerShell as 0..100");
	assert.ok(WINDOWS_SPEECH_SCRIPT.includes("$synth.Volume = "), "the script applies it to the synthesizer");
	calls[0].child.emit("exit", 0, null);
	assert.equal(await spoken, "done");
});

test("aborting a reading kills the process and settles as cancelled", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const controller = new AbortController();
	const spoken = engine.speak("una frase larga", { signal: controller.signal });
	controller.abort();
	assert.equal(await spoken, "cancelled");
	assert.deepEqual(calls[0].child.signals, ["SIGTERM"]);
});

test("an already aborted signal starts no process", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const controller = new AbortController();
	controller.abort();
	assert.equal(await engine.speak("hola", { signal: controller.signal }), "cancelled");
	assert.equal(calls.length, 0);
});

test("a failing process rejects with a fixed message and no native detail", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const spoken = engine.speak("hola", { signal: new AbortController().signal });
	calls[0].child.stderr.emit("data", "C:\\Users\\secret\\path exploded");
	calls[0].child.emit("exit", 1, null);
	await assert.rejects(spoken, (error: unknown) => {
		assert.ok(error instanceof SpeechEngineError);
		assert.equal(error.code, "failed");
		assert.equal(error.message, "The Windows voice could not read the reply.");
		return true;
	});
});

test("a process that cannot start rejects as unavailable", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe" });
	const spoken = engine.speak("hola", { signal: new AbortController().signal });
	calls[0].child.emit("error", new Error("spawn powershell.exe ENOENT"));
	await assert.rejects(spoken, (error: unknown) => error instanceof SpeechEngineError && error.code === "unavailable" && error.message === "The Windows voice is not available from this system.");
});

test("a reading that runs past its bound is killed and rejects as timeout", async () => {
	const { calls, spawn } = fakeSpawn();
	const engine = createWindowsSpeechEngine({ spawn, command: "powershell.exe", timeoutMs: () => 20 });
	const spoken = engine.speak("hola", { signal: new AbortController().signal });
	await assert.rejects(spoken, (error: unknown) => error instanceof SpeechEngineError && error.code === "timeout");
	assert.deepEqual(calls[0].child.signals, ["SIGTERM"]);
});

// --- per-language rate and the retry rule (S2, S3) -------------------------------

class CodedError extends Error {
	readonly code: string;
	readonly audible: boolean;
	constructor(code: string, audible = false) {
		super(code);
		this.code = code;
		this.audible = audible;
	}
}

function countingEngine(failures: CodedError[], outcome: "done" | "cancelled" = "done") {
	const calls: SpeechOptions[] = [];
	const engine: SpeechEngine = {
		id: "raul-robot",
		async speak(_text, options) {
			calls.push(options);
			const failure = failures.shift();
			if (failure) throw failure;
			return outcome;
		},
	};
	return { engine, calls };
}

test("GENTLE_PI_VOICE_RATE_ES and GENTLE_PI_VOICE_RATE_EN read as one multiplier per language", () => {
	assert.deepEqual(Object.values(VOICE_RATE_ENV), ["GENTLE_PI_VOICE_RATE_ES", "GENTLE_PI_VOICE_RATE_EN"]);
	assert.deepEqual(voiceRates({}), { es: 1, en: 1 }, "unset reads as the voice's own pace");
	assert.equal(voiceRate("en", { GENTLE_PI_VOICE_RATE_EN: "0.6" }), 0.6);
	assert.equal(voiceRates({ GENTLE_PI_VOICE_RATE_ES: "0.6" }).es, 0.6);
	assert.deepEqual(voiceRates({ GENTLE_PI_VOICE_RATE_ES: "0.6" }), { es: 0.6, en: 1 }, "each language has its own multiplier");
	assert.equal(voiceRate("es", { GENTLE_PI_VOICE_RATE_ES: " 1.5 " }), 1.5, "surrounding spaces are ignored");
	assert.equal(voiceRate("es", { GENTLE_PI_VOICE_RATE_ES: "0.5" }), 0.5, "the slowest multiplier is allowed");
	assert.equal(voiceRate("es", { GENTLE_PI_VOICE_RATE_ES: "2" }), 2, "the fastest multiplier is allowed");
	for (const bad of ["", "  ", "0.4", "2.1", "0", "-1", "slow", "1,5"]) {
		assert.equal(voiceRate("en", { GENTLE_PI_VOICE_RATE_EN: bad }), 1, `"${bad}" reads as the voice's own pace`);
	}
});

test("a voice that fails before any audio is retried once, and the retry reports its failure code", async () => {
	const retried = countingEngine([new CodedError("no-voice")]);
	const engine = createRetrySpeechEngine(retried.engine);
	const retries: Array<{ attempt: number; failure: string }> = [];
	assert.equal(await engine.speak("Hola.", { signal: new AbortController().signal, onRetry: (info) => retries.push(info) }), "done");
	assert.equal(retried.calls.length, 2, "the reading is heard again from the start");
	assert.deepEqual(retries, [{ attempt: 1, failure: "no-voice" }]);
});

test("a second failure ends the reading with its code and no other voice reads it", async () => {
	const failing = countingEngine([new CodedError("failed"), new CodedError("timeout")]);
	const engine = createRetrySpeechEngine(failing.engine);
	const retries: Array<{ attempt: number; failure: string }> = [];
	await assert.rejects(engine.speak("Hola.", { signal: new AbortController().signal, onRetry: (info) => retries.push(info) }), (error: unknown) => (error as { code?: string }).code === "timeout");
	assert.equal(failing.calls.length, 2, "exactly one retry, then it stops");
	assert.deepEqual(retries, [{ attempt: 1, failure: "failed" }]);
});

test("a failure after part of the reply was heard, and a reading the user stopped, are never retried", async () => {
	const audible = countingEngine([new CodedError("failed", true)]);
	const engine = createRetrySpeechEngine(audible.engine);
	await assert.rejects(engine.speak("Hola.", { signal: new AbortController().signal }), (error: unknown) => (error as { audible?: boolean }).audible === true);
	assert.equal(audible.calls.length, 1, "the reply is not repeated from the start");

	const cancelled = countingEngine([]);
	const stopped = createRetrySpeechEngine(cancelled.engine);
	const controller = new AbortController();
	controller.abort();
	assert.equal(await stopped.speak("Hola.", { signal: controller.signal }), "cancelled");
	assert.equal(cancelled.calls.length, 0);
});

test("the retried voice keeps the id and the voice name of the voice it retries", () => {
	const engine = createRetrySpeechEngine({ id: "raul-robot", voiceFor: (language) => (language === "en" ? "Microsoft David" : "Microsoft Raul"), speak: async () => "done" });
	assert.equal(engine.id, "raul-robot", "no composite chain id");
	assert.equal(engine.voiceFor?.("en"), "Microsoft David");
	assert.equal(engine.voiceFor?.("es"), "Microsoft Raul");
	assert.equal(createRetrySpeechEngine({ id: "fake", speak: async () => "done" }).voiceFor, undefined, "a voice without a name adds none");
});

test("a failure reads as its own code, and anything else as a plain failure", () => {
	assert.equal(speechFailureCode(new CodedError("no-voice")), "no-voice");
	assert.equal(speechFailureCode(new SpeechEngineError("unavailable")), "unavailable");
	assert.equal(speechFailureCode(new Error("boom")), "failed");
	assert.equal(speechFailureCode(undefined), "failed");
});

test("spokenText reads a long reply whole: a 3,000-character reply is not cut", () => {
	const sentence = "Esta es una oración de prueba con algo de texto para leer.";
	const reply = Array.from({ length: 52 }, () => sentence).join(" ");
	assert.ok(reply.length > 3000);
	assert.equal(spokenText(reply), reply);
});
