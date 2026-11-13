"use strict";
// Voice dictation worker (S1-S3). lib/voice-session.ts runs this file as its own
// Node process, so capture callbacks, the blocking recognizer load and the decode
// never run inside Gentle AI. It speaks JSON lines: stdin receives one `start`
// request, then `stop` or `cancel`; stdout carries `recording`, `transcribing`,
// and one final `result` or `error`. A start request that asks for `levels`
// also gets `level` messages while recording: the microphone RMS every 50 ms of
// audio, for an overlay to draw. Errors carry a closed code only, never a
// message, path or native error text.
//
// Capture starts as soon as the runtime files pass validation and node-cpal is
// loaded, so the first words are recorded. The model digests are then verified
// while recording, by streamed hashing that never blocks capture for long.
// sherpa-onnx and the model are loaded only after every digest matched and stop
// arrived; their synchronous load would stall capture callbacks. A mismatch
// found while recording ends the session with model-invalid at once.
//
// The optional native packages are loaded only after the files they come from
// pass validation, and only from the roots in the start request, which the
// parent computes from its pinned manifests. The validation refuses links, special
// files, foreign owners and digest mismatches; it does not make the install
// tamper-proof against the same user, who can replace the files at any time.

const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { lstat, readdir } = require("node:fs/promises");
const path = require("node:path");
const { release } = require("node:os");
const { addAbortSignal } = require("node:stream");

const SCHEMA = "gentle.voice/v1";
const TARGETS = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64", "win32-x64"];
const MODEL_ROLES = ["encoder", "decoder", "joiner", "tokens"];
// The only runtime files ever loaded; sherpa-onnx and the default capture
// facade must be listed as required files, the PulseAudio facade is required
// only where it is selected.
const SHERPA_ENTRY = "node_modules/sherpa-onnx-node/non-streaming-asr.js";
const CPAL_ENTRY = "node_modules/node-cpal/index.js";
// The keyword spotter of the same runtime, loaded only when a start asks for it.
const KWS_ENTRY = "node_modules/sherpa-onnx-node/keyword-spotter.js";
// The PulseAudio facade loads its own native file: bin/backend-pulseaudio/<target>/index.node.
const PULSE_ENTRY = "node_modules/node-cpal/backend-pulseaudio.js";
const pulseNative = (target) => `node_modules/node-cpal/bin/backend-pulseaudio/${target}/index.node`;
const MAX_INPUT_LINE = 64 * 1024;
const MAX_TREE_ENTRIES = 256;
const MAX_TEXT = 16 * 1024;
const TARGET_RATE = 16000;
// Less than a tenth of a second of audio is treated as no audio at all.
const MIN_SECONDS = 0.1;
const SAFE_SEGMENT = /^[A-Za-z0-9@_][A-Za-z0-9._@+-]*$/;
// Integer formats are scaled to [-1, 1]; unsigned formats are centred first.
const SAMPLE_FORMATS = {
	f32: { offset: 0, scale: 1 },
	f64: { offset: 0, scale: 1 },
	i8: { offset: 0, scale: 128 },
	i16: { offset: 0, scale: 32768 },
	i24: { offset: 0, scale: 8388608 },
	i32: { offset: 0, scale: 2147483648 },
	u8: { offset: 128, scale: 128 },
	u16: { offset: 32768, scale: 32768 },
	u32: { offset: 2147483648, scale: 2147483648 },
};

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
const isSafeRelative = (value) => typeof value === "string" && value.split("/").every((segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment));
const isInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

const START_KEYS = ["schema", "type", "target", "maxRecordingMs", "numThreads", "runtime", "model"];

const KWS_KEYS = ["model", "keywords", "boost", "threshold", "maxActivePaths", "trailingBlanks"];
const KWS_MAX_KEYWORDS = 16;
// What a hit is reported as: a short opaque id such as "voice-off".
const KWS_COMMAND = /^[a-z][a-z0-9-]{0,31}$/;
// One keyword spelling: token pieces separated by spaces. The characters the
// spotter reads as per-line modifiers (":" boost, "#" threshold, "@" label)
// and line breaks are refused, so a line can only ever name its own command.
const KWS_TOKENS = /^[^\s:#@][^\r\n:#@]{0,255}$/;
const isNumber = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

// The keyword option of a start request (S7): the spotter model with its
// digests, the keyword lines with the command each stands for, and the tuning.
function parseKws(kws) {
	if (!hasExactKeys(kws, KWS_KEYS)) fail("invalid-request");
	const { model, keywords } = kws;
	if (!hasExactKeys(model, ["root", "files"]) || typeof model.root !== "string" || !path.isAbsolute(model.root)) fail("invalid-request");
	if (!hasExactKeys(model.files, MODEL_ROLES)) fail("invalid-request");
	for (const role of MODEL_ROLES) {
		const file = model.files[role];
		const valid = hasExactKeys(file, ["name", "size", "sha256"]) && isSafeRelative(file.name) && !file.name.includes("/") && isInteger(file.size, 1, Number.MAX_SAFE_INTEGER) && /^[0-9a-f]{64}$/.test(file.sha256);
		if (!valid) fail("invalid-request");
	}
	if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > KWS_MAX_KEYWORDS) fail("invalid-request");
	for (const keyword of keywords) {
		const valid = hasExactKeys(keyword, ["tokens", "command"]) && typeof keyword.tokens === "string" && KWS_TOKENS.test(keyword.tokens) && typeof keyword.command === "string" && KWS_COMMAND.test(keyword.command);
		if (!valid) fail("invalid-request");
	}
	if (!isNumber(kws.boost, 0, 10) || !isNumber(kws.threshold, 0.01, 1)) fail("invalid-request");
	if (!isInteger(kws.maxActivePaths, 1, 64) || !isInteger(kws.trailingBlanks, 1, 8)) fail("invalid-request");
}

