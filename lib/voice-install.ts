import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { gentlePiConfigHome } from "./agent-home.ts";
import {
	KWS_MODEL_MANIFEST,
	KWS_SPOTTER_FILES,
	PARAKEET_MODEL_MANIFEST,
	VOICE_TARGETS,
	voiceRuntimeManifest,
	type VoiceArchiveManifest,
	type VoiceModelManifest,
	type VoiceNpmPackage,
	type VoiceRedirectRule,
	type VoiceRuntimeManifest,
	type VoiceTarget,
} from "./voice-artifacts.ts";

// Explicit acquisition and status of the optional voice runtime, dictation model and
// wake-word keyword spotter (S1-S3, S7). Nothing runs at import: /gentle:voice calls
// these on request. A component is downloaded into a private staging directory under
// the voice home, verified by size and digest while it streams, and published with a
// single rename, with its install marker written last. A failure removes only that
// staging directory, so it never leaves a marker behind or alters a published
// component. Downloaded code is written to disk only; it is never loaded or executed
// here. The one archive this installer unpacks is extracted by the system tar into the
// staging directory and verified file by file before anything is published.

export type VoiceComponentKind = "runtime" | "model" | "kws";

export type VoiceInstallErrorCode = "aborted" | "timeout" | "http" | "redirect" | "size" | "integrity" | "archive" | "unsupported" | "io";

export class VoiceInstallError extends Error {
	readonly code: VoiceInstallErrorCode;

	constructor(code: VoiceInstallErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VoiceInstallError";
		this.code = code;
	}
}

// The subset of fetch the installer uses. Redirects are always handled here, so
// every hop is checked against the manifest's rules before it is requested.
export type VoiceFetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

export interface VoiceInstallProgress {
	component: VoiceComponentKind;
	phase: "download" | "extract" | "publish";
	// The model file or package name the event is about.
	item?: string;
	receivedBytes: number;
	totalBytes: number;
	overallReceivedBytes: number;
	overallTotalBytes: number;
}

export interface VoiceTimeouts {
	// The longest wait for response headers or the next body chunk.
	idleMs: number;
	// The whole install, from the first request to publication.
	totalMs: number;
}

interface VoiceInstallCommonOptions {
	// Defaults to resolveVoiceHome(env).
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	fetch?: VoiceFetch;
	signal?: AbortSignal;
	timeouts?: Partial<VoiceTimeouts>;
	onProgress?: (progress: VoiceInstallProgress) => void;
}

export interface VoiceModelInstallOptions extends VoiceInstallCommonOptions {
	manifest?: VoiceModelManifest;
}

export interface VoiceRuntimeInstallOptions extends VoiceInstallCommonOptions {
	target: VoiceTarget;
	manifest?: VoiceRuntimeManifest;
}

export interface VoiceKeywordSpotterInstallOptions extends VoiceInstallCommonOptions {
	manifest?: VoiceArchiveManifest;
	// Defaults to the system tar; tests inject a fake so none of them extract anything.
	extract?: VoiceExtractor;
}

export interface VoiceInstallResult {
	kind: VoiceComponentKind;
	path: string;
	alreadyInstalled: boolean;
}

export interface VoiceComponentStatus {
	kind: VoiceComponentKind;
	state: "installed" | "missing" | "invalid";
	path: string;
	reason?: string;
}

const MARKER = ".gentle-voice.json";
const MARKER_SCHEMA = 1;
const MAX_REDIRECTS = 5;
const IDLE_MS = 60_000;
const TOTAL_MS: Record<VoiceComponentKind, number> = { runtime: 20 * 60_000, model: 2 * 60 * 60_000, kws: 10 * 60_000 };
// Extracting a 17 MB archive is a few seconds of work; anything near this bound is stuck.
const EXTRACT_MS = 2 * 60_000;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Every component lives in one of two directories of the voice home; models of any
// kind share `models/`, each in the directory its manifest id names.
const COMPONENT_DIR: Record<VoiceComponentKind, string> = { runtime: "runtime", model: "models", kws: "models" };

