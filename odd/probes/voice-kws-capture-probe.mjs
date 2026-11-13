// No-microphone probe for spoken commands inside a real capture (L26).
//
// Runs the REAL scripts/voice-worker.cjs with the REAL installed dictation and
// keyword spotter models from the voice home, but replaces the capture module
// with one that feeds synthesized clips (Windows OneCore voices, synthesized to
// memory and never played). Nothing is recorded and nothing is audible.
//
//   node --experimental-strip-types odd/probes/voice-kws-capture-probe.mjs [--scenario name] [--voice en|es]
//
// For every scenario it prints the worker's final message (`command`, `result`
// or an error) and every hit the spotter reported, with its audio time, so a
// hit the whole-utterance gate rejected is visible.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { resolveVoiceHome } from "../../lib/voice-install.ts";
import { prepareVoiceWorkerLaunch } from "../../lib/voice-session.ts";
import { buildVoiceKeywordOption } from "../../lib/voice-listener.ts";
import { ONECORE_SYNTH_SCRIPTS } from "../../lib/voice-onecore.ts";

const require = createRequire(import.meta.url);
const workerPath = fileURLToPath(new URL("../../scripts/voice-worker.cjs", import.meta.url));
const { runVoiceWorker } = require(workerPath);

const args = process.argv.slice(2);
const pick = (flag) => {
	const at = args.indexOf(flag);
	return at >= 0 ? args[at + 1] : undefined;
};
const onlyScenario = pick("--scenario");
const voices = pick("--voice") ? [pick("--voice")] : ["en", "es"];
const CHUNK_MS = 20;

function synthesize(language, text, rate = 1) {
	const encoded = Buffer.from(ONECORE_SYNTH_SCRIPTS[language], "utf16le").toString("base64");
	return new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true });
		let out = "";
		child.stdout.on("data", (data) => {
			out += data;
			const line = out.split(/\r?\n/).slice(0, -1).find((entry) => entry.startsWith("audio:") || entry.startsWith("error:"));
			if (!line) return;
			child.stdin.end();
			if (line.startsWith("error:")) return reject(new Error(line));
			resolve(Buffer.from(line.slice(6), "base64"));
		});
		child.on("error", reject);
		child.stdin.write(`${Buffer.from(JSON.stringify({ text, rate })).toString("base64")}\n`);
	});
}

function decodeWav(wav) {
	let at = 12;
	let rate;
	let channels;
	let bits;
	while (at + 8 <= wav.length) {
		const id = wav.toString("ascii", at, at + 4);
		const size = wav.readUInt32LE(at + 4);
		if (id === "fmt ") {
			channels = wav.readUInt16LE(at + 10);
			rate = wav.readUInt32LE(at + 12);
			bits = wav.readUInt16LE(at + 22);
		} else if (id === "data") {
			if (bits !== 16) throw new Error(`bits ${bits}`);
			const frames = Math.floor(size / 2 / channels);
			const samples = new Float32Array(frames);
			for (let i = 0; i < frames; i++) samples[i] = wav.readInt16LE(at + 8 + i * 2 * channels) / 32768;
			return { rate, samples };
		}
		at += 8 + size + (size % 2);
	}
	throw new Error("no data chunk");
}

// Deterministic low noise so the level floor behaves like a real room.
function noise(rate, seconds, rms, seed = 1) {
	const out = new Float32Array(Math.round(rate * seconds));
	let state = seed;
	for (let i = 0; i < out.length; i++) {
		state = (state * 1664525 + 1013904223) >>> 0;
		out[i] = ((state / 2 ** 32) * 2 - 1) * rms * Math.sqrt(3);
	}
	return out;
}

// The open cue as the microphone hears it from the speakers: two 120 ms tones.
function cueEcho(rate, gain) {
	const tone = (hz, seconds) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * gain);
	return concat([tone(660, 0.12), new Float32Array(Math.round(rate * 0.04)), tone(880, 0.12)]);
}

