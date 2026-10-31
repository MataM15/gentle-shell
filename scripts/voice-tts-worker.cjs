"use strict";
// Natural-voice speech worker (docs/voice.md, "Natural voice with Kokoro").
// lib/voice-kokoro-engine.ts runs this file as its own Node process, so the
// blocking model load and synthesis never run inside Gentle AI. It speaks JSON
// lines: stdin receives one `start` request and possibly `cancel`; stdout
// carries one `audio` line per text chunk, a 16-bit mono WAV in base64, then
// `done`, or one `error` with a closed code only, never a message, path or
// native error text.
//
// The phoneme data arrives as flat installed components. espeak-ng expects a
// nested tree, so the worker copies those few files into a private temporary
// directory, points the model there, and removes it whenever it ends.
//
// The model files are checked for kind and size before anything native loads;
// their digests were verified at download and the install marker is checked by
// the parent. That does not make the install tamper-proof against the same
// user, who can replace the files at any time.

const { copyFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA = "gentle.voice-tts/v1";
const TTS_ENTRY = "node_modules/sherpa-onnx-node/non-streaming-tts.js";
const CORE_FILES = ["model.onnx", "voices.bin", "tokens.txt"];
const ESPEAK_FOLDERS = ["", "lang/roa", "lang/gmw"];
const LANGS = ["es", "es-419", "en-us"];
const MAX_INPUT_LINE = 256 * 1024;
const MAX_CHUNKS = 64;
const MAX_CHUNK = 2000;
const MAX_FILES = 32;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class WorkerFailure extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new WorkerFailure(code);
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, keys) => isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const isRoot = (value) => typeof value === "string" && path.isAbsolute(value);

function parseFiles(value) {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) fail("invalid-request");
	for (const file of value) {
		if (!hasExactKeys(file, ["name", "size"]) || typeof file.name !== "string" || !SAFE_NAME.test(file.name) || !isInteger(file.size, 1, Number.MAX_SAFE_INTEGER)) fail("invalid-request");
	}
	return value;
}

function parseStart(message) {
	const keys = ["schema", "type", "runtime", "core", "espeak", "lang", "sid", "speed", "numThreads", "chunks"];
	if (!hasExactKeys(message, keys) || message.schema !== SCHEMA || message.type !== "start") fail("invalid-request");
	if (!hasExactKeys(message.runtime, ["root"]) || !isRoot(message.runtime.root)) fail("invalid-request");
	if (!hasExactKeys(message.core, ["root", "files"]) || !isRoot(message.core.root)) fail("invalid-request");
	const coreFiles = parseFiles(message.core.files);
	if (!CORE_FILES.every((name) => coreFiles.some((file) => file.name === name))) fail("invalid-request");
	if (!Array.isArray(message.espeak) || message.espeak.length !== ESPEAK_FOLDERS.length) fail("invalid-request");
	const folders = new Set();
	for (const part of message.espeak) {
		if (!hasExactKeys(part, ["root", "folder", "files"]) || !isRoot(part.root) || !ESPEAK_FOLDERS.includes(part.folder) || folders.has(part.folder)) fail("invalid-request");
		folders.add(part.folder);
		parseFiles(part.files);
	}
	if (!LANGS.includes(message.lang) || !isInteger(message.sid, 0, 53) || !isInteger(message.numThreads, 1, 8)) fail("invalid-request");
	if (typeof message.speed !== "number" || !Number.isFinite(message.speed) || message.speed < 0.5 || message.speed > 2) fail("invalid-request");
	const { chunks } = message;
	if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > MAX_CHUNKS) fail("invalid-request");
	if (!chunks.every((chunk) => typeof chunk === "string" && chunk.trim().length > 0 && chunk.length <= MAX_CHUNK)) fail("invalid-request");
	return message;
}

// A regular file of exactly the expected size, not a link or anything else.
function checkFile(root, name, size, code) {
	let info;
	try {
		info = lstatSync(path.join(root, name));
	} catch {
		fail(code);
	}
	if (!info.isFile() || (size !== undefined && info.size !== size)) fail(code);
}