// Everything voice owns lives in one directory of the Gentle AI config home.
export function resolveVoiceHome(env: NodeJS.ProcessEnv = process.env): string {
	return join(gentlePiConfigHome(env), "voice");
}

export function voiceComponentPath(voiceHome: string, kind: VoiceComponentKind, manifest: { id: string }): string {
	return join(voiceHome, COMPONENT_DIR[kind], manifest.id);
}

interface Marker {
	schema: number;
	kind: VoiceComponentKind;
	id: string;
	manifest: string;
	files: Array<{ path: string; size: number }>;
}

type VoiceManifest = VoiceModelManifest | VoiceRuntimeManifest | VoiceArchiveManifest;

const fingerprint = (manifest: VoiceManifest) => createHash("sha256").update(JSON.stringify(manifest)).digest("hex");

// Relative POSIX paths that resolve to the same file on every supported system:
// no traversal, separators, drive or stream colons, control characters, Windows
// device names, or trailing dots and spaces that Windows silently strips.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

function safeRelativeSegments(path: string): string[] | undefined {
	const segments = path.split("/");
	const safe = segments.every((s) => s !== "" && s !== "." && s !== ".." && !/[\\:\0-\x1f]/.test(s) && !/[. ]$/.test(s) && !WINDOWS_DEVICE.test(s));
	return safe ? segments : undefined;
}

// Reads only: a missing voice home is reported, never created.
export async function readVoiceComponentStatus(options: { voiceHome: string; kind: VoiceComponentKind; manifest: VoiceManifest }): Promise<VoiceComponentStatus> {
	const { voiceHome, kind, manifest } = options;
	const path = voiceComponentPath(voiceHome, kind, manifest);
	const invalid = (reason: string): VoiceComponentStatus => ({ kind, state: "invalid", path, reason });
	try {
		if (!(await lstat(path)).isDirectory()) return invalid("the install path is not a directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind, state: "missing", path };
		throw error;
	}
	let marker: Marker;
	try {
		marker = JSON.parse(await readFile(join(path, MARKER), "utf8")) as Marker;
	} catch {
		return invalid("the install marker is missing or unreadable");
	}
	if (marker?.schema !== MARKER_SCHEMA || marker.kind !== kind || marker.id !== manifest.id || marker.manifest !== fingerprint(manifest) || !Array.isArray(marker.files)) {
		return invalid("the install marker does not match the pinned manifest");
	}
	for (const file of marker.files) {
		const segments = typeof file?.path === "string" ? safeRelativeSegments(file.path) : undefined;
		if (!segments) return invalid("the install marker lists an unsafe path");
		const info = await lstat(join(path, ...segments)).catch(() => undefined);
		if (!info?.isFile() || info.size !== file.size) return invalid(`${file.path} is missing or changed`);
	}
	return { kind, state: "installed", path };
}

export interface VoiceStatusOptions {
	voiceHome?: string;
	env?: NodeJS.ProcessEnv;
	target?: VoiceTarget;
	// The wake-word model is optional and is not part of the dictation install, so this
	// reader only looks for it when the caller asks; the other components never change.
	keywordSpotter?: boolean;
}

export interface VoiceStatus {
	voiceHome: string;
	model: VoiceComponentStatus;
	runtime?: VoiceComponentStatus;
	keywordSpotter?: VoiceComponentStatus;
}

export async function readVoiceStatus(options: VoiceStatusOptions = {}): Promise<VoiceStatus> {
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const model = await readVoiceComponentStatus({ voiceHome, kind: "model", manifest: PARAKEET_MODEL_MANIFEST });
	const keywordSpotter = options.keywordSpotter ? await readVoiceComponentStatus({ voiceHome, kind: "kws", manifest: KWS_MODEL_MANIFEST }) : undefined;
	if (!options.target || !VOICE_TARGETS.includes(options.target)) return keywordSpotter ? { voiceHome, model, keywordSpotter } : { voiceHome, model };
	const runtime = await readVoiceComponentStatus({ voiceHome, kind: "runtime", manifest: voiceRuntimeManifest(options.target) });
	return keywordSpotter ? { voiceHome, model, runtime, keywordSpotter } : { voiceHome, model, runtime };
}

// --- Transfer ---------------------------------------------------------------

interface Transfer {
	component: VoiceComponentKind;
	fetch: VoiceFetch;
	controller: AbortController;
	idleMs: number;
	redirects: VoiceRedirectRule[];
	overallReceivedBytes: number;
	overallTotalBytes: number;
	onProgress?: (progress: VoiceInstallProgress) => void;
}

// Settles with the promise, or rejects with the abort reason (cancel, total or
// idle timeout) as soon as the install is aborted, whether or not the injected
// fetch or body stream honours the signal itself.
function untilAborted<T>(promise: Promise<T>, transfer: Transfer): Promise<T> {
	const { signal } = transfer.controller;
	const timer = setTimeout(() => transfer.controller.abort(new VoiceInstallError("timeout", `No data arrived for ${transfer.idleMs} ms.`)), transfer.idleMs);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		const settle = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
		if (signal.aborted) { settle(); reject(signal.reason); return; }
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then((value) => { settle(); resolve(value); }, (error) => { settle(); reject(error); });
	});
}

