import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The voice worker (S1-S3) runs in its own process; here its entry function is
// driven in-process with fake capture and recognizer modules, so no native code
// or microphone is ever touched. The installed files it validates are real
// files in an owned scratch directory under tmp/.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { runVoiceWorker } = createRequire(import.meta.url)("../scripts/voice-worker.cjs");

const SCHEMA = "gentle.voice/v1";
const SHERPA_ENTRY = "node_modules/sherpa-onnx-node/non-streaming-asr.js";
const CPAL_ENTRY = "node_modules/node-cpal/index.js";
const PULSE_ENTRY = "node_modules/node-cpal/backend-pulseaudio.js";
const PULSE_NATIVE = "node_modules/node-cpal/bin/backend-pulseaudio/linux-x64/index.node";
const NATIVE = "node_modules/sherpa-onnx-linux-x64/sherpa-onnx.node";
const uid = typeof process.getuid === "function" ? process.getuid() : undefined;

interface Install {
	runtimeRoot: string;
	modelRoot: string;
	modelFiles: Record<string, { name: string; size: number; sha256: string }>;
}

function install(t: test.TestContext): Install {
	const base = join(repoRoot, "tmp");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "voice-worker-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const runtimeRoot = join(dir, "runtime");
	for (const file of [SHERPA_ENTRY, CPAL_ENTRY, NATIVE, PULSE_ENTRY, PULSE_NATIVE]) {
		mkdirSync(dirname(join(runtimeRoot, file)), { recursive: true });
		writeFileSync(join(runtimeRoot, file), `// ${file}\n`);
	}
	const modelRoot = join(dir, "model");
	mkdirSync(modelRoot);
	const modelFiles: Install["modelFiles"] = {};
	for (const [role, name] of [["encoder", "encoder.int8.onnx"], ["decoder", "decoder.int8.onnx"], ["joiner", "joiner.int8.onnx"], ["tokens", "tokens.txt"]]) {
		const data = Buffer.from(`${role} weights`);
		writeFileSync(join(modelRoot, name), data);
		modelFiles[role] = { name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
	}
	return { runtimeRoot, modelRoot, modelFiles };
}

function startRequest(paths: Install, overrides: Record<string, unknown> = {}) {
	return {
		schema: SCHEMA,
		type: "start",
		target: "linux-x64",
		maxRecordingMs: 120_000,
		numThreads: 2,
		runtime: { root: paths.runtimeRoot, files: [SHERPA_ENTRY, CPAL_ENTRY, NATIVE] },
		model: { root: paths.modelRoot, files: paths.modelFiles },
		...overrides,
	};
}

interface FakeStream {
	options: { config: { sampleRate: number; channels: number; sampleFormat: string }; onData(data: ArrayBufferView): void; onError(error: unknown): void; autoStart: boolean };
	closes: number;
	close(): Promise<void>;
}

interface FakeOptions {
	device?: unknown;
	defaults?: { sampleRate: number; channels: number; sampleFormat: string };
	formats?: string[];
	loadError?: string;
	recognizerError?: string;
	text?: string;
}

function harness(t: test.TestContext, fake: FakeOptions = {}, io: Record<string, unknown> = {}) {
	const paths = install(t);
	const input = new EventEmitter();
	const messages: Array<Record<string, unknown>> = [];
	const raw: string[] = [];
	const loaded: string[] = [];
	const streams: FakeStream[] = [];
	const recognizers: Array<{ config: any; waves: Array<{ sampleRate: number; samples: Float32Array }>; decodes: number }> = [];
	let exitCode: number | undefined;
	const convenience = {
		getDefaultInputDevice: () => ("device" in fake ? fake.device : { deviceId: "default-input" }),
		getDefaultInputConfig: () => fake.defaults ?? { sampleRate: 48000, channels: 2, sampleFormat: "i16" },
		getSupportedFormats: () => fake.formats ?? ["i16"],
		createInputStream: async (options: FakeStream["options"]) => {
			const stream: FakeStream = { options, closes: 0, close: async () => void stream.closes++ };
			streams.push(stream);
			return stream;
		},
	};
	class OfflineRecognizer {
		config: any;
		waves: Array<{ sampleRate: number; samples: Float32Array }> = [];
		decodes = 0;
		constructor(config: unknown) {
			if (fake.recognizerError) throw new Error(fake.recognizerError);
			this.config = config;
			recognizers.push(this);
		}
		createStream() {
			return { acceptWaveform: (wave: { sampleRate: number; samples: Float32Array }) => this.waves.push(wave) };
		}
		decode() {
			this.decodes++;
		}
		getResult() {
			return { text: fake.text ?? "  hello world  " };
		}
	}
	const done: Promise<void> = runVoiceWorker({
		input,
		write: (line: string) => {
			raw.push(line);
			messages.push(JSON.parse(line));
		},
		exit: (code: number) => {
			exitCode = code;
		},
		loadModule: (file: string) => {
			loaded.push(file);
			if (fake.loadError) throw new Error(fake.loadError);
			if (file === join(paths.runtimeRoot, ...SHERPA_ENTRY.split("/"))) return { OfflineRecognizer };
			if ([CPAL_ENTRY, PULSE_ENTRY].some((entry) => file === join(paths.runtimeRoot, ...entry.split("/")))) return { convenience };
			throw new Error(`unexpected module ${file}`);
		},
		platform: "linux",
		arch: "x64",
		nodeVersion: "22.12.0",
		uid,
		...io,
	});
	const send = (message: unknown) => input.emit("data", `${typeof message === "string" ? message : JSON.stringify(message)}\n`);
	const waitFor = async (predicate: () => boolean, label = "condition") => {
		for (let i = 0; i < 500 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.ok(predicate(), `timed out waiting for ${label}; messages: ${JSON.stringify(messages)}`);
	};
	const types = () => messages.map((message) => message.type);
	return { paths, input, messages, raw, loaded, streams, recognizers, done, send, waitFor, types, exitCode: () => exitCode };
}

test("WSL uses the shipped PulseAudio backend without loading ALSA", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.18-microsoft-standard-WSL2" });
	h.send(startRequest(h.paths));
	await h.waitFor(() => h.types().includes("recording"));
	h.send({ schema: SCHEMA, type: "cancel" });
	await h.done;
	assert.deepEqual(h.loaded, [join(h.paths.runtimeRoot, PULSE_ENTRY)]);
	assert.equal(h.streams[0].closes, 1);
});

test("ordinary Linux keeps the default capture backend", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.8.0-generic" });
	h.send(startRequest(h.paths));
	await h.waitFor(() => h.types().includes("recording"));
	h.send({ schema: SCHEMA, type: "cancel" });
	await h.done;
	assert.deepEqual(h.loaded, [join(h.paths.runtimeRoot, CPAL_ENTRY)]);
});

