import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// scripts/voice-tts-worker.cjs driven in-process with a fake sherpa-onnx module
// (S6): request validation, the assembled espeak tree, sentence-by-sentence WAV
// output, failures by code only, and cleanup. Nothing native is loaded.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { runTtsWorker } = createRequire(import.meta.url)("../scripts/voice-tts-worker.cjs");
const SCHEMA = "gentle.voice-tts/v1";
const TTS_ENTRY = "node_modules/sherpa-onnx-node/non-streaming-tts.js";

interface Install {
	runtimeRoot: string;
	core: string;
	piper: string;
	espeak: string;
	romance: string;
	germanic: string;
	scratch: string;
}

function install(t: test.TestContext): Install {
	const base = join(repoRoot, "tmp");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "voice-tts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const make = (root: string, files: Record<string, string>) => {
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, name)), { recursive: true });
			writeFileSync(join(root, name), content);
		}
		return root;
	};
	const scratch = join(dir, "scratch");
	mkdirSync(scratch);
	return {
		runtimeRoot: make(join(dir, "runtime"), { [TTS_ENTRY]: "// fake" }),
		core: make(join(dir, "core"), { "model.onnx": "model", "voices.bin": "voices", "tokens.txt": "tokens" }),
		piper: make(join(dir, "piper"), { "es_ES-miro-high.onnx": "piper model", "tokens.txt": "piper tokens" }),
		espeak: make(join(dir, "espeak"), { phontab: "pt", phonindex: "pi", phondata: "pd", intonations: "in", es_dict: "es", en_dict: "en" }),
		romance: make(join(dir, "roa"), { es: "lang es", "es-419": "lang es-419" }),
		germanic: make(join(dir, "gmw"), { en: "lang en", "en-US": "lang en-US" }),
		scratch,
	};
}

const sized = (root: string, names: string[]) => names.map((name) => ({ name, size: readFileSync(join(root, name)).length }));

function startRequest(paths: Install, overrides: Record<string, unknown> = {}) {
	return {
		schema: SCHEMA,
		type: "start",
		runtime: { root: paths.runtimeRoot },
		core: { root: paths.core, files: sized(paths.core, ["model.onnx", "voices.bin", "tokens.txt"]) },
		espeak: [
			{ root: paths.espeak, folder: "", files: sized(paths.espeak, ["phontab", "phonindex", "phondata", "intonations", "es_dict", "en_dict"]) },
			{ root: paths.romance, folder: "lang/roa", files: sized(paths.romance, ["es", "es-419"]) },
			{ root: paths.germanic, folder: "lang/gmw", files: sized(paths.germanic, ["en", "en-US"]) },
		],
		lang: "es",
		sid: 28,
		speed: 1,
		numThreads: 2,
		chunks: ["Hola.", "¿Cómo andás?"],
		...overrides,
	};
}

interface FakeOptions {
	loadError?: boolean;
	generateError?: boolean;
	// Called before each generate returns, to let a test cancel in between.
	beforeGenerate?: (index: number) => void;
}

function harness(t: test.TestContext, fake: FakeOptions = {}) {
	const paths = install(t);
	const input = new EventEmitter();
	const messages: Array<Record<string, unknown>> = [];
	const loaded: string[] = [];
	const engines: Array<{ config: any; calls: any[]; dataDirSeen?: { es: string; phontab: string } }> = [];
	let exitCode: number | undefined;
	let terminate: (() => void) | undefined;
	class OfflineTts {
		config: any;
		calls: any[] = [];
		sampleRate = 24000;
		constructor(config: any) {
			this.config = config;
			const dataDir = (config.model.kokoro ?? config.model.vits).dataDir;
			engines.push(this as any);
			(this as any).dataDirSeen = { es: readFileSync(join(dataDir, "lang/roa/es"), "utf8"), phontab: readFileSync(join(dataDir, "phontab"), "utf8") };
		}
		generate(request: any) {
			fake.beforeGenerate?.(this.calls.length);
			this.calls.push(request);
			if (fake.generateError) throw new Error("native detail C:\\secret");
			return { samples: new Float32Array([0, 0.5, -0.5, 1, -1, 2]), sampleRate: 24000 };
		}
	}
	const done: Promise<void> = runTtsWorker({
		input,
		write: (line: string) => messages.push(JSON.parse(line)),
		exit: (code: number) => { exitCode = code; },
		loadModule: (file: string) => {
			loaded.push(file);
			if (fake.loadError) throw new Error("dlopen detail /home/secret");
			if (file === join(paths.runtimeRoot, ...TTS_ENTRY.split("/"))) return { OfflineTts };
			throw new Error(`unexpected module ${file}`);
		},
		tmpdir: paths.scratch,
		onTerminate: (handler: () => void) => { terminate = handler; },
	});
	const send = (message: unknown) => input.emit("data", `${typeof message === "string" ? message : JSON.stringify(message)}\n`);
	return { paths, input, messages, loaded, engines, done, send, terminate: () => terminate?.(), types: () => messages.map((message) => message.type), exitCode: () => exitCode };
}