function parseStart(message) {
	const withEndpoint = isRecord(message) && Object.hasOwn(message, "endpoint");
	const withKeepAlive = isRecord(message) && Object.hasOwn(message, "keepAlive");
	const withLevels = isRecord(message) && Object.hasOwn(message, "levels");
	const withKws = isRecord(message) && Object.hasOwn(message, "kws");
	const withSpot = isRecord(message) && Object.hasOwn(message, "spot");
	const keys = [...START_KEYS, ...(withEndpoint ? ["endpoint"] : []), ...(withKeepAlive ? ["keepAlive"] : []), ...(withLevels ? ["levels"] : []), ...(withKws ? ["kws"] : []), ...(withSpot ? ["spot"] : [])];
	if (!hasExactKeys(message, keys)) fail("invalid-request");
	// A spot-only capture listens for keywords and nothing else: it has no
	// transcript to end, so no endpoint, and no meter to feed.
	if (withSpot && (message.spot !== true || !withKws || withEndpoint || withLevels)) fail("invalid-request");
	// Opt-in as well: without it no spotter is loaded and nothing changes.
	if (withKws) parseKws(message.kws);
	// A warm worker stays alive after each result for the next recording.
	if (withKeepAlive && message.keepAlive !== true) fail("invalid-request");
	// Opt-in: without it the worker publishes exactly the messages it always did.
	if (withLevels && message.levels !== true) fail("invalid-request");
	if (withEndpoint) {
		const { endpoint } = message;
		if (!hasExactKeys(endpoint, ["endOfSpeechMs", "noSpeechMs"])) fail("invalid-request");
		if (!isInteger(endpoint.endOfSpeechMs, 300, 5000) || !isInteger(endpoint.noSpeechMs, 1000, 60000)) fail("invalid-request");
	}
	if (message.schema !== SCHEMA || message.type !== "start" || !TARGETS.includes(message.target)) fail("invalid-request");
	if (!isInteger(message.maxRecordingMs, 1000, 600000) || !isInteger(message.numThreads, 1, 8)) fail("invalid-request");
	const { runtime, model } = message;
	if (!hasExactKeys(runtime, ["root", "files"]) || !hasExactKeys(model, ["root", "files"])) fail("invalid-request");
	if (typeof runtime.root !== "string" || !path.isAbsolute(runtime.root) || typeof model.root !== "string" || !path.isAbsolute(model.root)) fail("invalid-request");
	const runtimeFiles = runtime.files;
	if (!Array.isArray(runtimeFiles) || runtimeFiles.length > MAX_TREE_ENTRIES || !runtimeFiles.every(isSafeRelative)) fail("invalid-request");
	if (!runtimeFiles.includes(SHERPA_ENTRY) || !runtimeFiles.includes(CPAL_ENTRY)) fail("invalid-request");
	if (!hasExactKeys(model.files, MODEL_ROLES)) fail("invalid-request");
	for (const role of MODEL_ROLES) {
		const file = model.files[role];
		const valid = hasExactKeys(file, ["name", "size", "sha256"]) && isSafeRelative(file.name) && !file.name.includes("/") && isInteger(file.size, 1, Number.MAX_SAFE_INTEGER) && /^[0-9a-f]{64}$/.test(file.sha256);
		if (!valid) fail("invalid-request");
	}
	return message;
}

// Walks an installed component and returns its regular files by relative path.
// Anything that is not a plain directory or regular file, is owned by another
// user, or is writable by everyone makes the whole component invalid. Ownership
// and modes are not checked on Windows, where Node reports neither.
async function readTree(root, uid, code) {
	const files = new Map();
	let entries = 0;
	const check = (info) => {
		if (uid !== undefined && (info.uid !== uid || (info.mode & 0o002) !== 0)) fail(code);
	};
	const rootInfo = await lstat(root).catch(() => fail(code));
	if (!rootInfo.isDirectory()) fail(code);
	check(rootInfo);
	const walk = async (directory, prefix) => {
		for (const name of await readdir(directory)) {
			if (++entries > MAX_TREE_ENTRIES) fail(code);
			const relative = prefix ? `${prefix}/${name}` : name;
			const info = await lstat(path.join(directory, name));
			check(info);
			if (info.isDirectory()) await walk(path.join(directory, name), relative);
			else if (info.isFile()) files.set(relative, info);
			else fail(code);
		}
	};
	await walk(root, "").catch((error) => {
		throw error instanceof WorkerFailure ? error : new WorkerFailure(code);
	});
	return files;
}