function permitted(url: URL, rules: VoiceRedirectRule[]): boolean {
	if (url.protocol !== "https:" || url.username || url.password) return false;
	return rules.some((rule) => url.origin === rule.origin && url.pathname.startsWith(rule.pathPrefix));
}

async function request(url: string, transfer: Transfer): Promise<Response> {
	let current = new URL(url);
	if (current.protocol !== "https:") throw new VoiceInstallError("redirect", `Refused a non-HTTPS source ${current.origin}.`);
	for (let hop = 0; ; hop++) {
		const response = await untilAborted(transfer.fetch(current.href, { signal: transfer.controller.signal, redirect: "manual", headers: { "accept-encoding": "identity" } }), transfer);
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			const location = response.headers.get("location");
			if (!location || hop >= MAX_REDIRECTS) throw new VoiceInstallError("redirect", `Too many or empty redirects from ${current.origin}${current.pathname}.`);
			const next = new URL(location, current);
			// The query is left out of messages: CDN redirects carry signed tokens.
			if (!permitted(next, transfer.redirects)) throw new VoiceInstallError("redirect", `Refused a redirect to ${next.protocol}//${next.host}${next.pathname}.`);
			current = next;
			continue;
		}
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			throw new VoiceInstallError("http", `${current.origin}${current.pathname} answered HTTP ${response.status}.`);
		}
		return response;
	}
}

interface Expected { item: string; size: number; algorithm: "sha256" | "sha512"; digest: string }

const encodeDigest = (algorithm: Expected["algorithm"], raw: Buffer) => (algorithm === "sha512" ? `sha512-${raw.toString("base64")}` : raw.toString("hex"));

// Streams one artifact to a new file, hashing as it goes. The body is never held
// whole in memory, and reading stops as soon as it exceeds the pinned size.
async function download(url: string, expected: Expected, destination: string, transfer: Transfer): Promise<void> {
	const response = await request(url, transfer);
	const declared = response.headers.get("content-length");
	if (declared !== null && Number(declared) !== expected.size) {
		void response.body?.cancel().catch(() => {});
		throw new VoiceInstallError("size", `${expected.item} is announced as ${declared} bytes, expected ${expected.size}.`);
	}
	if (!response.body) throw new VoiceInstallError("http", `${expected.item} has no response body.`);
	const reader = response.body.getReader();
	const hash = createHash(expected.algorithm);
	const file = await open(destination, "wx", 0o600);
	let received = 0;
	let finished = false;
	try {
		for (;;) {
			const { done, value } = await untilAborted(reader.read(), transfer);
			if (done) { finished = true; break; }
			received += value.byteLength;
			if (received > expected.size) throw new VoiceInstallError("size", `${expected.item} is larger than the pinned ${expected.size} bytes.`);
			hash.update(value);
			await file.write(value);
			transfer.overallReceivedBytes += value.byteLength;
			transfer.onProgress?.({ component: transfer.component, phase: "download", item: expected.item, receivedBytes: received, totalBytes: expected.size, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes: transfer.overallTotalBytes });
		}
	} finally {
		if (!finished) void reader.cancel().catch(() => {});
		await file.close();
	}
	if (received !== expected.size) throw new VoiceInstallError("size", `${expected.item} ended after ${received} of ${expected.size} bytes.`);
	if (encodeDigest(expected.algorithm, hash.digest()) !== expected.digest) throw new VoiceInstallError("integrity", `${expected.item} does not match its pinned ${expected.algorithm} digest.`);
}