test("WSL refuses an incomplete PulseAudio backend before native loading", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.18-microsoft-standard-WSL2" });
	rmSync(join(h.paths.runtimeRoot, PULSE_NATIVE));
	h.send(startRequest(h.paths));
	await h.done;
	assert.deepEqual(h.loaded, []);
	assert.deepEqual(h.messages, [{ schema: SCHEMA, type: "error", code: "runtime-invalid" }]);
	assert.equal(h.exitCode(), 1);
});

const interleaved = (frames: number, channels: number, value: (frame: number, channel: number) => number) => {
	const data = new Int16Array(frames * channels);
	for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) data[frame * channels + channel] = value(frame, channel);
	return data;
};

test("WSL uses the shipped PulseAudio backend without loading ALSA", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.18-microsoft-standard-WSL2" });
	h.send(startRequest(h.paths));
	await h.waitFor(() => h.types().includes("recording"));
	h.send({ schema: SCHEMA, type: "cancel" });
	await h.done;
	assert.deepEqual(h.loaded, [join(h.paths.runtimeRoot, PULSE_ENTRY)]);
	assert.equal(h.streams[0].closes, 1);
});

test("ordinary Linux keeps the default capture backend", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.8.0-generic" });
	h.send(startRequest(h.paths));
	await h.waitFor(() => h.types().includes("recording"));
	h.send({ schema: SCHEMA, type: "cancel" });
	await h.done;
	assert.deepEqual(h.loaded, [join(h.paths.runtimeRoot, CPAL_ENTRY)]);
});