function concat(parts) {
	const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function scale(samples, gain) {
	return samples.map((value) => value * gain);
}

// Adds a noise bed under the whole clip.
function withBed(samples, rate, rms) {
	const bed = noise(rate, samples.length / rate, rms, 7);
	return samples.map((value, i) => value + bed[i]);
}

function fakeCapture(rate, clip, log) {
	let stream;
	return {
		convenience: {
			getDefaultInputDevice: () => ({ deviceId: "probe" }),
			getDefaultInputConfig: () => ({ sampleRate: rate, channels: 1, sampleFormat: "f32" }),
			getSupportedFormats: () => ["f32"],
			createInputStream: ({ onData }) => {
				stream = { closed: false, close() { this.closed = true; } };
				stream.feed = async () => {
					const step = Math.round((rate * CHUNK_MS) / 1000);
					for (let at = 0; at < clip.length && !stream.closed; at += step) {
						onData(clip.slice(at, at + step));
						await new Promise((resolve) => setImmediate(resolve));
					}
					log.fed = true;
				};
				return stream;
			},
		},
		get stream() {
			return stream;
		},
	};
}

async function runScenario({ name, clip, rate, manualStopAfterSeconds }, base, kws) {
	const hits = [];
	const fed = { seconds: 0 };
	const log = {};
	const capture = fakeCapture(rate, clip, log);
	const input = new EventEmitter();
	const messages = [];
	let resolveDone;
	const done = new Promise((resolve) => (resolveDone = resolve));
	const loadModule = (file) => {
		if (file.endsWith("backend-pulseaudio.js") || file.endsWith("node-cpal/index.js")) return capture;
		const loaded = require(file);
		if (!file.endsWith("keyword-spotter.js")) return loaded;
		class ObservedSpotter extends loaded.KeywordSpotter {
			createStream(...rest) {
				const stream = super.createStream(...rest);
				const accept = stream.acceptWaveform.bind(stream);
				stream.acceptWaveform = (wave) => {
					fed.seconds += wave.samples.length / wave.sampleRate;
					accept(wave);
				};
				return stream;
			}
			getResult(stream) {
				const result = super.getResult(stream);
				if (result?.keyword) hits.push({ keyword: result.keyword, fedSeconds: Number(fed.seconds.toFixed(2)) });
				return result;
			}
		}
		return { ...loaded, KeywordSpotter: ObservedSpotter };
	};
	const io = {
		input,
		write: (line) => {
			for (const text of String(line).split("\n").filter(Boolean)) {
				const message = JSON.parse(text);
				messages.push(message);
				if (message.type === "recording") setTimeout(() => void capture.stream.feed().then(afterFeed), 10);
				if (["command", "result", "error", "stopped"].includes(message.type)) resolveDone(message);
			}
		},
		exit: () => resolveDone(messages.at(-1)),
		loadModule,
		platform: process.platform,
		arch: process.arch,
		kernelRelease: os.release(),
		nodeVersion: process.versions.node,
		uid: process.getuid?.(),
	};
	const afterFeed = () => {
		if (manualStopAfterSeconds !== undefined) input.emit("data", `${JSON.stringify({ schema: "gentle.voice/v1", type: "stop" })}\n`);
	};
	const request = { ...base, kws, endpoint: { endOfSpeechMs: 2500, noSpeechMs: 8000 } };
	if (manualStopAfterSeconds !== undefined) request.endpoint = { endOfSpeechMs: 5000, noSpeechMs: 60000 };
	delete request.keepAlive;
	const run = runVoiceWorker(io);
	input.emit("data", `${JSON.stringify(request)}\n`);
	const final = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve({ type: "timeout" }), 60000))]);
	input.emit("end");
	await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 1000))]);
	return { name, final: final.type === "command" ? `command ${final.command}` : final.type === "result" ? `result ${JSON.stringify(final.text)}` : JSON.stringify(final), hits };
}

