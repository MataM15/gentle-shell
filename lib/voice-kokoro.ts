import { VOICE_TARGETS, voiceRuntimeManifest, type VoiceModelManifest, type VoiceNotice, type VoiceTarget } from "./voice-artifacts.ts";
import type { KokoroLaunch } from "./voice-kokoro-engine.ts";
import { installVoiceModel, readVoiceComponentStatus, resolveVoiceHome, voiceComponentPath, type VoiceComponentStatus, type VoiceFetch, type VoiceInstallProgress } from "./voice-install.ts";

// The natural voice for spoken replies (docs/voice.md, "Natural voice with
// Kokoro"): the Kokoro v1.0 multi-language sherpa-onnx export at a fixed
// Hugging Face commit, run by the sherpa-onnx runtime that dictation already
// installs. Only what Spanish and English need is downloaded.
//
// The installer accepts flat file names only, a guard this feature keeps as it
// is. The espeak-ng phoneme data lives in nested folders upstream, so it is
// installed as three flat components, one per folder, and the TTS worker copies
// them into the tree espeak-ng expects inside a private temporary directory.

const KOKORO_REPO = "csukuangfj/kokoro-multi-lang-v1_0";
const KOKORO_REVISION = "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b";
const SHORT = KOKORO_REVISION.slice(0, 12);
const BASE = `https://huggingface.co/${KOKORO_REPO}/resolve/${KOKORO_REVISION}`;

// Observed redirects, as for Parakeet: small files answer 307 with a
// same-origin resolve-cache path, LFS/Xet files 302 to the us.aws Xet bridge.
const REDIRECTS = [
	{ origin: "https://huggingface.co", pathPrefix: `/api/resolve-cache/models/${KOKORO_REPO}/${KOKORO_REVISION}/` },
	{ origin: "https://us.aws.cdn.hf.co", pathPrefix: "/xet-bridge-us/" },
];

const manifest = (id: string, folder: string, files: VoiceModelManifest["files"]): VoiceModelManifest => ({
	id: `${id}-${SHORT}`,
	revision: KOKORO_REVISION,
	baseUrl: folder ? `${BASE}/${folder}` : BASE,
	files,
	redirects: REDIRECTS,
});

// Every size and digest was checked against the upstream GitHub release
// tarball kokoro-multi-lang-v1_0.tar.bz2 (sha256 60703707bc05ccd4...), whose
// files are byte-identical.
export const KOKORO_MANIFESTS = {
	core: manifest("kokoro-multi-lang-v1_0", "", [
		{ name: "model.onnx", size: 325560556, sha256: "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11" },
		{ name: "voices.bin", size: 28200960, sha256: "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29" },
		{ name: "tokens.txt", size: 687, sha256: "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425" },
		{ name: "LICENSE", size: 11358, sha256: "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30" },
	]),
	espeak: manifest("kokoro-espeak-ng-data", "espeak-ng-data", [
		{ name: "phontab", size: 55796, sha256: "886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6" },
		{ name: "phonindex", size: 39074, sha256: "3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4" },
		{ name: "phondata", size: 550424, sha256: "4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3" },
		{ name: "intonations", size: 2040, sha256: "3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc" },
		{ name: "es_dict", size: 49252, sha256: "3fa93e251eab80838a2d6207ee58c9c847270a65fe3fae98850e0185b5a2186c" },
		{ name: "en_dict", size: 166944, sha256: "71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35" },
	]),
	espeakRomance: manifest("kokoro-espeak-lang-roa", "espeak-ng-data/lang/roa", [
		{ name: "es", size: 63, sha256: "966aa015ea5646d79f0ca4807cf5da7339aabd3782b55cfa5eb0d8c3fc8fc588" },
		{ name: "es-419", size: 167, sha256: "ff0f84457ac40e3bcf61d6de58028312be74e0e6cbc3b742f31b3ce729c2aa0c" },
	]),
	espeakGermanic: manifest("kokoro-espeak-lang-gmw", "espeak-ng-data/lang/gmw", [
		{ name: "en", size: 140, sha256: "4605d5330801de3641c6e366d15f129ea1f5ffbce8722642aba01ace07ab9c83" },
		{ name: "en-US", size: 257, sha256: "41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704" },
	]),
} as const satisfies Record<string, VoiceModelManifest>;

export type KokoroPart = keyof typeof KOKORO_MANIFESTS;
export const KOKORO_PARTS = Object.keys(KOKORO_MANIFESTS) as KokoroPart[];

// Where each espeak component goes inside the assembled espeak-ng-data tree.
export const KOKORO_ESPEAK_LAYOUT: Record<Exclude<KokoroPart, "core">, string> = {
	espeak: "",
	espeakRomance: "lang/roa",
	espeakGermanic: "lang/gmw",
};

export const kokoroBytes = (manifests: Record<KokoroPart, VoiceModelManifest> = KOKORO_MANIFESTS): number =>
	KOKORO_PARTS.reduce((sum, part) => sum + manifests[part].files.reduce((total, file) => total + file.size, 0), 0);

