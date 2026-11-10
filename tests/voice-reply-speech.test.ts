import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ONECORE_SYNTH_SCRIPTS } from "../lib/voice-onecore.ts";
import { createReplyReader, createReplySpeechChain, lastAssistantText, replyLanguage } from "../lib/voice-reply-speech.ts";
import { encodeWav } from "../lib/voice-robot.ts";
import { PLAYBACK_MARKER } from "../lib/voice-speech-events.ts";
import type { SpeechEngine, SpeechOptions } from "../lib/voice-speech.ts";

// Which text of a finished run is read aloud, and how one reading is handed
// to the engine (S1).

test("lastAssistantText joins the text parts of the last assistant message with text", () => {
	const messages = [
		{ role: "user", content: "hola" },
		{ role: "assistant", content: [{ type: "text", text: "intermedio" }] },
		{ role: "toolResult", content: [{ type: "text", text: "salida de la herramienta" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "pienso" }, { type: "text", text: "Listo." }, { type: "toolCall", name: "bash" }, { type: "text", text: "Todo anda." }] },
	];
	assert.equal(lastAssistantText(messages), "Listo.\n\nTodo anda.");
});

test("lastAssistantText skips a final assistant message without text and reads string content", () => {
	assert.equal(lastAssistantText([{ role: "assistant", content: "Respuesta simple." }, { role: "assistant", content: [{ type: "toolCall", name: "read" }] }]), "Respuesta simple.");
	assert.equal(lastAssistantText([{ role: "user", content: "hola" }]), undefined);
	assert.equal(lastAssistantText([]), undefined);
	assert.equal(lastAssistantText([null, 3, { role: "assistant", content: [{ type: "text", text: "   " }] }]), undefined);
});

function recordingEngine(outcome: "done" | "cancelled" = "done") {
	const calls: Array<{ text: string; options: SpeechOptions }> = [];
	const engine: SpeechEngine = { id: "fake", speak: async (text, options) => { calls.push({ text, options }); return outcome; } };
	return { engine, calls };
}

test("a reading speaks the cleaned text in the reply's language", async () => {
	const { engine, calls } = recordingEngine();
	const reader = createReplyReader({ engine: () => engine, rate: 2 });
	const signal = new AbortController().signal;
	assert.equal(await reader.read("Listo, **ya está** funcionando.\n```\ncode\n```", signal), "done");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].text, "Listo, ya está funcionando.");
	assert.equal(calls[0].options.language, "es");
	assert.equal(calls[0].options.rate, 2);
	assert.equal(calls[0].options.signal, signal);
});

test("a reply with nothing readable, or no engine, speaks nothing", async () => {
	const { engine, calls } = recordingEngine();
	const signal = new AbortController().signal;
	assert.equal(await createReplyReader({ engine: () => engine }).read("```\nonly code\n```", signal), "empty");
	assert.equal(calls.length, 0);
	assert.equal(await createReplyReader({ engine: () => undefined }).read("Hola, ¿cómo va?", signal), "unavailable");
});

test("replyLanguage is the language one reading asks the voice for", () => {
	assert.equal(replyLanguage("All the tests are green."), "en");
	assert.equal(replyLanguage("Listo, ya está andando."), "es");
	assert.equal(replyLanguage("42"), undefined, "a reply with no words asks for no language");
});

// --- the reply voice chain (S1, S2, S3) ----------------------------------------------

class FakeProc extends EventEmitter {
	readonly written: string[] = [];
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	onWrite?: () => void;
	onEnd?: () => void;
	stdin = {
		write: (chunk: string) => {
			this.written.push(chunk);
			this.onWrite?.();
			return true;
		},
		end: () => {
			this.onEnd?.();
		},
		on: () => {},
	};
	kill() {
		return true;
	}
}

const TONE = encodeWav(Float32Array.from({ length: 1600 }, (_value, index) => 0.05 * Math.sin(index / 5)), 16000).toString("base64");

// One synthesizer per attempt: the first one finds no voice, the second reads.
function chainHarness() {
	const procs: FakeProc[] = [];
	const synthRequests: Array<Record<string, unknown>> = [];
	let attempts = 0;
	const spawn = (_command: string, args: readonly string[]) => {
		const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
		const proc = new FakeProc();
		procs.push(proc);
		if (script === ONECORE_SYNTH_SCRIPTS.es || script === ONECORE_SYNTH_SCRIPTS.en) {
			attempts++;
			const attempt = attempts;
			const request = () => synthRequests.push(JSON.parse(Buffer.from(proc.written.join("").trim(), "base64").toString("utf8")));
			proc.stdin.write = (chunk: string) => {
				proc.written.push(chunk);
				request();
				queueMicrotask(() => {
					if (attempt === 1) {
						proc.stdout.emit("data", "error:no-voice\n");
						proc.emit("exit", 1, null);
						return;
					}
					proc.stdout.emit("data", `audio:${TONE}\n`);
					proc.emit("exit", 0, null);
				});
				return true;
			};
		} else {
			proc.onWrite = () => {
				queueMicrotask(() => proc.stdout.emit("data", `${PLAYBACK_MARKER}\n`));
			};
			proc.onEnd = () => {
				queueMicrotask(() => proc.emit("exit", 0, null));
			};
		}
		return proc;
	};
	const until = async (check: () => boolean) => {
		for (let index = 0; index < 200 && !check(); index++) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.ok(check(), "condition not reached");
	};
	return { procs, synthRequests, spawn, until, attempts: () => attempts };
}

test("the reply chain is the robot voice alone: Raúl for Spanish, David for English", () => {
	const engine = createReplySpeechChain({ powershell: "/mnt/c/Windows/powershell.exe", env: {} });
	assert.equal(engine.id, "raul-robot");
	assert.ok(!engine.id.includes("+"), "no other voice is chained behind it");
	assert.equal(engine.voiceFor?.("es"), "Microsoft Raul");
	assert.equal(engine.voiceFor?.("en"), "Microsoft David");
	assert.equal(engine.voiceFor?.(undefined), "Microsoft Raul", "an undecided reply keeps the Spanish robot voice");
});

test("a chain attempt that fails before any audio is retried once by the same voice, at the reply's rate", async () => {
	const h = chainHarness();
	const engine = createReplySpeechChain({ powershell: "/mnt/c/Windows/powershell.exe", env: { GENTLE_PI_VOICE_RATE_EN: "0.6" }, spawn: h.spawn });
	const retries: Array<{ attempt: number; failure: string }> = [];
	const spoken = engine.speak("Try again.", { language: "en", signal: new AbortController().signal, onRetry: (info) => retries.push(info) });
	await h.until(() => retries.length === 1);
	assert.equal(await spoken, "done");
	assert.equal(h.attempts(), 2, "one retry, never a third voice");
	assert.deepEqual(retries, [{ attempt: 1, failure: "no-voice" }]);
	assert.deepEqual(h.synthRequests, [{ text: "Try again.", rate: 0.6 }, { text: "Try again.", rate: 0.6 }], "the retry keeps the English multiplier");
});
