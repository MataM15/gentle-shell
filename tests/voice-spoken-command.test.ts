import assert from "node:assert/strict";
import test from "node:test";
import { matchSpokenCommand } from "../lib/voice-spoken-command.ts";

// Only a whole utterance from the fixed command list runs a command (S4, S10).
// These tests feed the matcher transcripts and nothing else: no audio, no
// session, no model.

test("a whole utterance naming the voice off command is recognized however it was transcribed", () => {
	for (const said of [
		"Gentle Voice off",
		"gentle voice off.",
		"gentle voice, off.",
		"Gentle  voice   OFF",
		"gentle voice off\n",
		"gentle voz off",
		"yentel voice off",
		"gentel voice of",
		"gèntle voice óff",
		"gentle-voice off",
	]) {
		assert.equal(matchSpokenCommand(said), "voice-off", JSON.stringify(said));
	}
});

test("the phrase inside a longer sentence stays ordinary text, never a command", () => {
	for (const said of [
		"quiero que digas gentle voice off",
		"gentle voice off por favor",
		"gentle voice off, y también apagá la lectura",
		"decile gentle voice off al sistema",
		"gentle voice off please",
		"gentle voice offset",
		"gentle voice offgentle",
	]) {
		assert.equal(matchSpokenCommand(said), undefined, JSON.stringify(said));
	}
});

test("only the fixed list decides: no other words, fragment or near miss runs anything", () => {
	for (const said of [
		"",
		"   ",
		"gentle",
		"gentle voice",
		"gentle voice on",
		"gentle voice louder",
		"voice off",
		"off",
		"apagá la voz",
		"gentle voice 0ff",
		"gentle voices off",
	]) {
		assert.equal(matchSpokenCommand(said), undefined, JSON.stringify(said));
	}
});