// Feeds a clip straight into a fresh real spotter stream, 100 ms at a time,
// with the same tuning the worker uses: tells the model from the worker.
function spotDirect(kws, clip, rate) {
	const sherpa = require(`${kws.runtimeRoot}/node_modules/sherpa-onnx-node/keyword-spotter.js`);
	const file = (role) => `${kws.model.root}/${kws.model.files[role].name}`;
	const buf = kws.keywords.map((entry) => `${entry.tokens} @${entry.command}\n`).join("");
	const spotter = new sherpa.KeywordSpotter({
		featConfig: { sampleRate: 16000, featureDim: 80 },
		modelConfig: { transducer: { encoder: file("encoder"), decoder: file("decoder"), joiner: file("joiner") }, tokens: file("tokens"), numThreads: 1 },
		maxActivePaths: kws.maxActivePaths, numTrailingBlanks: kws.trailingBlanks, keywordsScore: kws.boost, keywordsThreshold: kws.threshold,
		keywordsBuf: buf,
		keywordsBufSize: Buffer.byteLength(buf),
	});
	const stream = spotter.createStream();
	const hits = [];
	const step = Math.round(rate * 0.1);
	const tail = new Float32Array(Math.round(rate * 0.5));
	const all = concat([clip, tail]);
	for (let at = 0; at < all.length; at += step) {
		const block = all.slice(at, at + step);
		stream.acceptWaveform({ sampleRate: rate, samples: block });
		while (spotter.isReady(stream)) {
			spotter.decode(stream);
			const keyword = spotter.getResult(stream)?.keyword;
			if (keyword) {
				hits.push({ keyword, at: Number(((at + block.length) / rate).toFixed(1)) });
				spotter.reset(stream);
			}
		}
	}
	return hits;
}

// Every scenario of one voice through ONE warm worker (keepAlive), the way the
// listener runs it: captures one after the other on the same process.
async function runWarm(scenarios, rate, base, kws) {
	const input = new EventEmitter();
	const fed = { seconds: 0 };
	let current;
	let settle;
	const loadModule = (file) => {
		if (file.endsWith("backend-pulseaudio.js") || file.endsWith("node-cpal/index.js")) {
			return { convenience: {
				getDefaultInputDevice: () => ({ deviceId: "probe" }),
				getDefaultInputConfig: () => ({ sampleRate: rate, channels: 1, sampleFormat: "f32" }),
				getSupportedFormats: () => ["f32"],
				createInputStream: ({ onData }) => {
					const stream = { closed: false, close() { this.closed = true; } };
					stream.feed = async (clip) => {
						const step = Math.round((rate * CHUNK_MS) / 1000);
						for (let at = 0; at < clip.length && !stream.closed; at += step) {
							onData(clip.slice(at, at + step));
							await new Promise((resolve) => setImmediate(resolve));
						}
					};
					current.stream = stream;
					return stream;
				},
			} };
		}
		const loaded = require(file);
		if (!file.endsWith("keyword-spotter.js")) return loaded;
		class ObservedSpotter extends loaded.KeywordSpotter {
			getResult(stream) {
				const result = super.getResult(stream);
				if (result?.keyword) current.hits.push(result.keyword);
				return result;
			}
		}
		return { ...loaded, KeywordSpotter: ObservedSpotter };
	};
	const io = {
		input,
		write: (line) => {
			for (const text of String(line).split("\n").filter(Boolean)) {
				const message = JSON.parse(text);
				const capture = current;
				if (message.type === "recording") setTimeout(() => void capture.stream.feed(capture.clip).then(() => {
					if (capture.manualStopAfterSeconds !== undefined && !capture.settled) input.emit("data", `${JSON.stringify({ schema: "gentle.voice/v1", type: "stop" })}\n`);
				}), 10);
				if (["command", "result", "error", "stopped"].includes(message.type)) {
					current.settled = true;
					settle?.(message);
				}
			}
		},
		exit: () => settle?.({ type: "exit" }),
		loadModule, platform: process.platform, arch: process.arch, kernelRelease: os.release(), nodeVersion: process.versions.node, uid: process.getuid?.(),
	};
	const run = runVoiceWorker(io);
	const out = [];
	for (const scenario of scenarios) {
		current = { ...scenario, hits: [] };
		const done = new Promise((resolve) => (settle = resolve));
		const endpoint = scenario.manualStopAfterSeconds !== undefined ? { endOfSpeechMs: 5000, noSpeechMs: 60000 } : { endOfSpeechMs: 2500, noSpeechMs: 8000 };
		input.emit("data", `${JSON.stringify({ ...base, kws, endpoint, keepAlive: true })}\n`);
		const final = await Promise.race([done, new Promise((resolve) => setTimeout(() => resolve({ type: "timeout" }), 60000))]);
		out.push({ name: scenario.name, final: final.type === "command" ? `command ${final.command}` : final.type === "result" ? `result ${JSON.stringify(final.text)}` : JSON.stringify(final), hits: current.hits });
		if (final.type === "error" || final.type === "timeout" || final.type === "exit") break;
	}
	input.emit("data", `${JSON.stringify({ schema: "gentle.voice/v1", type: "close" })}\n`);
	await Promise.race([run, new Promise((resolve) => setTimeout(resolve, 2000))]);
	return out;
}