// Hashes a file chunk by chunk, so capture callbacks keep running in between.
function sha256(openRead, file, signal) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		addAbortSignal(signal, openRead(file))
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")));
	});
}

/**
 * Fails with `runtime-invalid` unless every file the request names, plus the
 * `extraFiles` a selected backend needs, exists in the validated runtime tree.
 */
async function validateRuntime(runtime, uid, extraFiles = []) {
	const files = await readTree(runtime.root, uid, "runtime-invalid");
	for (const required of [...runtime.files, ...extraFiles]) if (!files.has(required)) fail("runtime-invalid");
}

async function validateModel(model, uid, openRead, signal) {
	const files = await readTree(model.root, uid, "model-invalid");
	for (const role of MODEL_ROLES) {
		const pin = model.files[role];
		if (files.get(pin.name)?.size !== pin.size) fail("model-invalid");
	}
	// The digests are checked on every session: the marker only records sizes.
	for (const role of MODEL_ROLES) {
		if (signal.aborted) fail("model-invalid");
		const pin = model.files[role];
		const digest = await sha256(openRead, path.join(model.root, pin.name), signal).catch(() => fail("model-invalid"));
		if (digest !== pin.sha256) fail("model-invalid");
	}
}

// Prefers 32-bit float input; otherwise keeps the device default when it is a
// format this worker can scale. Rates and channel counts stay at the default.
function chooseInputConfig(convenience, deviceId) {
	const defaults = convenience.getDefaultInputConfig(deviceId);
	const formats = convenience.getSupportedFormats(deviceId);
	if (!isRecord(defaults) || !isInteger(defaults.sampleRate, 8000, 384000) || !isInteger(defaults.channels, 1, 64)) fail("unsupported-input");
	const sampleFormat = Array.isArray(formats) && formats.includes("f32") ? "f32" : defaults.sampleFormat;
	if (!Object.hasOwn(SAMPLE_FORMATS, sampleFormat)) fail("unsupported-input");
	return { sampleRate: defaults.sampleRate, channels: defaults.channels, sampleFormat };
}

// Collects interleaved device frames as mono samples at the device rate, up to
// a fixed number of samples. Returns false once the limit is reached.
class MonoRecorder {
	constructor(config, maxSamples) {
		this.config = config;
		this.format = SAMPLE_FORMATS[config.sampleFormat];
		this.maxSamples = maxSamples;
		this.chunks = [];
		this.length = 0;
	}

	append(data) {
		const { channels } = this.config;
		const { offset, scale } = this.format;
		const frames = Math.min(Math.floor(data.length / channels), this.maxSamples - this.length);
		const mono = new Float32Array(frames);
		let energy = 0;
		for (let frame = 0; frame < frames; frame++) {
			let sum = 0;
			for (let channel = 0; channel < channels; channel++) sum += (Number(data[frame * channels + channel]) - offset) / scale;
			const value = sum / channels;
			mono[frame] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
			energy += mono[frame] * mono[frame];
		}
		this.chunks.push(mono);
		this.length += frames;
		// The level of this chunk, for end-of-speech detection.
		this.lastFrames = frames;
		this.lastLevel = frames > 0 ? Math.sqrt(energy / frames) : 0;
		return this.length < this.maxSamples;
	}

	samples() {
		const all = new Float32Array(this.length);
		let at = 0;
		for (const chunk of this.chunks) {
			all.set(chunk, at);
			at += chunk.length;
		}
		this.chunks = [];
		return all;
	}
}

// Decides when a hands-free recording is over, in audio time, never wall time.
// Levels are judged per 100 ms window, never per device chunk: a WSLg
// microphone delivers 10 ms chunks whose levels scatter two to four times
// around the floor, so a single chunk is not evidence of anything. The noise
// floor is the quietest window heard so far; a window is speech when it is at
// least three times that floor and above a fixed minimum level. Speech counts
// once 150 ms of it were heard; after that, endOfSpeechMs of quiet ends the
// recording, forgiving one isolated loud window in every eight (an ambient
// spike, a click: a loud window between quiet ones), as long as the latest
// window is quiet. The tail of the speech itself is never forgiven.
// With no speech within noSpeechMs it ends as well, and the
// blank transcript is reported as no speech.
// Above the loudest ambient window measured on a low-gain WSLg microphone
// (0.0031 RMS; speech there starts at 0.016). It matters because the stream
// opens with a few windows of digital silence that pull the floor near zero,
// where the floor ratio cannot do its work.
const MIN_SPEECH_LEVEL = 0.005;
const SPEECH_FLOOR_RATIO = 3;
const MIN_SPEECH_SECONDS = 0.15;
const WINDOW_SECONDS = 0.1;
// Published levels: one message per 50 ms of audio, so at most 20 a second
// whatever the device chunk size is.
const LEVEL_WINDOW_SECONDS = 0.05;
const FORGIVEN_WINDOWS_PER = 8;
const QUIET = 0;
const SPEECH = 1;
const SPIKE = 2;

