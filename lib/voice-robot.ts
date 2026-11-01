// The metallic "robot" effect for spoken replies (docs/voice.md, "Raúl robot
// voice"): the owner's pick, ffmpeg's
//   afftfilt=real='hypot(re,im)*sin(0)':imag='hypot(re,im)*cos(0)':win_size=512:overlap=0.75,volume=1.6
// reproduced step by step from libavfilter/af_afftfilt.c (ffmpeg 6.1), so no
// external tool is needed. Every 128 samples a 512-sample frame keeps the
// strength of each frequency and gives all of them the same phase, so the
// voice turns into a buzz at the frame rate that still carries the words.
// Plus 16-bit mono WAV helpers for the audio around it.

const FRAME = 512;
const HOP = 128;
const GAIN = 1.6;
// ffmpeg's output lags its input by one frame minus one hop.
const DELAY = FRAME - HOP;

// In place, iterative radix-2; inverse when sign is +1 (unscaled), as av_tx.
function fft(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j]!, re[i]!];
			[im[i], im[j]] = [im[j]!, im[i]!];
		}
	}
	for (let size = 2; size <= n; size <<= 1) {
		const angle = (sign * 2 * Math.PI) / size;
		const wr = Math.cos(angle);
		const wi = Math.sin(angle);
		for (let start = 0; start < n; start += size) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < size / 2; k++) {
				const a = start + k;
				const b = a + size / 2;
				const tr = re[b]! * cr - im[b]! * ci;
				const ti = re[b]! * ci + im[b]! * cr;
				re[b] = re[a]! - tr;
				im[b] = im[a]! - ti;
				re[a] = re[a]! + tr;
				im[a] = im[a]! + ti;
				const next = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = next;
			}
		}
	}
}

// ffmpeg's Hann window (N - 1 denominator), as sqrt(w / N).
const LUT = Float64Array.from({ length: FRAME }, (_value, n) => Math.sqrt((0.5 * (1 - Math.cos((2 * Math.PI * n) / (FRAME - 1)))) / FRAME));
// sqrt(1 - overlap) for overlap 0.75.
const OUTPUT_SCALE = 0.5;

// The filter as ffmpeg streams it: the output lags the input by DELAY samples
// and has the input's length.
export function robotizeStream(input: Float32Array): Float32Array {
	const length = input.length;
	const output = new Float32Array(length);
	const buffer = new Float64Array(FRAME + HOP);
	const re = new Float64Array(FRAME);
	const im = new Float64Array(FRAME);
	const tempRe = new Float64Array(FRAME);
	const tempIm = new Float64Array(FRAME);
	for (let frame = 0; frame * HOP < length; frame++) {
		const first = (frame + 1) * HOP - FRAME;
		for (let n = 0; n < FRAME; n++) {
			const at = first + n;
			re[n] = at >= 0 && at < length ? input[at]! * LUT[n]! : 0;
			im[n] = 0;
		}
		fft(re, im, -1);
		for (let n = 0; n <= FRAME / 2; n++) {
			tempRe[n] = 0;
			tempIm[n] = Math.hypot(re[n]!, im[n]!);
		}
		for (let n = FRAME / 2 + 1, x = FRAME / 2 - 1; n < FRAME; n++, x--) {
			tempRe[n] = tempRe[x]!;
			tempIm[n] = -tempIm[x]!;
		}
		fft(tempRe, tempIm, 1);
		buffer.copyWithin(0, HOP);
		buffer.fill(0, FRAME);
		for (let n = 0; n < FRAME; n++) buffer[n] = buffer[n]! + tempRe[n]! * LUT[n]! * OUTPUT_SCALE;
		for (let n = 0; n < HOP && frame * HOP + n < length; n++) output[frame * HOP + n] = buffer[n]!;
	}
	return output;
}

