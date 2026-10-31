import assert from "node:assert/strict";
import test from "node:test";
import { createReplyReader, lastAssistantText } from "../lib/voice-reply-speech.ts";
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