test("WSL refuses an incomplete PulseAudio backend before native loading", async (t) => {
	const h = harness(t, {}, { kernelRelease: "6.18-microsoft-standard-WSL2" });
	rmSync(join(h.paths.runtimeRoot, PULSE_NATIVE));
	h.send(startRequest(h.paths));
	await h.done;
	assert.deepEqual(h.loaded, []);
	assert.deepEqual(h.messages, [{ schema: SCHEMA, type: "error", code: "runtime-invalid" }]);
	assert.equal(h.exitCode(), 1);
});

test("records multichannel audio, resamples it to 16 kHz mono and closes its retained stream once on stop", async (t) => {
	const worker = harness(t);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	assert.deepEqual(stream!.options.config, { sampleRate: 48000, channels: 2, sampleFormat: "i16" });
	assert.equal(stream!.options.autoStart, true);

	// Left at half scale, right silent: the mono downmix is a quarter scale.
	stream!.options.onData(interleaved(4800, 2, (_frame, channel) => (channel === 0 ? 16384 : 0)));
	stream!.options.onData(interleaved(4800, 2, (_frame, channel) => (channel === 0 ? 16384 : 0)));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.done;
	stream!.options.onData(interleaved(4800, 2, () => 32767));

	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "result", text: "hello world", truncated: false });
	assert.equal(stream!.closes, 1);
	assert.equal(worker.exitCode(), 0);
	const config = worker.recognizers[0]!.config;
	assert.equal(config.modelConfig.modelType, "nemo_transducer");
	assert.equal(config.modelConfig.transducer.encoder, join(worker.paths.modelRoot, "encoder.int8.onnx"));
	assert.equal(config.modelConfig.tokens, join(worker.paths.modelRoot, "tokens.txt"));
	assert.deepEqual(config.featConfig, { sampleRate: 16000, featureDim: 80 });
	const [wave] = worker.recognizers[0]!.waves;
	assert.equal(wave!.sampleRate, 16000);
	assert.equal(wave!.samples.length, 3200);
	assert.ok(wave!.samples.every((sample) => Math.abs(sample - 0.25) < 1e-6));
});

test("prefers float input and transcribes on its own when the recording limit is reached", async (t) => {
	const worker = harness(t, { defaults: { sampleRate: 8000, channels: 1, sampleFormat: "i16" }, formats: ["i16", "f32"] });
	worker.send(startRequest(worker.paths, { maxRecordingMs: 1000 }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	assert.equal(stream!.options.config.sampleFormat, "f32");
	stream!.options.onData(new Float32Array(6000).fill(0.5));
	stream!.options.onData(new Float32Array(6000).fill(0.5));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.equal(worker.messages.at(-1)!.truncated, true);
	// 8000 samples kept at 8 kHz, upsampled to one second at 16 kHz.
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 16000);
	assert.equal(stream!.closes, 1);
});

test("cancel closes capture, discards the audio and reports nothing", async (t) => {
	const worker = harness(t);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	stream!.options.onData(interleaved(9600, 2, () => 1000));
	worker.send({ schema: SCHEMA, type: "cancel" });
	await worker.done;
	stream!.options.onData(interleaved(9600, 2, () => 1000));
	worker.send({ schema: SCHEMA, type: "stop" });
	assert.deepEqual(worker.types(), ["recording"]);
	assert.equal(worker.recognizers.length, 0, "the recognizer is never created for a cancelled session");
	assert.ok(!worker.loaded.some((file) => file.endsWith("non-streaming-asr.js")));
	assert.equal(stream!.closes, 1);
	assert.equal(worker.exitCode(), 0);
});

test("a closed stdin ends the session like a cancel", async (t) => {
	const worker = harness(t);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.input.emit("end");
	await worker.done;
	assert.deepEqual(worker.types(), ["recording"]);
	assert.equal(worker.streams[0]!.closes, 1);
});

test("rejects malformed and unknown requests before loading anything", async (t) => {
	const cases: Array<(paths: Install) => unknown> = [
		() => "not json",
		(paths) => ({ ...startRequest(paths), extra: true }),
		(paths) => startRequest(paths, { runtime: { root: "relative/runtime", files: [SHERPA_ENTRY, CPAL_ENTRY] } }),
		(paths) => startRequest(paths, { runtime: { root: paths.runtimeRoot, files: [SHERPA_ENTRY] } }),
		(paths) => startRequest(paths, { runtime: { root: paths.runtimeRoot, files: [SHERPA_ENTRY, CPAL_ENTRY, "../outside.js"] } }),
		(paths) => startRequest(paths, { target: "win32-arm64" }),
		(paths) => startRequest(paths, { maxRecordingMs: 10 }),
		() => ({ schema: SCHEMA, type: "stop" }),
	];
	for (const [index, request] of cases.entries()) {
		await t.test(`case ${index}`, async (st) => {
			const worker = harness(st);
			worker.send(request(worker.paths));
			await worker.done;
			assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "invalid-request" }]);
			assert.deepEqual(worker.loaded, []);
			assert.equal(worker.exitCode(), 1);
		});
	}
});

