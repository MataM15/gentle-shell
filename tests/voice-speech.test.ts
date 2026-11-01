import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
	createWindowsSpeechEngine,
	guessReplyLanguage,
	resolvePowerShell,
	SpeechEngineError,
	spokenText,
	windowsSpeechAvailable,
	WINDOWS_SPEECH_SCRIPT,
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

test("spokenText reads a long reply whole: a 3,000-character reply is not cut", () => {
	const sentence = "Esta es una oración de prueba con algo de texto para leer.";
	const reply = Array.from({ length: 52 }, () => sentence).join(" ");
	assert.ok(reply.length > 3000);
	assert.equal(spokenText(reply), reply);
});
