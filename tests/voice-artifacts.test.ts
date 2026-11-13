import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	KWS_MODEL_MANIFEST,
	VOICE_KEYWORD_ASSET,
	VOICE_KEYWORD_COMMANDS,
	parseVoiceKeywords,
	VoiceKeywordError,
	type VoiceKeywordCommand,
} from "../lib/voice-artifacts.ts";

// Wake-word artifacts (S7, S10): the keyword spotter model is pinned data from the
// verified release, and the keyword file is a repository asset that names the command
// each line triggers. Nothing here touches the network or the disk beyond reading the
// shipped asset.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const shippedKeywords = () => readFileSync(join(repoRoot, VOICE_KEYWORD_ASSET), "utf8");

function refuses(text: string, code: VoiceKeywordError["code"]): VoiceKeywordError {
	try {
		parseVoiceKeywords(text);
	} catch (error) {
		assert.ok(error instanceof VoiceKeywordError, String(error));
		assert.equal(error.code, code, error.message);
		return error;
	}
	assert.fail(`expected ${code}`);
}

const ON = "▁G ENT LE ▁ VO IC E ▁ON";
const OFF = "▁G ENT LE ▁ VO IC E ▁OF F";

test("the keyword spotter archive and every kept file are pinned from the verified release", () => {
	assert.equal(KWS_MODEL_MANIFEST.id, "kws-zipformer-gigaspeech-3.3m-int8-2024-01-01");
	assert.equal(KWS_MODEL_MANIFEST.archive.format, "tar.bz2");
	assert.equal(KWS_MODEL_MANIFEST.archive.url, "https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2");
	assert.equal(KWS_MODEL_MANIFEST.archive.size, 17_626_723);
	assert.equal(KWS_MODEL_MANIFEST.archive.sha256, "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a");
	assert.equal(KWS_MODEL_MANIFEST.archive.prefix, "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01");
	// The int8 set plus tokens.txt: the 5,253,530 bytes the spotter reads at run time.
	assert.deepEqual(KWS_MODEL_MANIFEST.files, [
		{ name: "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", size: 4_807_159, sha256: "1e721676515bcd42a186979733981213c66c80db680e1cc582dfedf3be76e678" },
		{ name: "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx", size: 277_985, sha256: "e40ff43297abe815e8898494c17e71bba2152d9d40fa3eb803f75d0f7533329a" },
		{ name: "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx", size: 163_380, sha256: "eae9da0c7e1e6c6a3f4cc42d167899c388f6c6701b94cb96320e4f55df79624c" },
		{ name: "tokens.txt", size: 5_006, sha256: "fd2ded4050a55d2b1578870ba8697d02371980217806b7558bd0a5cc60f3ba53" },
	]);
	assert.deepEqual(KWS_MODEL_MANIFEST.redirects, [{ origin: "https://release-assets.githubusercontent.com", pathPrefix: "/github-production-release-asset/" }]);
});

test("the keyword file in the repository gives the spotter one line per command", () => {
	const keywords = parseVoiceKeywords(shippedKeywords());
	assert.deepEqual(keywords.lines, [ON, OFF]);
	assert.equal(keywords.commands.size, 2);
	assert.equal(keywords.commands.get(ON), "voice-on");
	assert.equal(keywords.commands.get(OFF), "voice-off");
	// The spoken word for `cancel` is still being measured, so no line names it yet.
	assert.equal([...keywords.commands.values()].includes("cancel"), false);
	assert.deepEqual([...VOICE_KEYWORD_COMMANDS], ["voice-on", "voice-off", "cancel"]);
});

test("a command may carry several spellings and each one maps back to it", () => {
	const keywords = parseVoiceKeywords([`voice-on: ${ON}`, `voice-on: ▁G ENT LE ▁VO IC E ▁ON`, `voice-off: ${OFF}`].join("\n"));
	assert.deepEqual(keywords.lines, [ON, "▁G ENT LE ▁VO IC E ▁ON", OFF]);
	assert.equal(keywords.commands.get(ON), "voice-on");
	assert.equal(keywords.commands.get("▁G ENT LE ▁VO IC E ▁ON"), "voice-on");
	assert.equal(keywords.commands.get(OFF), "voice-off");
});

test("comments and blank lines are ignored so the file can explain itself", () => {
	const keywords = parseVoiceKeywords(`# one line per spelling\n\n  voice-on:   ${ON}  \n\n# cancel is not measured yet\nvoice-off: ${OFF}\n`);
	assert.deepEqual(keywords.lines, [ON, OFF]);
	assert.equal(keywords.commands.get(ON), "voice-on");
	assert.equal(keywords.commands.get(OFF), "voice-off");
});

test("a line that does not name a command is refused", () => {
	const error = refuses(ON, "syntax");
	assert.match(error.message, /line 1/);
	assert.match(error.message, /does not name a command/);
	refuses("voice-on:", "syntax");
	refuses("voice-on: ", "syntax");
	// Per-line boost and threshold suffixes are not written here: the two global
	// fields tune every line, so a colon or hash inside one is a mistake.
	refuses(`voice-on: ${ON}:2.0`, "syntax");
	refuses(`voice-on: ${ON}#0.25`, "syntax");
});

test("a command the parser does not know is refused", () => {
	const error = refuses(`voice-on: ${ON}\nvoice-louder: ${OFF}`, "unknown-command");
	assert.match(error.message, /line 2/);
	assert.match(error.message, /voice-louder/);
});

test("the same spelling twice is refused", () => {
	const error = refuses(`voice-on: ${ON}\nvoice-off: ${ON}`, "duplicate");
	assert.match(error.message, /line 2/);
	const sameCommand = refuses(`voice-on: ${ON}\nvoice-on: ${ON}`, "duplicate");
	assert.match(sameCommand.message, /line 2/);
});

test("a file with no command line is refused instead of leaving the spotter silent", () => {
	refuses("", "empty");
	refuses("# only a comment\n", "empty");
});

test("the package manifest ships the repository asset directory", () => {
	const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { files?: string[] };
	assert.ok(manifest.files?.includes("assets/"), "assets/ is shipped");
	assert.ok(manifest.files.some((entry) => VOICE_KEYWORD_ASSET.startsWith(entry)), `${VOICE_KEYWORD_ASSET} is covered by ${JSON.stringify(manifest.files)}`);
	const commands: VoiceKeywordCommand[] = [...VOICE_KEYWORD_COMMANDS];
	assert.equal(new Set(commands).size, 3);
});