// Speaker ids of the v1.0 voice table (sherpa-onnx docs, kokoro-multi-lang-v1_0).
export const KOKORO_VOICES = {
	es: { sid: 28, name: "ef_dora" },
	en: { sid: 3, name: "af_heart" },
} as const;

export const KOKORO_NOTICES: readonly VoiceNotice[] = [
	{
		component: "Kokoro-82M v1.0",
		license: "Apache-2.0",
		source: "https://huggingface.co/hexgrad/Kokoro-82M",
		attribution: `Kokoro-82M by hexgrad, licensed under Apache-2.0; sherpa-onnx export ${KOKORO_REPO} by csukuangfj.`,
	},
	{
		component: "espeak-ng-data",
		license: "GPL-3.0-or-later",
		source: "https://github.com/espeak-ng/espeak-ng",
		attribution: "espeak-ng phoneme data (Spanish and English only), licensed under GPL-3.0-or-later, used to turn text into phonemes.",
	},
];

export type KokoroState = "installed" | "missing" | "partial" | "invalid";

export interface KokoroStatus {
	state: KokoroState;
	voiceHome: string;
	// Installed component directories, by part, when state is installed.
	roots?: Record<KokoroPart, string>;
}

export async function readKokoroStatus(options: { voiceHome?: string; env?: NodeJS.ProcessEnv; manifests?: Record<KokoroPart, VoiceModelManifest> } = {}): Promise<KokoroStatus> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	const states = await Promise.all(KOKORO_PARTS.map((part) => readVoiceComponentStatus({ voiceHome, kind: "model", manifest: manifests[part] }).then((status) => status.state)));
	if (states.every((state) => state === "installed")) {
		const roots = Object.fromEntries(KOKORO_PARTS.map((part) => [part, voiceComponentPath(voiceHome, "model", manifests[part])])) as Record<KokoroPart, string>;
		return { state: "installed", voiceHome, roots };
	}
	if (states.some((state) => state === "invalid")) return { state: "invalid", voiceHome };
	return { state: states.some((state) => state === "installed") ? "partial" : "missing", voiceHome };
}

export interface KokoroInstallOptions {
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onProgress?: (progress: VoiceInstallProgress) => void;
	// Tests only: other manifests and a fake fetch, as the installer allows.
	manifests?: Record<KokoroPart, VoiceModelManifest>;
	fetch?: VoiceFetch;
}

// Installs every part in order through the pinned-model installer: each file is
// checked against its size and digest, and each part is published atomically.
// A part that is already installed is kept. Rejects with VoiceInstallError.
export async function installKokoro(options: KokoroInstallOptions = {}): Promise<void> {
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	for (const part of KOKORO_PARTS) {
		if (options.signal?.aborted) return;
		await installVoiceModel({ voiceHome: options.voiceHome, env: options.env, signal: options.signal, onProgress: options.onProgress, manifest: manifests[part], fetch: options.fetch });
	}
}

// What the speech worker needs for one reading, when Kokoro and the voice
// runtime for this platform are both installed; undefined otherwise.
export async function resolveKokoroLaunch(options: {
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	manifests?: Record<KokoroPart, VoiceModelManifest>;
	// Tests only: the runtime status, read from the pinned manifest by default.
	readRuntime?: (voiceHome: string) => Promise<VoiceComponentStatus>;
} = {}): Promise<KokoroLaunch | undefined> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	const status = await readKokoroStatus({ voiceHome, manifests });
	if (status.state !== "installed" || !status.roots) return undefined;
	const target = `${process.platform}-${process.arch}` as VoiceTarget;
	const readRuntime = options.readRuntime ?? ((home: string) => (VOICE_TARGETS.includes(target) ? readVoiceComponentStatus({ voiceHome: home, kind: "runtime", manifest: voiceRuntimeManifest(target) }) : Promise.resolve(undefined as unknown as VoiceComponentStatus)));
	const runtime = await readRuntime(voiceHome);
	if (runtime?.state !== "installed") return undefined;
	const files = (part: KokoroPart) => manifests[part].files.map(({ name, size }) => ({ name, size }));
	return {
		runtimeRoot: runtime.path,
		core: { root: status.roots.core, files: files("core") },
		espeak: (["espeak", "espeakRomance", "espeakGermanic"] as const).map((part) => ({ root: status.roots![part], folder: KOKORO_ESPEAK_LAYOUT[part] as KokoroLaunch["espeak"][number]["folder"], files: files(part) })),
	};
}

// --- the Miro voice (Piper) ------------------------------------------------------------

// Miro, a Spanish (Spain) Piper VITS voice chosen by the owner, at a fixed Hugging
// Face commit. Sizes and digests were checked against the sherpa-onnx release
// tarball vits-piper-es_ES-miro-high.tar.bz2, whose files are identical. It
// reuses the Spanish and English phoneme data Kokoro installs, so installing it
// fetches those small parts too when they are missing.
const MIRO_REPO = "csukuangfj/vits-piper-es_ES-miro-high";
const MIRO_REVISION = "0e1f773561429a9e50fa23d868a40eb341ad83c4";