test("refuses runtime links, missing runtime files and a foreign target before native loading", async (t) => {
	const cases: Array<[string, (paths: Install) => Record<string, unknown> | void, string]> = [
		["symlinked runtime file", (paths) => {
			rmSync(join(paths.runtimeRoot, NATIVE));
			symlinkSync(join(paths.modelRoot, "tokens.txt"), join(paths.runtimeRoot, NATIVE));
		}, "runtime-invalid"],
		["missing runtime file", (paths) => rmSync(join(paths.runtimeRoot, CPAL_ENTRY)), "runtime-invalid"],
		["other target", () => ({ target: "darwin-arm64" }), "runtime-invalid"],
	];
	for (const [name, tamper, code] of cases) {
		await t.test(name, async (st) => {
			const worker = harness(st);
			const overrides = (tamper(worker.paths) as Record<string, unknown> | undefined) ?? {};
			worker.send(startRequest(worker.paths, overrides));
			await worker.done;
			assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code }]);
			assert.deepEqual(worker.loaded, []);
		});
	}
});

test("reports native load failures by code only, never their private detail", async (t) => {
	for (const [fake, code] of [[{ loadError: "dlopen failed: /home/someone/.secret/voice/sherpa-onnx.node TOKEN=abc" }, "runtime-load"], [{ recognizerError: "cannot read /home/someone/model" }, "model-load"]] as const) {
		await t.test(code, async (st) => {
			const worker = harness(st, fake);
			worker.send(startRequest(worker.paths));
			if (code === "model-load") {
				// The recognizer is loaded only after stop.
				await worker.waitFor(() => worker.types().includes("recording"));
				worker.streams[0]!.options.onData(interleaved(4800, 2, () => 1000));
				worker.send({ schema: SCHEMA, type: "stop" });
			}
			await worker.done;
			assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "error", code });
			assert.deepEqual(worker.types(), code === "model-load" ? ["recording", "transcribing", "error"] : ["error"]);
			assert.ok(!worker.raw.join("").includes("someone"));
			assert.ok(!worker.raw.join("").includes(worker.paths.runtimeRoot));
		});
	}
});

test("reports a missing microphone, an unusable format and empty audio", async (t) => {
	const cases: Array<[FakeOptions, string, boolean]> = [
		[{ device: null }, "no-input-device", false],
		[{ defaults: { sampleRate: 48000, channels: 1, sampleFormat: "i64" }, formats: ["i64"] }, "unsupported-input", false],
		[{}, "empty-audio", true],
	];
	for (const [fake, code, stop] of cases) {
		await t.test(code, async (st) => {
			const worker = harness(st, fake);
			worker.send(startRequest(worker.paths));
			if (stop) {
				await worker.waitFor(() => worker.types().includes("recording"));
				worker.streams[0]!.options.onData(interleaved(100, 2, () => 1000));
				worker.send({ schema: SCHEMA, type: "stop" });
			}
			await worker.done;
			assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "error", code });
			assert.equal(worker.exitCode(), 1);
			for (const stream of worker.streams) assert.equal(stream.closes, 1);
		});
	}
});