function wavOf(samples, sampleRate) {
	const pcm = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i])) : 0;
		pcm.writeInt16LE(Math.round(value * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

class TtsSession {
	constructor(io, finish) {
		this.io = io;
		this.finish = finish;
		this.state = "waiting";
		this.dataRoot = undefined;
	}

	send(message) {
		this.io.write(`${JSON.stringify({ schema: SCHEMA, ...message })}\n`);
	}

	end(final) {
		if (this.state === "ended") return;
		this.state = "ended";
		if (this.dataRoot) {
			try {
				rmSync(this.dataRoot, { recursive: true, force: true });
			} catch {
				/* best effort: it lives in the system temporary directory */
			}
			this.dataRoot = undefined;
		}
		if (final) this.send(final);
		this.finish(final?.type === "error" ? 1 : 0);
	}

	fail(error) {
		this.end({ type: "error", code: error instanceof WorkerFailure ? error.code : "internal" });
	}

	async handle(message) {
		if (this.state === "waiting") return this.speak(parseStart(message));
		if (hasExactKeys(message, ["schema", "type"]) && message.schema === SCHEMA && message.type === "cancel") return this.end(undefined);
		fail("invalid-request");
	}

	assembleEspeak(parts) {
		const tmp = this.io.tmpdir ?? os.tmpdir();
		this.dataRoot = mkdtempSync(path.join(tmp, "gentle-voice-tts-"));
		const dataDir = path.join(this.dataRoot, "espeak-ng-data");
		for (const part of parts) {
			const target = path.join(dataDir, ...part.folder.split("/").filter(Boolean));
			mkdirSync(target, { recursive: true, mode: 0o700 });
			for (const file of part.files) copyFileSync(path.join(part.root, file.name), path.join(target, file.name));
		}
		return dataDir;
	}

	async speak(request) {
		this.state = "speaking";
		const sizeOf = (name) => request.core.files.find((file) => file.name === name).size;
		for (const name of CORE_FILES) checkFile(request.core.root, name, sizeOf(name), "model-invalid");
		for (const part of request.espeak) for (const file of part.files) checkFile(part.root, file.name, file.size, "model-invalid");
		checkFile(request.runtime.root, TTS_ENTRY, undefined, "runtime-invalid");
		let dataDir;
		try {
			dataDir = this.assembleEspeak(request.espeak);
		} catch {
			fail("model-invalid");
		}
		let tts;
		try {
			const { OfflineTts } = this.io.loadModule(path.join(request.runtime.root, ...TTS_ENTRY.split("/")));
			tts = new OfflineTts({
				model: {
					kokoro: {
						model: path.join(request.core.root, "model.onnx"),
						voices: path.join(request.core.root, "voices.bin"),
						tokens: path.join(request.core.root, "tokens.txt"),
						dataDir,
						lang: request.lang,
					},
					numThreads: request.numThreads,
					provider: "cpu",
					debug: false,
				},
				maxNumSentences: 1,
			});
		} catch {
			fail("runtime-load");
		}
		for (let index = 0; index < request.chunks.length; index++) {
			if (this.state !== "speaking") return;
			let audio;
			try {
				audio = tts.generate({ text: request.chunks[index], sid: request.sid, speed: request.speed, generationConfig: { sid: request.sid, speed: request.speed, extra: { lang: request.lang } } });
			} catch {
				fail("generate");
			}
			if (this.state !== "speaking") return;
			if (!audio || !(audio.samples instanceof Float32Array) || !isInteger(audio.sampleRate, 8000, 96000)) fail("generate");
			this.send({ type: "audio", index, wav: wavOf(audio.samples, audio.sampleRate).toString("base64") });
			// Synthesis blocks the event loop; a turn in between lets a cancel in.
			await nextTurn();
		}
		if (this.state === "speaking") this.end({ type: "done" });
	}
}

function runTtsWorker(io) {
	return new Promise((resolve) => {
		let buffered = "";
		const session = new TtsSession(io, (code) => {
			io.input.removeListener("data", onData);
			io.input.removeListener("end", onEnd);
			io.exit(code);
			resolve();
		});
		const dispatch = (handler) => {
			try {
				void Promise.resolve(handler()).catch((error) => session.fail(error));
			} catch (error) {
				session.fail(error);
			}
		};
		const onData = (chunk) => {
			buffered += String(chunk);
			let newline;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				dispatch(() => {
					let message;
					try {
						message = line.length <= MAX_INPUT_LINE ? JSON.parse(line) : undefined;
					} catch {
						message = undefined;
					}
					return session.handle(message);
				});
			}
			if (buffered.length > MAX_INPUT_LINE) {
				buffered = "";
				dispatch(() => fail("invalid-request"));
			}
		};
		// A closed stdin means the parent is gone: stop and leave.
		const onEnd = () => dispatch(() => session.end(undefined));
		io.input.on("data", onData);
		io.input.on("end", onEnd);
	});
}

module.exports = { runTtsWorker };

if (require.main === module) {
	const io = {
		input: process.stdin,
		write: (line) => process.stdout.write(line),
		exit: (code) => process.stdout.write("", () => process.exit(code)),
		loadModule: (file) => require(file),
	};
	process.on("uncaughtException", () => {
		process.stdout.write(`${JSON.stringify({ schema: SCHEMA, type: "error", code: "internal" })}\n`, () => process.exit(1));
	});
	process.stdin.setEncoding("utf8");
	void runTtsWorker(io);
}