export const MIRO_MANIFEST: VoiceModelManifest = {
	// Install ids are lowercase by the installer's path guard.
	id: `vits-piper-es-es-miro-high-${MIRO_REVISION.slice(0, 12)}`,
	revision: MIRO_REVISION,
	baseUrl: `https://huggingface.co/${MIRO_REPO}/resolve/${MIRO_REVISION}`,
	files: [
		{ name: "es_ES-miro-high.onnx", size: 63153775, sha256: "e18073d75c92a5441e0d2770b241f877e984b123e3186ab70a5346c0df999fc5" },
		{ name: "tokens.txt", size: 954, sha256: "620e1aecf1a68fea3ba5850d137b0138fa2037c9b372dad13b95a2a215d0849a" },
		// The license text travels with the model.
		{ name: "README.md", size: 856, sha256: "d759b76d463c7fd92bb382e2575bafe9d8d82c5adeef6a7d7ba0b048a21cc57e" },
	],
	redirects: [
		{ origin: "https://huggingface.co", pathPrefix: `/api/resolve-cache/models/${MIRO_REPO}/${MIRO_REVISION}/` },
		{ origin: "https://us.aws.cdn.hf.co", pathPrefix: "/xet-bridge-us/" },
	],
};

export const MIRO_NOTICE: VoiceNotice = {
	component: "es_ES-miro-high (Piper)",
	license: "CC-BY-NC-SA-4.0",
	source: `https://huggingface.co/${MIRO_REPO}`,
	attribution: "Piper voice es_ES miro (high), licensed under CC BY-NC-SA 4.0: non-commercial use only.",
};

const ESPEAK_PARTS = ["espeak", "espeakRomance", "espeakGermanic"] as const;

export const miroBytes = (manifests: Record<KokoroPart, VoiceModelManifest> = KOKORO_MANIFESTS, miro: VoiceModelManifest = MIRO_MANIFEST): number =>
	[miro, ...ESPEAK_PARTS.map((part) => manifests[part])].reduce((sum, manifest) => sum + manifest.files.reduce((total, file) => total + file.size, 0), 0);

interface MiroOptions {
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	// Tests only: other manifests.
	miro?: VoiceModelManifest;
	manifests?: Record<KokoroPart, VoiceModelManifest>;
}

export async function readMiroStatus(options: MiroOptions = {}): Promise<{ state: KokoroState; voiceHome: string }> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	const all = [options.miro ?? MIRO_MANIFEST, ...ESPEAK_PARTS.map((part) => manifests[part])];
	const states = await Promise.all(all.map((manifest) => readVoiceComponentStatus({ voiceHome, kind: "model", manifest }).then((status) => status.state)));
	if (states.every((state) => state === "installed")) return { state: "installed", voiceHome };
	if (states.some((state) => state === "invalid")) return { state: "invalid", voiceHome };
	return { state: states.some((state) => state === "installed") ? "partial" : "missing", voiceHome };
}

// Installs the shared phoneme data, then Miro, through the pinned-model installer.
export async function installMiro(options: MiroOptions & { signal?: AbortSignal; onProgress?: (progress: VoiceInstallProgress) => void; fetch?: VoiceFetch } = {}): Promise<void> {
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	for (const manifest of [...ESPEAK_PARTS.map((part) => manifests[part]), options.miro ?? MIRO_MANIFEST]) {
		if (options.signal?.aborted) return;
		await installVoiceModel({ voiceHome: options.voiceHome, env: options.env, signal: options.signal, onProgress: options.onProgress, manifest, fetch: options.fetch });
	}
}

export async function resolveMiroLaunch(options: MiroOptions & { readRuntime?: (voiceHome: string) => Promise<VoiceComponentStatus> } = {}): Promise<KokoroLaunch | undefined> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const manifests = options.manifests ?? KOKORO_MANIFESTS;
	const miro = options.miro ?? MIRO_MANIFEST;
	if ((await readMiroStatus({ ...options, voiceHome })).state !== "installed") return undefined;
	const target = `${process.platform}-${process.arch}` as VoiceTarget;
	const readRuntime = options.readRuntime ?? ((home: string) => (VOICE_TARGETS.includes(target) ? readVoiceComponentStatus({ voiceHome: home, kind: "runtime", manifest: voiceRuntimeManifest(target) }) : Promise.resolve(undefined as unknown as VoiceComponentStatus)));
	const runtime = await readRuntime(voiceHome);
	if (runtime?.state !== "installed") return undefined;
	const sized = (manifest: VoiceModelManifest, keep: (name: string) => boolean = () => true) => manifest.files.filter((file) => keep(file.name)).map(({ name, size }) => ({ name, size }));
	return {
		kind: "piper",
		runtimeRoot: runtime.path,
		core: { root: voiceComponentPath(voiceHome, "model", miro), files: sized(miro, (name) => name !== "README.md") },
		espeak: ESPEAK_PARTS.map((part) => ({ root: voiceComponentPath(voiceHome, "model", manifests[part]), folder: KOKORO_ESPEAK_LAYOUT[part] as KokoroLaunch["espeak"][number]["folder"], files: sized(manifests[part]) })),
	};
}