test("speaks each chunk in order as a 16-bit WAV line, with the espeak tree assembled and removed afterwards", async (t) => {
	const worker = harness(t);
	worker.send(startRequest(worker.paths));
	await worker.done;
	assert.deepEqual(worker.types(), ["audio", "audio", "done"]);
	assert.deepEqual(worker.messages.slice(0, 2).map((message) => message.index), [0, 1]);
	assert.equal(worker.exitCode(), 0);
	const [engine] = worker.engines;
	const { kokoro } = engine!.config.model;
	assert.equal(kokoro.model, join(worker.paths.core, "model.onnx"));
	assert.equal(kokoro.voices, join(worker.paths.core, "voices.bin"));
	assert.equal(kokoro.tokens, join(worker.paths.core, "tokens.txt"));
	assert.equal(kokoro.lang, "es");
	assert.equal(engine!.config.model.numThreads, 2);
	assert.deepEqual(engine!.dataDirSeen, { es: "lang es", phontab: "pt" }, "espeak-ng sees the nested layout");
	assert.ok(kokoro.dataDir.startsWith(worker.paths.scratch), "the tree lives in the private temporary directory");
	assert.equal(existsSync(kokoro.dataDir), false, "and it is removed when the worker ends");
	assert.deepEqual(engine!.calls.map((call) => [call.text, call.sid, call.speed, call.generationConfig?.extra?.lang]), [["Hola.", 28, 1, "es"], ["¿Cómo andás?", 28, 1, "es"]]);
	const wav = Buffer.from(worker.messages[0]!.wav as string, "base64");
	assert.equal(wav.toString("ascii", 0, 4), "RIFF");
	assert.equal(wav.toString("ascii", 8, 12), "WAVE");
	assert.equal(wav.readUInt32LE(24), 24000);
	assert.equal(wav.readUInt16LE(34), 16);
	assert.equal(wav.readUInt32LE(40), 12, "six samples of two bytes");
	assert.deepEqual([0, 1, 2, 3, 4, 5].map((i) => wav.readInt16LE(44 + i * 2)), [0, 16384, -16383, 32767, -32767, 32767], "clamped to full scale");
});

test("rejects malformed requests before loading anything", async (t) => {
	const paths = install(t);
	const base = startRequest(paths);
	const cases: Array<[string, Record<string, unknown>]> = [
		["unknown key", { extra: 1 }],
		["relative runtime", { runtime: { root: "runtime" } }],
		["sid out of range", { sid: 54 }],
		["speed out of range", { speed: 3 }],
		["unsupported lang", { lang: "fr" }],
		["no chunks", { chunks: [] }],
		["too many chunks", { chunks: Array.from({ length: 65 }, () => "x") }],
		["chunk too long", { chunks: ["x".repeat(2001)] }],
		["unsafe core name", { core: { ...base.core, files: [{ name: "../model.onnx", size: 5 }, ...base.core.files.slice(1)] } }],
		["unknown espeak folder", { espeak: [{ ...base.espeak[0], folder: "../escape" }, ...base.espeak.slice(1)] }],
	];
	for (const [name, overrides] of cases) {
		const worker = harness(t);
		worker.send({ ...startRequest(worker.paths), ...overrides });
		await worker.done;
		assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "invalid-request" }], name);
		assert.deepEqual(worker.loaded, [], name);
		assert.equal(worker.exitCode(), 1, name);
	}
});

test("a missing or resized model file is reported as model-invalid before loading", async (t) => {
	const worker = harness(t);
	writeFileSync(join(worker.paths.core, "voices.bin"), "a different length");
	worker.send(startRequest(worker.paths, { core: { root: worker.paths.core, files: [{ name: "model.onnx", size: 5 }, { name: "voices.bin", size: 6 }, { name: "tokens.txt", size: 6 }] } }));
	await worker.done;
	assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "model-invalid" }]);
	assert.deepEqual(worker.loaded, []);
});