// node-cpal reports stream errors as CpalError objects with a string code.
const cpalError = (code: string, message: string) => Object.assign(new Error(message), { code });

test("a buffer underrun or overrun keeps capturing and the dictation is still transcribed", async (t) => {
	const worker = harness(t);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	// WASAPI reports one before the first buffer on some devices; others may report one between buffers.
	stream!.options.onError(cpalError("XRUN", "A buffer underrun or overrun occurred."));
	stream!.options.onData(interleaved(4800, 2, () => 16384));
	stream!.options.onError(cpalError("XRUN", "A buffer underrun or overrun occurred."));
	stream!.options.onData(interleaved(4800, 2, () => 16384));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.equal(worker.messages.at(-1)!.text, "hello world");
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 3200);
	assert.equal(stream!.closes, 1);
	assert.equal(worker.exitCode(), 0);
});

test("any other stream error ends the session with capture", async (t) => {
	for (const error of [cpalError("DEVICE_NOT_AVAILABLE", "The requested audio device is not available."), cpalError("OTHER", "backend failure"), new Error("no code"), undefined]) {
		await t.test(String(error?.message), async (st) => {
			const worker = harness(st);
			worker.send(startRequest(worker.paths));
			await worker.waitFor(() => worker.types().includes("recording"));
			const [stream] = worker.streams;
			stream!.options.onData(interleaved(4800, 2, () => 16384));
			stream!.options.onError(error);
			await worker.done;
			assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "error", code: "capture" });
			assert.equal(worker.exitCode(), 1);
			assert.equal(stream!.closes, 1);
			assert.equal(worker.recognizers.length, 0);
		});
	}
});

test("refuses to run on Node older than 22", async (t) => {
	const worker = harness(t, {}, { nodeVersion: "20.18.0" });
	await worker.done;
	assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "node-version" }]);
	assert.deepEqual(worker.loaded, []);
});

// --- capture before model verification (T4) -----------------------------------

const isSherpa = (file: string) => file.endsWith("non-streaming-asr.js");
const isCpal = (file: string) => file.endsWith(join("node-cpal", "index.js"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// Reads model files through streams that deliver nothing until released, so a
// test controls exactly when model verification can finish.
function gatedReads() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const opened: string[] = [];
	const openRead = (file: string) => {
		opened.push(file);
		return Readable.from((async function* () {
			await gate;
			yield readFileSync(file);
		})());
	};
	return { openRead, opened, release };
}

test("capture opens and reports recording before the model is verified; sherpa loads only after stop and verification", async (t) => {
	const reads = gatedReads();
	const worker = harness(t, {}, { openRead: reads.openRead });
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	assert.equal(worker.streams.length, 1, "capture is open");
	assert.equal(worker.loaded.length, 1);
	assert.ok(isCpal(worker.loaded[0]!), "only node-cpal is loaded while recording");
	// Recording is reported before verification starts; the first digest read
	// opens asynchronously while recording, so wait for it instead of racing
	// the model tree walk (#2435).
	await worker.waitFor(() => reads.opened.length >= 1, "model digests are streamed while recording");
	// Audio captured during verification is kept.
	worker.streams[0]!.options.onData(interleaved(4800, 2, (_frame, channel) => (channel === 0 ? 16384 : 0)));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.waitFor(() => worker.types().includes("transcribing"));
	await settle();
	assert.equal(worker.streams[0]!.closes, 1, "capture stops at once on stop");
	assert.ok(!worker.loaded.some(isSherpa), "no sherpa load before every digest matched");
	assert.equal(worker.recognizers.length, 0);
	reads.release();
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.ok(isSherpa(worker.loaded[1]!));
	assert.equal(reads.opened.length, 4, "every model file was hashed");
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 1600);
	assert.equal(worker.exitCode(), 0);
});

test("a model digest mismatch found while recording closes capture, reports model-invalid and never loads sherpa", async (t) => {
	const worker = harness(t);
	writeFileSync(join(worker.paths.modelRoot, "joiner.int8.onnx"), "JOINER weights");
	worker.send(startRequest(worker.paths));
	await worker.done;
	assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "recording" }, { schema: SCHEMA, type: "error", code: "model-invalid" }]);
	assert.equal(worker.streams[0]!.closes, 1);
	assert.ok(!worker.loaded.some(isSherpa));
	assert.equal(worker.recognizers.length, 0);
	assert.equal(worker.exitCode(), 1);
});