// --- Staging and publication ------------------------------------------------

type Build = (payload: string, staging: string, transfer: Transfer) => Promise<Marker["files"]>;

async function install(kind: VoiceComponentKind, manifest: VoiceManifest, overallTotalBytes: number, redirects: VoiceRedirectRule[], options: VoiceInstallCommonOptions, build: Build): Promise<VoiceInstallResult> {
	if (options.signal?.aborted) throw new VoiceInstallError("aborted", "Voice install was cancelled.");
	const voiceHome = options.voiceHome ?? resolveVoiceHome(options.env);
	const finalPath = voiceComponentPath(voiceHome, kind, manifest);
	if ((await readVoiceComponentStatus({ voiceHome, kind, manifest })).state === "installed") return { kind, path: finalPath, alreadyInstalled: true };

	const controller = new AbortController();
	const onAbort = () => controller.abort(new VoiceInstallError("aborted", "Voice install was cancelled."));
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const totalMs = options.timeouts?.totalMs ?? TOTAL_MS[kind];
	const deadline = setTimeout(() => controller.abort(new VoiceInstallError("timeout", `Voice install exceeded ${totalMs} ms.`)), totalMs);
	const transfer: Transfer = {
		component: kind,
		fetch: options.fetch ?? ((url, init) => fetch(url, init)),
		controller,
		idleMs: options.timeouts?.idleMs ?? IDLE_MS,
		redirects,
		overallReceivedBytes: 0,
		overallTotalBytes,
		onProgress: options.onProgress,
	};
	let staging: string | undefined;
	try {
		await mkdir(voiceHome, { recursive: true, mode: 0o700 });
		// mkdtemp creates the directory with mode 0700 and a fresh random name.
		staging = await mkdtemp(join(voiceHome, ".staging-"));
		const payload = join(staging, "payload");
		await mkdir(payload, { mode: 0o700 });
		const files = await build(payload, staging, transfer);
		if (controller.signal.aborted) throw controller.signal.reason;
		const marker: Marker = { schema: MARKER_SCHEMA, kind, id: manifest.id, manifest: fingerprint(manifest), files };
		await writeFile(join(payload, MARKER), `${JSON.stringify(marker, null, "\t")}\n`, { flag: "wx", mode: 0o600 });
		transfer.onProgress?.({ component: kind, phase: "publish", receivedBytes: 0, totalBytes: 0, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes });
		return await publish(kind, manifest, voiceHome, staging, payload, finalPath);
	} catch (error) {
		if (error instanceof VoiceInstallError) throw error;
		if (controller.signal.aborted) throw controller.signal.reason;
		throw new VoiceInstallError("io", `Voice install failed: ${(error as Error).message}`, { cause: error });
	} finally {
		clearTimeout(deadline);
		options.signal?.removeEventListener("abort", onAbort);
		// Only the staging directory this call created is ever removed.
		if (staging) await rm(staging, { recursive: true, force: true });
	}
}