test("native load and generation failures are reported by code only", async (t) => {
	const load = harness(t, { loadError: true });
	load.send(startRequest(load.paths));
	await load.done;
	assert.deepEqual(load.messages, [{ schema: SCHEMA, type: "error", code: "runtime-load" }]);
	const generate = harness(t, { generateError: true });
	generate.send(startRequest(generate.paths));
	await generate.done;
	assert.deepEqual(generate.messages, [{ schema: SCHEMA, type: "error", code: "generate" }]);
	assert.ok(!JSON.stringify([...load.messages, ...generate.messages]).includes("secret"));
});

test("a cancel or a closed stdin stops between chunks and still removes the espeak tree", async (t) => {
	for (const stop of ["cancel", "close"] as const) {
		let worker!: ReturnType<typeof harness>;
		worker = harness(t, {
			beforeGenerate: (index) => {
				if (index !== 1) return;
				if (stop === "cancel") worker.send({ schema: SCHEMA, type: "cancel" });
				else worker.input.emit("end");
			},
		});
		worker.send(startRequest(worker.paths, { chunks: ["Uno.", "Dos.", "Tres."] }));
		await worker.done;
		assert.ok(worker.engines[0]!.calls.length <= 2, stop);
		assert.ok(!worker.types().includes("done"), stop);
		assert.equal(existsSync(worker.engines[0]!.config.model.kokoro.dataDir), false, stop);
		assert.equal(worker.exitCode(), 0, stop);
	}
});

test("a termination signal ends the worker and still removes the espeak tree", async (t) => {
	let worker!: ReturnType<typeof harness>;
	worker = harness(t, { beforeGenerate: (index) => { if (index === 1) worker.terminate(); } });
	worker.send(startRequest(worker.paths, { chunks: ["Uno.", "Dos.", "Tres."] }));
	await worker.done;
	assert.ok(!worker.types().includes("done"));
	assert.equal(existsSync(worker.engines[0]!.config.model.kokoro.dataDir), false);
	assert.equal(worker.exitCode(), 0);
});

// --- Piper voices --------------------------------------------------------------------

function piperRequest(paths: Install, overrides: Record<string, unknown> = {}) {
	return startRequest(paths, {
		kind: "piper",
		core: { root: paths.piper, files: sized(paths.piper, ["es_ES-miro-high.onnx", "tokens.txt"]) },
		sid: 0,
		...overrides,
	});
}

test("a Piper request loads its VITS model with the assembled phoneme tree and speaks each chunk", async (t) => {
	const worker = harness(t);
	worker.send(piperRequest(worker.paths));
	await worker.done;
	assert.deepEqual(worker.types(), ["audio", "audio", "done"]);
	const [engine] = worker.engines;
	assert.equal(engine!.config.model.kokoro, undefined);
	const { vits } = engine!.config.model;
	assert.equal(vits.model, join(worker.paths.piper, "es_ES-miro-high.onnx"));
	assert.equal(vits.tokens, join(worker.paths.piper, "tokens.txt"));
	assert.deepEqual(engine!.dataDirSeen, { es: "lang es", phontab: "pt" });
	assert.equal(existsSync(vits.dataDir), false, "the tree is removed afterwards");
	assert.deepEqual(engine!.calls.map((call) => [call.text, call.sid, call.speed]), [["Hola.", 0, 1], ["¿Cómo andás?", 0, 1]]);
});

test("a Piper request needs exactly one model and its tokens, speaker 0, and a known kind", async (t) => {
	const paths = install(t);
	const cases: Array<[string, Record<string, unknown>]> = [
		["no tokens", { core: { root: paths.piper, files: sized(paths.piper, ["es_ES-miro-high.onnx"]) } }],
		["no model", { core: { root: paths.piper, files: sized(paths.piper, ["tokens.txt"]) } }],
		["another speaker", { sid: 1 }],
		["unknown kind", { kind: "festival" }],
	];
	for (const [name, overrides] of cases) {
		const worker = harness(t);
		worker.send(piperRequest(worker.paths, overrides));
		await worker.done;
		assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "invalid-request" }], name);
		assert.deepEqual(worker.loaded, [], name);
	}
});