test("an invalid model tree is reported while recording and never loads sherpa", async (t) => {
	const worker = harness(t);
	symlinkSync(worker.paths.runtimeRoot, join(worker.paths.modelRoot, "linked"));
	worker.send(startRequest(worker.paths));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "error"]);
	assert.equal(worker.messages.at(-1)!.code, "model-invalid");
	assert.ok(!worker.loaded.some(isSherpa));
});

test("a mismatch found after stop reports model-invalid instead of a transcript", async (t) => {
	const reads = gatedReads();
	const worker = harness(t, {}, { openRead: reads.openRead });
	writeFileSync(join(worker.paths.modelRoot, "joiner.int8.onnx"), "JOINER weights");
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.streams[0]!.options.onData(interleaved(4800, 2, () => 1000));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.waitFor(() => worker.types().includes("transcribing"));
	reads.release();
	await worker.done;
	assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "error", code: "model-invalid" });
	assert.ok(!worker.loaded.some(isSherpa));
	assert.equal(worker.recognizers.length, 0);
});

test("cancel during model verification discards everything, stops hashing and never loads sherpa", async (t) => {
	const reads = gatedReads();
	const worker = harness(t, {}, { openRead: reads.openRead });
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.streams[0]!.options.onData(interleaved(4800, 2, () => 1000));
	// Cancel must interrupt a digest that is actually in flight: wait for the
	// first model read to open, otherwise an early cancel is indistinguishable
	// from verification that never started (#2435).
	await worker.waitFor(() => reads.opened.length === 1, "the first digest read is in flight");
	worker.send({ schema: SCHEMA, type: "cancel" });
	await worker.done;
	reads.release();
	await settle();
	worker.send({ schema: SCHEMA, type: "stop" });
	await settle();
	assert.deepEqual(worker.types(), ["recording"]);
	assert.equal(worker.streams[0]!.closes, 1);
	assert.ok(!worker.loaded.some(isSherpa));
	assert.equal(reads.opened.length, 1, "no further model file is opened after cancel");
	assert.equal(worker.exitCode(), 0);
});

test("the recording limit during verification transcribes once the model is verified", async (t) => {
	const reads = gatedReads();
	const worker = harness(t, { defaults: { sampleRate: 8000, channels: 1, sampleFormat: "f32" }, formats: ["f32"] }, { openRead: reads.openRead });
	worker.send(startRequest(worker.paths, { maxRecordingMs: 1000 }));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.streams[0]!.options.onData(new Float32Array(9000).fill(0.5));
	await worker.waitFor(() => worker.types().includes("transcribing"));
	assert.ok(!worker.loaded.some(isSherpa));
	reads.release();
	await worker.done;
	assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "result", text: "hello world", truncated: true });
});

// --- end of speech (conversation mode, S2) ------------------------------------------

const ENDPOINT = { endOfSpeechMs: 500, noSpeechMs: 2000 };
const mono8k = { defaults: { sampleRate: 8000, channels: 1, sampleFormat: "f32" }, formats: ["f32"] };
const chunk = (ms: number, level: number) => new Float32Array((8000 * ms) / 1000).fill(level);

test("with an endpoint, silence after speech ends the recording and transcribes on its own", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: ENDPOINT }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	for (let i = 0; i < 2; i++) stream!.options.onData(chunk(100, 0));
	for (let i = 0; i < 5; i++) stream!.options.onData(chunk(100, 0.3));
	for (let i = 0; i < 4; i++) stream!.options.onData(chunk(100, 0.001));
	await settle();
	assert.deepEqual(worker.types(), ["recording"], "a pause shorter than the endpoint keeps recording");
	stream!.options.onData(chunk(100, 0.3));
	for (let i = 0; i < 5; i++) stream!.options.onData(chunk(100, 0));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.equal(worker.messages.at(-1)!.truncated, false);
	assert.equal(stream!.closes, 1);
	// Everything up to the end of speech is transcribed, upsampled to 16 kHz.
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 2 * 8000 * 1.7);
});