// The whole-utterance rule (S4). The spotter fires on a phrase wherever it is
// said, so a hit is a command only when the phrase was the utterance itself.
// Quiet this long closes an utterance, and is the silence a command must be
// followed by.
const KWS_QUIET_WINDOWS = 4;
// From the start of the utterance to the hit: the longest phrase (about 1.6 s)
// plus the spotter's own delay after the words (0.65 s at most when measured)
// and a margin. More speech than that before the hit means the phrase came
// inside a sentence.
const KWS_MAX_LEAD_SECONDS = 2.6;
// A hit not followed by that silence within this long had more speech after
// it: an embedded mention as well.
const KWS_CONFIRM_SECONDS = 1;
// Silence fed to the spotter when a recording ends, so a phrase said right
// before the end is still decoded.
const KWS_TAIL_SECONDS = 0.5;

class Endpointer {
	constructor(sampleRate, endpoint) {
		this.windowFrames = Math.round(sampleRate * WINDOW_SECONDS);
		this.endWindows = Math.max(1, Math.round(endpoint.endOfSpeechMs / 1000 / WINDOW_SECONDS));
		this.noSpeechWindows = Math.max(1, Math.round(endpoint.noSpeechMs / 1000 / WINDOW_SECONDS));
		this.minSpeechWindows = Math.max(1, Math.ceil(MIN_SPEECH_SECONDS / WINDOW_SECONDS));
		this.forgiven = Math.floor(this.endWindows / FORGIVEN_WINDOWS_PER);
		this.floor = Infinity;
		this.windows = 0;
		this.speechWindows = 0;
		// The latest endWindows windows, oldest first: QUIET, SPEECH or SPIKE.
		this.recent = [];
		// The window being filled from device chunks.
		this.energy = 0;
		this.frames = 0;
	}

	// True once enough speech was heard to count as someone talking.
	get heardSpeech() {
		return this.speechWindows >= this.minSpeechWindows;
	}

	// Returns true once the recording should end.
	push(level, frames) {
		if (frames <= 0) return false;
		this.energy += level * level * frames;
		this.frames += frames;
		if (this.frames < this.windowFrames) return false;
		// A chunk longer than a window stands for as many windows as it spans.
		const rms = Math.sqrt(this.energy / this.frames);
		const count = Math.max(1, Math.round(this.frames / this.windowFrames));
		this.energy = 0;
		this.frames = 0;
		let end = false;
		for (let i = 0; i < count; i++) end = this.pushWindow(rms) || end;
		return end;
	}

	pushWindow(rms) {
		this.floor = Math.min(this.floor, rms);
		this.windows += 1;
		const loud = rms >= Math.max(MIN_SPEECH_LEVEL, this.floor * SPEECH_FLOOR_RATIO);
		if (loud) this.speechWindows += 1;
		const previous = this.recent.at(-1);
		// A loud window after a quiet one is a spike until another loud window
		// follows it; then both are speech.
		if (loud && previous === SPIKE) this.recent[this.recent.length - 1] = SPEECH;
		this.recent.push(loud ? (previous === QUIET ? SPIKE : SPEECH) : QUIET);
		if (this.recent.length > this.endWindows) this.recent.shift();
		if (!this.heardSpeech) return this.windows >= this.noSpeechWindows;
		if (loud || this.recent.length < this.endWindows) return false;
		let spikes = 0;
		for (const kind of this.recent) {
			if (kind === SPEECH) return false;
			if (kind === SPIKE) spikes += 1;
		}
		return spikes <= this.forgiven;
	}
}

// Converts to 16 kHz. Downsampling averages each output sample's input window,
// a box filter that keeps most aliasing out of the speech band; upsampling
// interpolates linearly.
function resample(input, fromRate) {
	if (fromRate === TARGET_RATE) return input;
	const step = fromRate / TARGET_RATE;
	const output = new Float32Array(Math.floor(input.length / step));
	for (let i = 0; i < output.length; i++) {
		const start = i * step;
		if (step > 1) {
			const from = Math.floor(start);
			const to = Math.min(input.length, Math.max(from + 1, Math.floor(start + step)));
			let sum = 0;
			for (let j = from; j < to; j++) sum += input[j];
			output[i] = sum / (to - from);
		} else {
			const j = Math.floor(start);
			const next = input[Math.min(j + 1, input.length - 1)];
			output[i] = input[j] + (next - input[j]) * (start - j);
		}
	}
	return output;
}