// The same effect aligned with its input, then 1.6 times louder and clipped.
export function robotize(input: Float32Array): Float32Array {
	const padded = new Float32Array(input.length + DELAY);
	padded.set(input);
	const streamed = robotizeStream(padded);
	const result = new Float32Array(input.length);
	for (let i = 0; i < input.length; i++) result[i] = Math.max(-1, Math.min(1, streamed[i + DELAY]! * GAIN));
	return result;
}

// Evens out the level of a reply, which the robot effect leaves low and
// uneven: every 50 ms block of speech is brought toward the target level, by
// at most maxGain and never below its own level. Blocks quieter than the noise
// floor keep the previous gain, so pauses are not pumped up. The gain falls at
// once on a loud block and rises over a few blocks, and peaks above 0.9 are
// rounded off instead of clipped.
export function levelVoice(samples: Float32Array, sampleRate: number, options: { target?: number; maxGain?: number; floor?: number } = {}): Float32Array {
	const target = options.target ?? 0.12;
	const maxGain = options.maxGain ?? 6;
	const floor = options.floor ?? 0.005;
	const block = Math.max(1, Math.round(sampleRate * 0.05));
	const blocks = Math.ceil(samples.length / block);
	const gains = new Float64Array(blocks);
	let gain = 1;
	for (let b = 0; b < blocks; b++) {
		let sum = 0;
		const end = Math.min(samples.length, (b + 1) * block);
		for (let i = b * block; i < end; i++) sum += samples[i]! * samples[i]!;
		const level = Math.sqrt(sum / Math.max(1, end - b * block));
		if (level > floor) {
			const wanted = Math.max(1, Math.min(maxGain, target / level));
			gain = wanted < gain ? wanted : gain + (wanted - gain) * 0.5;
		}
		gains[b] = gain;
	}
	const result = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) {
		const position = i / block - 0.5;
		const left = Math.max(0, Math.min(blocks - 1, Math.floor(position)));
		const right = Math.min(blocks - 1, left + 1);
		const mix = Math.max(0, Math.min(1, position - left));
		const value = samples[i]! * (gains[left]! * (1 - mix) + gains[right]! * mix);
		const size = Math.abs(value);
		result[i] = size <= 0.9 ? value : Math.sign(value) * (0.9 + 0.1 * Math.tanh((size - 0.9) / 0.1));
	}
	return result;
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
	const pcm = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i++) {
		const value = Number.isFinite(samples[i]) ? Math.max(-1, Math.min(1, samples[i]!)) : 0;
		pcm.writeInt16LE(Math.round(value * 32767), i * 2);
	}
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
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

// 16-bit PCM WAV, mono or stereo (mixed down to mono); other formats throw.
export function decodeWav(wav: Buffer): { samples: Float32Array; sampleRate: number } {
	if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
	let format: { channels: number; sampleRate: number; bits: number; tag: number } | undefined;
	for (let at = 12; at + 8 <= wav.length; ) {
		const id = wav.toString("ascii", at, at + 4);
		const size = wav.readUInt32LE(at + 4);
		const body = at + 8;
		if (id === "fmt ") format = { tag: wav.readUInt16LE(body), channels: wav.readUInt16LE(body + 2), sampleRate: wav.readUInt32LE(body + 4), bits: wav.readUInt16LE(body + 14) };
		if (id === "data") {
			if (!format || format.tag !== 1 || format.bits !== 16 || format.channels < 1) throw new Error("unsupported WAV format");
			const end = Math.min(wav.length, body + size);
			const frames = Math.floor((end - body) / (2 * format.channels));
			const samples = new Float32Array(frames);
			for (let frame = 0; frame < frames; frame++) {
				let sum = 0;
				for (let channel = 0; channel < format.channels; channel++) sum += wav.readInt16LE(body + (frame * format.channels + channel) * 2) / 32768;
				samples[frame] = sum / format.channels;
			}
			return { samples, sampleRate: format.sampleRate };
		}
		at = body + size + (size % 2);
	}
	throw new Error("WAV file without data");
}