test("with an endpoint, a steady noise floor is not speech and ends as no speech", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: ENDPOINT }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	for (let i = 0; i < 19; i++) stream!.options.onData(chunk(100, 0.02));
	await settle();
	assert.deepEqual(worker.types(), ["recording"]);
	stream!.options.onData(chunk(100, 0.02));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	// The model can hallucinate a word from noise ("Yeah."): with no speech
	// heard, nothing is decoded and the transcript is blank.
	assert.equal(worker.messages.at(-1)!.text, "");
	assert.deepEqual(worker.recognizers, [], "the recognizer is never loaded for noise");
});

test("with an endpoint, a recording stopped by the shortcut before any speech is blank too", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: ENDPOINT }));
	await worker.waitFor(() => worker.types().includes("recording"));
	for (let i = 0; i < 5; i++) worker.streams[0]!.options.onData(chunk(100, 0.002));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.done;
	assert.equal(worker.messages.at(-1)!.text, "");
	assert.deepEqual(worker.recognizers, []);
});

test("without an endpoint, silence never ends the recording", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	stream!.options.onData(chunk(500, 0.3));
	for (let i = 0; i < 30; i++) stream!.options.onData(chunk(100, 0));
	await settle();
	assert.deepEqual(worker.types(), ["recording"]);
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
});

test("rejects an endpoint outside its bounds or with unknown fields before loading anything", async (t) => {
	for (const endpoint of [{ endOfSpeechMs: 100, noSpeechMs: 2000 }, { endOfSpeechMs: 500, noSpeechMs: 120_000 }, { endOfSpeechMs: 500 }, { ...ENDPOINT, extra: 1 }, "500"]) {
		const worker = harness(t, mono8k);
		worker.send(startRequest(worker.paths, { endpoint }));
		await worker.done;
		assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "invalid-request" }], JSON.stringify(endpoint));
		assert.deepEqual(worker.loaded, []);
	}
});

test("with an endpoint, quiet speech over a low-gain microphone floor still counts as speech", async (t) => {
	// Levels measured on a WSLg microphone: a floor near 0.002, speech a few times louder.
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: ENDPOINT }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	for (let i = 0; i < 3; i++) stream!.options.onData(chunk(100, 0.002));
	for (let i = 0; i < 5; i++) stream!.options.onData(chunk(100, 0.008));
	for (let i = 0; i < 5; i++) stream!.options.onData(chunk(100, 0.0025));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 2 * 8000 * 1.3, "it ended at the end of speech, not at the no-speech limit");
});

test("with an endpoint, brief ambient spikes in 10 ms chunks do not keep the recording open", async (t) => {
	// Levels measured on the RDP microphone in WSLg on 2026-11-02 while nobody
	// spoke: 10 ms chunks between 0.001 and 0.002 RMS, with one chunk reaching
	// 0.004 about every half second. Speech measured 0.016 to 0.059.
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	const ambient = (ms: number) => {
		for (let i = 0; i < ms / 10; i++) stream!.options.onData(chunk(10, i % 50 === 25 ? 0.004 : i % 2 ? 0.0012 : 0.0019));
	};
	ambient(200);
	for (let i = 0; i < 50; i++) stream!.options.onData(chunk(10, 0.05));
	ambient(1200);
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 2 * 8000 * 1.9, "it ended 1.2 s after the speech, spikes notwithstanding");
});

test("with an endpoint, one isolated loud window during the pause is forgiven, the speech tail is not", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: { endOfSpeechMs: 1200, noSpeechMs: 8000 } }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	for (let i = 0; i < 2; i++) stream!.options.onData(chunk(100, 0));
	for (let i = 0; i < 5; i++) stream!.options.onData(chunk(100, 0.3));
	for (let i = 0; i < 4; i++) stream!.options.onData(chunk(100, 0));
	stream!.options.onData(chunk(100, 0.3));
	for (let i = 0; i < 7; i++) stream!.options.onData(chunk(100, 0));
	await worker.done;
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result"]);
	// 1.2 s of quiet counted from the last speech window, the 100 ms click in
	// the middle forgiven; without the forgiveness it would run to 2.4 s.
	assert.equal(worker.recognizers[0]!.waves[0]!.samples.length, 2 * 8000 * 1.9);
});