class WorkerSession {
	constructor(io, exit) {
		this.io = io;
		this.exit = exit;
		this.state = "waiting";
		this.stream = undefined;
		this.recorder = undefined;
		this.request = undefined;
		// Settles once every model digest matched; rejects with model-invalid.
		this.modelVerified = undefined;
		// A warm worker keeps the verified model and its loaded recognizer for
		// later recordings with the same runtime and model.
		this.verifiedKey = undefined;
		this.recognizer = undefined;
		this.verification = new AbortController();
		this.truncated = false;
		// Published microphone levels (S5), off unless the start request asks.
		this.levels = false;
		this.levelWindowFrames = 1;
		this.levelEnergy = 0;
		this.levelFrames = 0;
		// The keyword spotter (S7): one for the process lifetime, because the
		// binding cannot free one, and the state of the capture it listens to.
		this.spotter = undefined;
		this.spotterKey = undefined;
		this.kws = undefined;
	}

	send(message) {
		this.io.write(`${JSON.stringify({ schema: SCHEMA, ...message })}\n`);
	}

	// Ends the session once: closes capture, reports at most one final message.
	async end(final) {
		if (this.state === "ended") return;
		this.state = "ended";
		this.verification.abort();
		await this.closeStream();
		if (final) this.send(final);
		this.exit(final?.type === "error" ? 1 : 0);
	}

	async closeStream() {
		const stream = this.stream;
		this.stream = undefined;
		if (stream) await Promise.resolve(stream.close()).catch(() => {});
	}

	async handle(message) {
		if (this.state === "waiting") {
			// Only an idle worker may be closed; it leaves without a message.
			if (hasExactKeys(message, ["schema", "type"]) && message.schema === SCHEMA && message.type === "close") return this.end(undefined);
			return this.begin(parseStart(message));
		}
		if (!hasExactKeys(message, ["schema", "type"]) || message.schema !== SCHEMA) fail("invalid-request");
		if (message.type === "cancel") return this.end(undefined);
		if (message.type === "stop") {
			if (this.state === "recording") return this.transcribe();
			if (this.state === "spotting") return this.finishCapture({ type: "stopped" });
			if (this.state === "loading") fail("invalid-request");
			return undefined;
		}
		fail("invalid-request");
	}

	/**
	 * Validates the runtime, picks the capture backend for this kernel and opens
	 * the microphone; the model is verified later, while recording.
	 */
	async begin(request) {
		this.state = "loading";
		const { io } = this;
		if (request.target !== `${io.platform}-${io.arch}`) fail("runtime-invalid");
		// WSLg exposes audio through a PulseAudio server, not an ALSA device, so a
		// Microsoft kernel selects node-cpal's PulseAudio facade. That facade falls
		// back to the default binary when its own native file is missing, so the
		// facade and its native file are validated before anything is loaded.
		const usePulse = io.platform === "linux" && /microsoft/i.test(io.kernelRelease ?? "");
		const captureEntry = usePulse ? PULSE_ENTRY : CPAL_ENTRY;
		// A cancel can arrive during any await; each step re-checks before going on.
		await validateRuntime(request.runtime, io.uid, [...(usePulse ? [PULSE_ENTRY, pulseNative(request.target)] : []), ...(request.kws ? [KWS_ENTRY] : [])]);
		if (this.state !== "loading") return;
		this.request = request;
		if (request.kws) {
			await this.prepareSpotter(request);
			if (this.state !== "loading") return;
		}
		let cpal;
		try {
			cpal = io.loadModule(this.fromRuntime(captureEntry));
		} catch {
			fail("runtime-load");
		}
		await this.openCapture(cpal?.convenience, request.maxRecordingMs);
	}

	// Starts in the same step that enters recording, so no stop can see a
	// session without a pending verification.
	verifyModel() {
		const key = JSON.stringify([this.request.runtime, this.request.model]);
		if (this.request.keepAlive && this.verifiedKey === key && this.modelVerified) return;
		this.verifiedKey = this.request.keepAlive ? key : undefined;
		this.recognizer = undefined;
		this.modelVerified = validateModel(this.request.model, this.io.uid, this.io.openRead ?? createReadStream, this.verification.signal);
		// While recording, a failed verification ends the session at once: the
		// audio could never be transcribed. Later, transcribe() reports it.
		this.modelVerified.catch((error) => {
			if (this.state === "recording") void this.fail(error);
		});
	}

	fromRuntime(entry) {
		return path.join(this.request.runtime.root, ...entry.split("/"));
	}