async function main() {
	const voiceHome = resolveVoiceHome();
	const target = `${process.platform}-${process.arch}`;
	const { request: base } = await prepareVoiceWorkerLaunch({ target, voiceHome });
	const option = await buildVoiceKeywordOption({ voiceHome });
	if (option.reason) throw new Error(`keyword spotter: ${option.reason}`);
	const kws = option.option;
	const results = [];
	for (const language of voices) {
		const phrase = decodeWav(await synthesize(language, "Gentle Voice off."));
		const sentence = decodeWav(await synthesize(language, language === "es" ? "Bueno, entonces decime si Gentle Voice off funciona bien." : "Well, tell me whether Gentle Voice off works fine today."));
		const { rate } = phrase;
		const silence = (seconds) => new Float32Array(Math.round(rate * seconds));
		const bed = 0.003;
		const scenarios = [
			{ name: "clean, endpoint", clip: withBed(concat([silence(0.8), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "cue echo, 0.3 s reaction, endpoint", clip: withBed(concat([cueEcho(rate, 0.1), silence(0.3), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "cue echo, 0.6 s reaction, endpoint", clip: withBed(concat([cueEcho(rate, 0.1), silence(0.6), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "breath 1.0 s gap, endpoint", clip: withBed(concat([silence(0.5), noise(rate, 0.6, 0.02, 3), silence(1.0), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "cue echo loud, 0.4 s reaction, endpoint", clip: withBed(concat([cueEcho(rate, 0.4), silence(0.4), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "breath before, endpoint", clip: withBed(concat([silence(0.5), noise(rate, 0.6, 0.02, 3), silence(0.2), phrase.samples, silence(3.5)]), rate, bed) },
			{ name: "slow phrase, endpoint", clip: withBed(concat([silence(0.8), decodeWav(await synthesize(language, "Gentle Voice off.", 0.7)).samples, silence(3.5)]), rate, bed) },
			{ name: "quiet voice, endpoint", clip: withBed(concat([silence(0.8), scale(phrase.samples, 0.15), silence(3.5)]), rate, bed) },
			{ name: "manual stop 0.3 s after phrase", clip: withBed(concat([silence(0.8), phrase.samples, silence(0.3)]), rate, bed), manualStopAfterSeconds: 0.3 },
			{ name: "inside a sentence (must not fire)", clip: withBed(concat([silence(0.8), sentence.samples, silence(3.5)]), rate, bed) },
		];
		if (args.includes("--warm")) {
			const picked = scenarios.filter((scenario) => !onlyScenario || scenario.name.includes(onlyScenario));
			for (const outcome of await runWarm([...picked, ...picked], rate, base, kws)) console.log(`${language} | warm | ${outcome.name} | ${outcome.final} | hits ${JSON.stringify(outcome.hits)}`);
			continue;
		}
		for (const scenario of scenarios) {
			if (onlyScenario && !scenario.name.includes(onlyScenario)) continue;
			if (args.includes("--direct")) {
				console.log(`${language} | ${scenario.name} | direct hits ${JSON.stringify(spotDirect({ ...kws, runtimeRoot: base.runtime.root }, scenario.clip, rate))}`);
				continue;
			}
			const outcome = await runScenario({ ...scenario, rate }, base, kws);
			results.push({ voice: language, ...outcome });
			console.log(`${language} | ${outcome.name} | ${outcome.final} | hits ${JSON.stringify(outcome.hits)}`);
		}
	}
}

await main();
process.exit(0);