test("with an endpoint, ambient spikes alone never count as speech", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths, { endpoint: { endOfSpeechMs: 1200, noSpeechMs: 2000 } }));
	await worker.waitFor(() => worker.types().includes("recording"));
	const [stream] = worker.streams;
	for (let i = 0; i < 200; i++) stream!.options.onData(chunk(10, i % 50 === 25 ? 0.004 : i % 2 ? 0.0012 : 0.0019));
	await worker.done;
	assert.equal(worker.messages.at(-1)!.text, "", "no speech was heard, so nothing is decoded");
	assert.deepEqual(worker.recognizers, []);
});

// --- warm worker (S11) ----------------------------------------------------------------

test("a warm worker answers several recordings, verifying and loading the model only once", async (t) => {
	const reads = gatedReads();
	reads.release();
	const worker = harness(t, mono8k, { openRead: reads.openRead });
	const record = async (index: number) => {
		await worker.waitFor(() => worker.streams.length === index + 1, `stream ${index}`);
		await worker.waitFor(() => worker.types().filter((type) => type === "recording").length === index + 1, `recording ${index}`);
		worker.streams[index]!.options.onData(chunk(500, 0.3));
		worker.send({ schema: SCHEMA, type: "stop" });
		await worker.waitFor(() => worker.types().filter((type) => type === "result").length === index + 1, `result ${index}`);
	};
	worker.send(startRequest(worker.paths, { keepAlive: true }));
	await record(0);
	assert.equal(worker.exitCode(), undefined, "the worker stays alive after a result");
	assert.equal(worker.streams[0]!.closes, 1, "the microphone is released between recordings");
	const firstReads = reads.opened.length;
	worker.send(startRequest(worker.paths, { keepAlive: true }));
	await record(1);
	assert.equal(reads.opened.length, firstReads, "the model digests are not checked again");
	assert.equal(worker.recognizers.length, 1, "the recognizer is loaded once");
	assert.equal(worker.recognizers[0]!.decodes, 2);
	assert.equal(worker.loaded.filter(isSherpa).length, 1, "sherpa-onnx is loaded once");
	worker.send({ schema: SCHEMA, type: "close" });
	await worker.done;
	assert.equal(worker.exitCode(), 0);
	assert.deepEqual(worker.types(), ["recording", "transcribing", "result", "recording", "transcribing", "result"]);
});

test("a warm worker refuses close while recording", async (t) => {
	const reads = gatedReads();
	reads.release();
	const worker = harness(t, mono8k, { openRead: reads.openRead });
	worker.send(startRequest(worker.paths, { keepAlive: true }));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.send({ schema: SCHEMA, type: "close" });
	await worker.done;
	assert.deepEqual(worker.messages.at(-1), { schema: SCHEMA, type: "error", code: "invalid-request" });
});

test("without keepAlive a worker still exits after its result, and close before any start ends it quietly", async (t) => {
	const worker = harness(t, mono8k);
	worker.send(startRequest(worker.paths));
	await worker.waitFor(() => worker.types().includes("recording"));
	worker.streams[0]!.options.onData(chunk(500, 0.3));
	worker.send({ schema: SCHEMA, type: "stop" });
	await worker.done;
	assert.equal(worker.exitCode(), 0);
	const idle = harness(t, mono8k);
	idle.send({ schema: SCHEMA, type: "close" });
	await idle.done;
	assert.deepEqual(idle.messages, []);
	assert.equal(idle.exitCode(), 0);
});

test("keepAlive must be exactly true when present", async (t) => {
	for (const keepAlive of [false, "true", 1]) {
		const worker = harness(t, mono8k);
		worker.send(startRequest(worker.paths, { keepAlive }));
		await worker.done;
		assert.deepEqual(worker.messages, [{ schema: SCHEMA, type: "error", code: "invalid-request" }], String(keepAlive));
	}
});