	// Verifies the spotter model and builds the spotter before the microphone
	// opens; a later start with the same runtime and option reuses it.
	async prepareSpotter(request) {
		const { kws } = request;
		const key = JSON.stringify([request.runtime, kws]);
		if (this.spotter && this.spotterKey === key) return;
		// A second spotter could never be freed: a changed option needs a new worker.
		if (this.spotter) fail("invalid-request");
		await validateModel(kws.model, this.io.uid, this.io.openRead ?? createReadStream, this.verification.signal);
		if (this.state !== "loading") return;
		const fromModel = (role) => path.join(kws.model.root, kws.model.files[role].name);
		let spotterModule;
		try {
			spotterModule = this.io.loadModule(this.fromRuntime(KWS_ENTRY));
		} catch {
			fail("runtime-load");
		}
		// Each line carries its command as the label the spotter reports back.
		const keywordsBuf = kws.keywords.map((keyword) => `${keyword.tokens} @${keyword.command}\n`).join("");
		try {
			this.spotter = new spotterModule.KeywordSpotter({
				featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
				modelConfig: {
					transducer: { encoder: fromModel("encoder"), decoder: fromModel("decoder"), joiner: fromModel("joiner") },
					tokens: fromModel("tokens"),
					numThreads: 1,
					provider: "cpu",
					debug: 0,
				},
				keywordsBuf,
				keywordsBufSize: Buffer.byteLength(keywordsBuf),
				keywordsScore: kws.boost,
				keywordsThreshold: kws.threshold,
				maxActivePaths: kws.maxActivePaths,
				numTrailingBlanks: kws.trailingBlanks,
			});
		} catch {
			fail("model-load");
		}
		this.spotterKey = key;
	}

	// What the spotter needs to know about one capture: its stream, the audio
	// not yet handed over, and the speech activity the whole-utterance rule reads.
	openKws(sampleRate) {
		let stream;
		try {
			stream = this.spotter.createStream();
		} catch {
			fail("model-load");
		}
		return {
			stream,
			sampleRate,
			commands: new Set(this.request.kws.keywords.map((keyword) => keyword.command)),
			windowFrames: Math.max(1, Math.round(sampleRate * WINDOW_SECONDS)),
			chunks: [],
			frames: 0,
			energy: 0,
			floor: Infinity,
			// Audio time handed to the spotter, in seconds.
			time: 0,
			// A capture starts as if silence came before it.
			quietRun: KWS_QUIET_WINDOWS,
			utteranceStart: undefined,
			pending: undefined,
		};
	}

	// Hands the collected audio to the spotter and returns the keyword it
	// reports, or "". Audio goes over in whole 100 ms windows, so the 16 kHz
	// conversion never drops a fraction of a sample per device chunk.
	decodeKws(extraSeconds = 0) {
		const kws = this.kws;
		const block = new Float32Array(kws.frames + Math.round(kws.sampleRate * extraSeconds));
		let at = 0;
		for (const chunk of kws.chunks) {
			block.set(chunk, at);
			at += chunk.length;
		}
		kws.chunks = [];
		kws.frames = 0;
		kws.energy = 0;
		if (block.length === 0) return "";
		try {
			kws.stream.acceptWaveform({ sampleRate: TARGET_RATE, samples: resample(block, kws.sampleRate) });
			while (this.spotter.isReady(kws.stream)) {
				this.spotter.decode(kws.stream);
				const keyword = this.spotter.getResult(kws.stream)?.keyword;
				if (typeof keyword !== "string" || keyword.trim().length === 0) continue;
				this.spotter.reset(kws.stream);
				return keyword.trim();
			}
		} catch {
			fail("decode");
		}
		return "";
	}

	// True when a hit at the current audio time can be the whole utterance:
	// a named command, with no more speech before it than the phrase itself.
	isWholeUtterance(keyword) {
		const kws = this.kws;
		if (!kws.commands.has(keyword) || kws.utteranceStart === undefined) return false;
		return kws.time - kws.utteranceStart <= KWS_MAX_LEAD_SECONDS;
	}

	// Called for every device chunk of a capture that asked for keywords.
	// Returns the command once a hit turned out to be the whole utterance.
	pushKws() {
		const kws = this.kws;
		const chunk = this.recorder.chunks.at(-1);
		if (!chunk || chunk.length === 0) return undefined;
		kws.chunks.push(chunk);
		kws.frames += chunk.length;
		kws.energy += this.recorder.lastLevel * this.recorder.lastLevel * chunk.length;
		if (kws.frames < kws.windowFrames) return undefined;
		const rms = Math.sqrt(kws.energy / kws.frames);
		const windows = Math.max(1, Math.round(kws.frames / kws.windowFrames));
		kws.floor = Math.min(kws.floor, rms);
		const loud = rms >= Math.max(MIN_SPEECH_LEVEL, kws.floor * SPEECH_FLOOR_RATIO);
		if (loud) {
			if (kws.quietRun >= KWS_QUIET_WINDOWS) kws.utteranceStart = kws.time;
			kws.quietRun = 0;
		} else {
			kws.quietRun += windows;
		}
		kws.time += windows * WINDOW_SECONDS;
		const keyword = this.decodeKws();
		if (keyword) kws.pending = this.isWholeUtterance(keyword) ? { command: keyword, deadline: kws.time + KWS_CONFIRM_SECONDS } : undefined;
		if (!kws.pending) return undefined;
		if (kws.quietRun >= KWS_QUIET_WINDOWS) return kws.pending.command;
		// Speech went on after the phrase: it was part of a sentence.
		if (kws.time >= kws.pending.deadline) kws.pending = undefined;
		return undefined;
	}