// One rename publishes the complete payload. An invalid previous directory is
// first moved into this install's staging, so it is restored if the rename fails
// and discarded with the staging once the new component is in place.
async function publish(kind: VoiceComponentKind, manifest: VoiceManifest, voiceHome: string, staging: string, payload: string, finalPath: string): Promise<VoiceInstallResult> {
	await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
	const existing = await readVoiceComponentStatus({ voiceHome, kind, manifest });
	if (existing.state === "installed") return { kind, path: finalPath, alreadyInstalled: true };
	const previous = join(staging, "previous");
	if (existing.state === "invalid") await rename(finalPath, previous);
	try {
		await rename(payload, finalPath);
	} catch (error) {
		if (existing.state === "invalid") await rename(previous, finalPath).catch(() => {});
		// A concurrent install may have published the same component first.
		if ((await readVoiceComponentStatus({ voiceHome, kind, manifest })).state === "installed") return { kind, path: finalPath, alreadyInstalled: true };
		throw error;
	}
	return { kind, path: finalPath, alreadyInstalled: false };
}

// --- Model ------------------------------------------------------------------

export async function installVoiceModel(options: VoiceModelInstallOptions = {}): Promise<VoiceInstallResult> {
	const manifest = options.manifest ?? PARAKEET_MODEL_MANIFEST;
	if (!SAFE_ID.test(manifest.id) || !manifest.files.every((file) => SAFE_FILE.test(file.name))) {
		throw new VoiceInstallError("unsupported", "The model manifest names an unsafe path.");
	}
	const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
	return install("model", manifest, total, manifest.redirects, options, async (payload, _staging, transfer) => {
		for (const file of manifest.files) {
			await download(`${manifest.baseUrl}/${file.name}`, { item: file.name, size: file.size, algorithm: "sha256", digest: file.sha256 }, join(payload, file.name), transfer);
		}
		return manifest.files.map((file) => ({ path: file.name, size: file.size }));
	});
}

// --- Runtime ----------------------------------------------------------------

interface ArchiveEntry { path: string; segments: string[]; executable: boolean; data: Buffer }

const cString = (block: Buffer, start: number, end: number) => {
	const field = block.subarray(start, end);
	const nul = field.indexOf(0);
	return field.subarray(0, nul === -1 ? field.length : nul).toString("utf8");
};