	// When the recording ends: the end itself is the silence after the phrase,
	// so a hit still waiting for it counts, and so does a phrase said right
	// before the end, which the spotter only reports after a little more audio.
	finalKwsCommand() {
		const kws = this.kws;
		if (kws.pending) return kws.pending.command;
		kws.time += kws.frames / kws.sampleRate;
		const keyword = this.decodeKws(KWS_TAIL_SECONDS);
		return keyword && this.isWholeUtterance(keyword) ? keyword : undefined;
	}

	// Loads sherpa-onnx and the recognizer; only called once the model verified.
	loadRecognizer() {
		const { request } = this;
		const fromModel = (role) => path.join(request.model.root, request.model.files[role].name);
		let asr;
		try {
			asr = this.io.loadModule(this.fromRuntime(SHERPA_ENTRY));
		} catch {
			fail("runtime-load");
		}
		try {
			return new asr.OfflineRecognizer({
				featConfig: { sampleRate: TARGET_RATE, featureDim: 80 },
				modelConfig: {
					transducer: { encoder: fromModel("encoder"), decoder: fromModel("decoder"), joiner: fromModel("joiner") },
					tokens: fromModel("tokens"),
					numThreads: request.numThreads,
					provider: "cpu",
					modelType: "nemo_transducer",
				},
			});
		} catch {
			fail("model-load");
		}
	}

	async openCapture(convenience, maxRecordingMs) {
		if (!isRecord(convenience)) fail("runtime-load");
		let device;
		try {
			device = convenience.getDefaultInputDevice();
		} catch {
			fail("no-input-device");
		}
		if (!isRecord(device) || typeof device.deviceId !== "string" || device.deviceId.length === 0) fail("no-input-device");
		let config;
		try {
			config = chooseInputConfig(convenience, device.deviceId);
		} catch (error) {
			throw error instanceof WorkerFailure ? error : new WorkerFailure("unsupported-input");
		}
		// A spot-only capture keeps no audio, so it has no recording limit either.
		const spot = this.request?.spot === true;
		this.recorder = new MonoRecorder(config, spot ? Infinity : Math.ceil((config.sampleRate * maxRecordingMs) / 1000));
		this.endpointer = this.request?.endpoint ? new Endpointer(config.sampleRate, this.request.endpoint) : undefined;
		this.levels = this.request?.levels === true;
		this.levelWindowFrames = Math.max(1, Math.round(config.sampleRate * LEVEL_WINDOW_SECONDS));
		this.levelEnergy = 0;
		this.levelFrames = 0;
		this.kws = this.request?.kws ? this.openKws(config.sampleRate) : undefined;
		try {
			// The native layer holds the stream weakly; this session keeps it alive.
			this.stream = await convenience.createInputStream({
				deviceId: device.deviceId,
				config,
				onData: (data) => this.onData(data),
				// A buffer underrun or overrun drops some audio but the stream keeps
				// running; WASAPI reports one at start on some devices.
				onError: (error) => {
					if (isRecord(error) && error.code === "XRUN") return;
					void this.fail(new WorkerFailure("capture"));
				},
				autoStart: true,
				queueCapacityBuffers: 64,
			});
		} catch {
			fail("capture");
		}
		if (this.state !== "loading") return this.closeStream();
		if (spot) {
			// The dictation model is neither verified nor loaded: nothing is transcribed.
			this.state = "spotting";
			this.send({ type: "spotting" });
			return;
		}
		this.state = "recording";
		this.send({ type: "recording" });
		this.verifyModel();
	}

	// At most one level per 50 ms of audio: the window is audio time, so a long
	// chunk never becomes a burst and a short one never starves the meter.
	publishLevel() {
		if (!this.levels) return;
		this.levelEnergy += this.recorder.lastLevel * this.recorder.lastLevel * this.recorder.lastFrames;
		this.levelFrames += this.recorder.lastFrames;
		if (this.levelFrames < this.levelWindowFrames) return;
		const rms = Math.sqrt(this.levelEnergy / this.levelFrames);
		this.levelEnergy = 0;
		this.levelFrames = 0;
		this.send({ type: "level", rms });
	}

	// A spot-only capture: every chunk goes to the spotter and is then dropped.
	onSpotData(data) {
		this.recorder.append(data);
		let command;
		try {
			command = this.pushKws();
		} catch (error) {
			void this.fail(error);
			return;
		}
		this.recorder.chunks = [];
		this.recorder.length = 0;
		if (command) void this.finishCommand(command).catch((error) => this.fail(error));
	}

	onData(data) {
		if (!ArrayBuffer.isView(data)) return;
		if (this.state === "spotting") return this.onSpotData(data);
		if (this.state !== "recording") return;
		const room = this.recorder.append(data);
		this.publishLevel();
		if (this.kws) {
			let command;
			try {
				command = this.pushKws();
			} catch (error) {
				void this.fail(error);
				return;
			}
			if (command) {
				void this.finishCommand(command).catch((error) => this.fail(error));
				return;
			}
		}
		if (!room) {
			this.truncated = true;
			void this.transcribe().catch((error) => this.fail(error));
			return;
		}
		if (this.endpointer?.push(this.recorder.lastLevel, this.recorder.lastFrames)) void this.transcribe().catch((error) => this.fail(error));
	}

	async transcribe() {
		const command = this.kws ? this.finalKwsCommand() : undefined;
		if (command) return this.finishCommand(command);
		this.state = "transcribing";
		this.send({ type: "transcribing" });
		await this.closeStream();
		if (this.state !== "transcribing") return;
		// Nothing from sherpa-onnx or the model is loaded before every digest matched.
		if (!this.modelVerified) fail("model-invalid");
		await this.modelVerified;
		if (this.state !== "transcribing") return;
		const { sampleRate } = this.recorder.config;
		// Hands-free: with no speech heard the model is not asked at all, because
		// it can turn noise into a word such as "Yeah." that would be sent.
		if (this.endpointer && !this.endpointer.heardSpeech) return this.finishResult("");
		const captured = this.recorder.samples();
		if (captured.length < sampleRate * MIN_SECONDS) fail("empty-audio");
		const samples = resample(captured, sampleRate);
		const recognizer = this.recognizer ?? this.loadRecognizer();
		if (this.request.keepAlive) this.recognizer = recognizer;
		let text;
		try {
			const stream = recognizer.createStream();
			stream.acceptWaveform({ sampleRate: TARGET_RATE, samples });
			recognizer.decode(stream);
			text = recognizer.getResult(stream)?.text;
		} catch {
			fail("decode");
		}
		if (typeof text !== "string") fail("decode");
		return this.finishResult(text);
	}

	async finishResult(text) {
		const result = { type: "result", text: text.trim().slice(0, MAX_TEXT), truncated: this.truncated };
		if (!this.request.keepAlive) return this.end(result);
		// Warm: the microphone was already released; wait for the next start.
		this.send(result);
		this.resetCapture();
	}

	// A spoken command ends the capture in place of a transcript (S4: the
	// command is never sent to the model): the client sees `recording` (or
	// `spotting`), then `command`, and nothing else for this capture.
	finishCommand(command) {
		return this.finishCapture({ type: "command", command });
	}

	// Ends a capture that has no transcript with one last message: a command,
	// or `stopped` for a spot-only capture that was asked to stop.
	async finishCapture(message) {
		if (!this.request.keepAlive) return this.end(message);
		this.state = "closing";
		await this.closeStream();
		if (this.state !== "closing") return;
		this.send(message);
		this.resetCapture();
	}

	resetCapture() {
		this.state = "waiting";
		this.recorder = undefined;
		this.endpointer = undefined;
		this.kws = undefined;
		this.truncated = false;
	}

	fail(error) {
		const code = error instanceof WorkerFailure ? error.code : "internal";
		return this.end({ type: "error", code });
	}
}

// Runs one dictation session. `io` supplies stdin, stdout, exit, the module
// loader, an optional file reader (`openRead`, fs.createReadStream by default)
// and the process facts, so tests can drive the worker in-process with
// fake modules; the real entry point below passes Node's own.
// Resolves after the session has ended and `io.exit` was called once.
function runVoiceWorker(io) {
	return new Promise((resolve) => {
		let buffered = "";
		const session = new WorkerSession(io, (code) => {
			io.input.removeListener("data", onData);
			io.input.removeListener("end", onEnd);
			io.exit(code);
			resolve();
		});
		// Messages are handled as they arrive, not queued: a cancel must reach the
		// session while it is still validating or loading.
		const dispatch = (handler) => {
			try {
				void Promise.resolve(handler()).catch((error) => session.fail(error));
			} catch (error) {
				void session.fail(error);
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
		// A closed stdin means the parent is gone: stop capturing and leave.
		const onEnd = () => dispatch(() => session.end(undefined));
		io.input.on("data", onData);
		io.input.on("end", onEnd);
		if (!isInteger(Number(String(io.nodeVersion).split(".")[0]), 22, Number.MAX_SAFE_INTEGER)) {
			void session.end({ type: "error", code: "node-version" });
		}
	});
}

module.exports = { runVoiceWorker, Endpointer };

if (require.main === module) {
	const io = {
		input: process.stdin,
		write: (line) => process.stdout.write(line),
		exit: (code) => process.stdout.write("", () => process.exit(code)),
		loadModule: (file) => require(file),
		platform: process.platform,
		kernelRelease: release(),
		arch: process.arch,
		nodeVersion: process.versions.node,
		uid: typeof process.getuid === "function" ? process.getuid() : undefined,
	};
	process.on("uncaughtException", () => {
		process.stdout.write(`${JSON.stringify({ schema: SCHEMA, type: "error", code: "internal" })}\n`, () => process.exit(1));
	});
	process.stdin.setEncoding("utf8");
	void runVoiceWorker(io);
}