function octal(block: Buffer, start: number, end: number): number {
	const text = cString(block, start, end).trim();
	return /^[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number.NaN;
}

// Validates a whole npm tarball before anything is written: only regular files
// under package/, no links, devices, directories or extended headers, no
// traversal, case-insensitive duplicates or file/directory clashes, and no more
// entries or bytes than the registry metadata records.
function readArchive(compressed: Buffer, pkg: VoiceNpmPackage): ArchiveEntry[] {
	const reject = (reason: string): never => { throw new VoiceInstallError("archive", `${pkg.name}: ${reason}.`); };
	let tar: Buffer;
	try {
		tar = gunzipSync(compressed, { maxOutputLength: pkg.unpackedSize + (pkg.fileCount + 2) * 1024 + 10240 });
	} catch {
		return reject("the archive does not decompress within its pinned size");
	}
	const entries: ArchiveEntry[] = [];
	const files = new Set<string>();
	const directories = new Set<string>();
	let unpacked = 0;
	let offset = 0;
	let ended = false;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			if (!tar.subarray(offset).every((byte) => byte === 0)) reject("data follows the end of the archive");
			ended = true;
			break;
		}
		let sum = 0;
		for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
		if (octal(header, 148, 156) !== sum || cString(header, 257, 263) !== "ustar") reject("an entry header is corrupt");
		const type = header[156];
		if (type !== 0x30 && type !== 0) reject(`entry type '${String.fromCharCode(type!)}' is not a regular file`);
		const name = cString(header, 0, 100);
		const prefix = cString(header, 345, 500);
		const full = prefix ? `${prefix}/${name}` : name;
		if (!full.startsWith("package/")) reject(`${full} is outside package/`);
		const relative = full.slice("package/".length);
		const segments = safeRelativeSegments(relative) ?? reject(`${full} is not a safe relative path`);
		const key = relative.toLowerCase();
		if (files.has(key) || directories.has(key)) reject(`${full} is duplicated`);
		for (let i = 1; i < segments.length; i++) {
			const ancestor = segments.slice(0, i).join("/").toLowerCase();
			if (files.has(ancestor)) reject(`${full} uses a file as a directory`);
			directories.add(ancestor);
		}
		files.add(key);
		const size = octal(header, 124, 136);
		if (!Number.isSafeInteger(size)) reject(`${full} has an invalid size`);
		unpacked += size;
		if (entries.length + 1 > pkg.fileCount) reject(`more than ${pkg.fileCount} entries`);
		if (unpacked > pkg.unpackedSize) reject(`more than ${pkg.unpackedSize} unpacked bytes`);
		const start = offset + 512;
		if (start + size > tar.length) reject(`${full} is truncated`);
		entries.push({ path: relative, segments, executable: (octal(header, 100, 108) & 0o111) !== 0, data: tar.subarray(start, start + size) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	if (!ended) reject("the archive has no end marker");
	const present = new Set(entries.map((entry) => entry.path));
	for (const required of pkg.requiredFiles) if (!present.has(required)) reject(`${required} is missing`);
	return entries;
}

// Installs sherpa-onnx-node, its platform package and node-cpal as sibling directories of one node_modules, the layout the sherpa-onnx
// loader resolves. No package script runs and nothing is loaded.
export async function installVoiceRuntime(options: VoiceRuntimeInstallOptions): Promise<VoiceInstallResult> {
	if (!VOICE_TARGETS.includes(options.target)) throw new VoiceInstallError("unsupported", `Voice dictation has no pinned runtime for ${String(options.target)}.`);
	const manifest = options.manifest ?? voiceRuntimeManifest(options.target);
	if (manifest.target !== options.target || !SAFE_ID.test(manifest.id) || !manifest.packages.every((pkg) => SAFE_ID.test(pkg.name))) {
		throw new VoiceInstallError("unsupported", "The runtime manifest does not describe this target safely.");
	}
	const total = manifest.packages.reduce((sum, pkg) => sum + pkg.size, 0);
	return install("runtime", manifest, total, manifest.redirects, options, async (payload, staging, transfer) => {
		const downloads = join(staging, "downloads");
		await mkdir(downloads, { mode: 0o700 });
		for (const pkg of manifest.packages) {
			await download(pkg.tarball, { item: pkg.name, size: pkg.size, algorithm: "sha512", digest: pkg.integrity }, join(downloads, `${pkg.name}.tgz`), transfer);
		}
		// Every archive is validated before the first file is extracted.
		const archives: Array<[VoiceNpmPackage, ArchiveEntry[]]> = [];
		for (const pkg of manifest.packages) archives.push([pkg, readArchive(await readFile(join(downloads, `${pkg.name}.tgz`)), pkg)]);
		const files: Marker["files"] = [];
		for (const [pkg, entries] of archives) {
			transfer.onProgress?.({ component: "runtime", phase: "extract", item: pkg.name, receivedBytes: 0, totalBytes: pkg.unpackedSize, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes: total });
			const root = join(payload, "node_modules", pkg.name);
			for (const entry of entries) {
				const destination = join(root, ...entry.segments);
				if (!destination.startsWith(root + sep)) throw new VoiceInstallError("archive", `${pkg.name}: ${entry.path} escapes the package.`);
				await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
				await writeFile(destination, entry.data, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
				files.push({ path: posix.join("node_modules", pkg.name, entry.path), size: entry.data.length });
			}
		}
		return files;
	});
}

// --- Keyword spotter ----------------------------------------------------------

// One extraction written by hand, so the archive step is injectable: no test ever
// runs tar or downloads anything.
export interface VoiceExtractRequest {
	// The verified archive inside the staging directory.
	archive: string;
	// The empty component payload the pinned members are written into.
	destination: string;
	// Exact member names, each `<manifest prefix>/<kept file>`; nothing else is extracted.
	members: string[];
	timeoutMs: number;
	signal: AbortSignal;
}

export type VoiceExtractor = (request: VoiceExtractRequest) => Promise<void>;

export type VoiceSpawnOptions = { shell: false; stdio: "ignore"; windowsHide: true };

export interface VoiceSpawnHandle {
	on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
	on(event: "close", listener: (code: number | null) => void): unknown;
	kill(): unknown;
}

// The child process is always started without a shell and with stdin and output
// discarded: tar writes nothing we read, and its messages never reach an error.
export type VoiceSpawn = (command: string, args: readonly string[], options: VoiceSpawnOptions) => VoiceSpawnHandle;

const spawnProcess: VoiceSpawn = (command, args, options) => nodeSpawn(command, [...args], options as Parameters<typeof nodeSpawn>[2]);

// Unpacks the pinned .tar.bz2 with the system tar, which reads bzip2 through `-j`.
// Only the pinned member names are named, the release's wrapping directory is
// stripped, and the destination is a fresh directory inside the staging area, so no
// entry can be created outside it. A missing tar, a non-zero exit and a stuck
// extraction all fail closed with a fixed message; tar's own output is discarded.
export function createTarExtractor(spawn: VoiceSpawn = spawnProcess): VoiceExtractor {
	return (request) => new Promise<void>((resolve, reject) => {
		const args = ["-x", "-j", "-f", request.archive, "-C", request.destination, "--strip-components=1", ...request.members];
		let child: VoiceSpawnHandle;
		try {
			child = spawn("tar", args, { shell: false, stdio: "ignore", windowsHide: true });
		} catch (error) {
			reject(new VoiceInstallError("unsupported", "The system tar could not be started, so the wake-word model cannot be unpacked.", { cause: error }));
			return;
		}
		let settled = false;
		const finish = (error?: VoiceInstallError) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			request.signal.removeEventListener("abort", onAbort);
			if (error) reject(error); else resolve();
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(new VoiceInstallError("timeout", `Extracting the wake-word model did not finish within ${request.timeoutMs} ms.`));
		}, request.timeoutMs);
		const onAbort = () => {
			child.kill();
			const reason = request.signal.reason;
			finish(reason instanceof VoiceInstallError ? reason : new VoiceInstallError("aborted", "Voice install was cancelled."));
		};
		child.on("error", (error) => {
			finish(error?.code === "ENOENT"
				? new VoiceInstallError("unsupported", "Unpacking the wake-word model needs the system tar with bzip2 support, and tar was not found.", { cause: error })
				: new VoiceInstallError("unsupported", "The system tar could not be started, so the wake-word model cannot be unpacked.", { cause: error }));
		});
		child.on("close", (code) => {
			if (code === 0) finish();
			else finish(new VoiceInstallError("archive", `tar exited with code ${String(code)} while unpacking the wake-word model.`));
		});
		request.signal.addEventListener("abort", onAbort, { once: true });
		if (request.signal.aborted) onAbort();
	});
}

function assertKeywordArchive(manifest: VoiceArchiveManifest): void {
	const invalid = (reason: string): never => { throw new VoiceInstallError("unsupported", `The keyword spotter manifest is not usable: ${reason}.`); };
	if (!SAFE_ID.test(manifest.id)) invalid("its id is not a plain lowercase name");
	if (manifest.archive.format !== "tar.bz2") invalid("its archive is not a .tar.bz2");
	if (!manifest.archive.url.startsWith("https://")) invalid("its archive url is not HTTPS");
	if (!SAFE_FILE.test(manifest.archive.prefix)) invalid("its archive prefix is not a single safe directory name");
	if (manifest.files.length === 0) invalid("it keeps no file");
	const seen = new Set<string>();
	for (const file of manifest.files) {
		if (!SAFE_FILE.test(file.name)) invalid(`${String(file.name)} is not a plain file name`);
		if (seen.has(file.name)) invalid(`${file.name} is listed twice`);
		seen.add(file.name);
	}
}

// Every kept file must match its pinned size and digest, and nothing else may be
// left in the payload: a link, a directory or an entry the manifest does not name
// means the extraction is not the one that was pinned.
async function verifyExtraction(payload: string, manifest: VoiceArchiveManifest): Promise<Marker["files"]> {
	const kept = new Set(manifest.files.map((file) => file.name));
	for (const entry of await readdir(payload)) {
		if (!kept.has(entry)) throw new VoiceInstallError("archive", `${manifest.id}: the extraction left ${entry}, which the manifest does not pin.`);
	}
	const files: Marker["files"] = [];
	for (const file of manifest.files) {
		const path = join(payload, file.name);
		const info = await lstat(path).catch(() => undefined);
		if (!info) throw new VoiceInstallError("archive", `${manifest.id}: ${file.name} is missing after extraction.`);
		if (!info.isFile()) throw new VoiceInstallError("archive", `${manifest.id}: ${file.name} is not a regular file after extraction.`);
		if (info.size !== file.size) throw new VoiceInstallError("integrity", `${manifest.id}: ${file.name} does not match its pinned size.`);
		const digest = createHash("sha256").update(await readFile(path)).digest("hex");
		if (digest !== file.sha256) throw new VoiceInstallError("integrity", `${manifest.id}: ${file.name} does not match its pinned sha256 digest.`);
		files.push({ path: file.name, size: file.size });
	}
	return files;
}

// Downloads the pinned archive, verifies its digest before a single byte is
// unpacked, extracts only the pinned members with the system tar, and publishes the
// component only when every kept file matches its own pinned size and sha256.
export async function installVoiceKeywordSpotter(options: VoiceKeywordSpotterInstallOptions = {}): Promise<VoiceInstallResult> {
	const manifest = options.manifest ?? KWS_MODEL_MANIFEST;
	assertKeywordArchive(manifest);
	const extract = options.extract ?? createTarExtractor();
	const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
	return install("kws", manifest, manifest.archive.size, manifest.redirects, options, async (payload, staging, transfer) => {
		const archive = join(staging, "archive.tar.bz2");
		await download(manifest.archive.url, { item: `${manifest.id}.tar.bz2`, size: manifest.archive.size, algorithm: "sha256", digest: manifest.archive.sha256 }, archive, transfer);
		transfer.onProgress?.({ component: "kws", phase: "extract", item: manifest.id, receivedBytes: 0, totalBytes: total, overallReceivedBytes: transfer.overallReceivedBytes, overallTotalBytes: manifest.archive.size });
		await extract({ archive, destination: payload, members: manifest.files.map((file) => `${manifest.archive.prefix}/${file.name}`), timeoutMs: EXTRACT_MS, signal: transfer.controller.signal });
		return verifyExtraction(payload, manifest);
	});
}

export interface VoiceKeywordSpotterPaths {
	encoder: string;
	decoder: string;
	joiner: string;
	tokens: string;
}

// The four files the spotter loads, resolved only while the component is published
// and valid: absent, half extracted or changed on disk all mean no keyword spotting.
export async function resolveVoiceKeywordSpotterPaths(options: { voiceHome: string; manifest?: VoiceArchiveManifest }): Promise<VoiceKeywordSpotterPaths | undefined> {
	const manifest = options.manifest ?? KWS_MODEL_MANIFEST;
	const status = await readVoiceComponentStatus({ voiceHome: options.voiceHome, kind: "kws", manifest });
	if (status.state !== "installed") return undefined;
	return {
		encoder: join(status.path, KWS_SPOTTER_FILES.encoder),
		decoder: join(status.path, KWS_SPOTTER_FILES.decoder),
		joiner: join(status.path, KWS_SPOTTER_FILES.joiner),
		tokens: join(status.path, KWS_SPOTTER_FILES.tokens),
	};
}
