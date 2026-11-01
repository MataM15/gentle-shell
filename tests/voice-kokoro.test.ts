import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import type { VoiceModelManifest } from "../lib/voice-artifacts.ts";
import { installKokoro, installMiro, KOKORO_ESPEAK_LAYOUT, KOKORO_MANIFESTS, KOKORO_PARTS, KOKORO_VOICES, kokoroBytes, MIRO_MANIFEST, miroBytes, readKokoroStatus, readMiroStatus, resolveKokoroLaunch, resolveMiroLaunch, type KokoroPart } from "../lib/voice-kokoro.ts";
import { VoiceInstallError, type VoiceFetch } from "../lib/voice-install.ts";

// The pinned Kokoro download (S6): what is fetched, from where, and how the
// existing installer publishes it. Fake fetches only; nothing reaches the network.

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const homes: string[] = [];
const scratchHome = () => {
	const home = mkdtempSync(join(scratchRoot, "voice-kokoro-"));
	homes.push(home);
	return join(home, "voice");
};
after(() => {
	for (const home of homes) rmSync(home, { recursive: true, force: true });
});

test("the pinned manifests fetch flat names from one fixed Hugging Face commit and the observed redirects only", () => {
	const ids = new Set<string>();
	for (const part of KOKORO_PARTS) {
		const manifest = KOKORO_MANIFESTS[part];
		assert.match(manifest.baseUrl, /^https:\/\/huggingface\.co\/csukuangfj\/kokoro-multi-lang-v1_0\/resolve\/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b(\/|$)/);
		assert.equal(manifest.revision, "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b");
		assert.ok(manifest.id.endsWith("-f7b96bb6bef5"), manifest.id);
		ids.add(manifest.id);
		for (const file of manifest.files) {
			assert.match(file.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "flat names only: the installer guard is unchanged");
			assert.match(file.sha256, /^[0-9a-f]{64}$/);
		}
		assert.deepEqual(manifest.redirects.map((rule) => rule.origin), ["https://huggingface.co", "https://us.aws.cdn.hf.co"]);
	}
	assert.equal(ids.size, KOKORO_PARTS.length, "every part installs into its own directory");
	assert.deepEqual(KOKORO_MANIFESTS.core.files.map((file) => file.name), ["model.onnx", "voices.bin", "tokens.txt", "LICENSE"]);
	assert.deepEqual(Object.keys(KOKORO_ESPEAK_LAYOUT).sort(), KOKORO_PARTS.filter((part) => part !== "core").sort());
	assert.equal(kokoroBytes(), 354_637_718);
	assert.deepEqual(KOKORO_VOICES, { es: { sid: 28, name: "ef_dora" }, en: { sid: 3, name: "af_heart" } });
});

// Small fake parts with real digests, served by a fake fetch that records URLs.
function fakeParts() {
	const bodies = new Map<string, Buffer>();
	const manifests = Object.fromEntries(
		KOKORO_PARTS.map((part) => {
			const real = KOKORO_MANIFESTS[part];
			const files = real.files.map((file) => {
				const data = Buffer.from(`fake ${part} ${file.name}`);
				bodies.set(`${real.baseUrl}/${file.name}`, data);
				return { name: file.name, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
			});
			return [part, { ...real, id: `test-${real.id}`, files } satisfies VoiceModelManifest];
		}),
	) as Record<KokoroPart, VoiceModelManifest>;
	const urls: string[] = [];
	const fetch: VoiceFetch = async (url) => {
		urls.push(url);
		const body = bodies.get(url);
		return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } }) : new Response(null, { status: 404 });
	};
	return { manifests, fetch, urls };
}

test("Kokoro is missing until installed, then installed with one root per part", async () => {
	const voiceHome = scratchHome();
	const { manifests, fetch, urls } = fakeParts();
	assert.deepEqual(await readKokoroStatus({ voiceHome, manifests }), { state: "missing", voiceHome });
	await installKokoro({ voiceHome, manifests, fetch });
	const status = await readKokoroStatus({ voiceHome, manifests });
	assert.equal(status.state, "installed");
	assert.deepEqual(Object.keys(status.roots!), KOKORO_PARTS);
	assert.equal(readFileSync(join(status.roots!.espeakRomance, "es-419"), "utf8"), "fake espeakRomance es-419");
	assert.ok(urls.includes("https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b/espeak-ng-data/lang/roa/es-419"));
	assert.equal(urls.length, KOKORO_PARTS.reduce((sum, part) => sum + manifests[part].files.length, 0));
	// A second install keeps what is there and fetches nothing.
	await installKokoro({ voiceHome, manifests, fetch });
	assert.equal(urls.length, KOKORO_PARTS.reduce((sum, part) => sum + manifests[part].files.length, 0));
});

test("a failed part leaves Kokoro partial, and a changed file reads as invalid", async () => {
	const voiceHome = scratchHome();
	const { manifests, fetch } = fakeParts();
	const failing: VoiceFetch = async (url, init) => (url.includes("/lang/gmw/") ? new Response(null, { status: 500 }) : fetch(url, init));
	await assert.rejects(installKokoro({ voiceHome, manifests, fetch: failing }), (error: unknown) => error instanceof VoiceInstallError);
	assert.equal((await readKokoroStatus({ voiceHome, manifests })).state, "partial");
	await installKokoro({ voiceHome, manifests, fetch });
	const status = await readKokoroStatus({ voiceHome, manifests });
	assert.equal(status.state, "installed");
	writeFileSync(join(status.roots!.core, "tokens.txt"), "changed and longer than before");
	assert.equal((await readKokoroStatus({ voiceHome, manifests })).state, "invalid");
});

test("an aborted install stops before the next part", async () => {
	const voiceHome = scratchHome();
	const { manifests, fetch, urls } = fakeParts();
	const controller = new AbortController();
	controller.abort();
	await installKokoro({ voiceHome, manifests, fetch, signal: controller.signal });
	assert.equal(urls.length, 0);
	assert.equal((await readKokoroStatus({ voiceHome, manifests })).state, "missing");
});

test("a launch is resolved only when Kokoro and the voice runtime are both installed", async () => {
	const voiceHome = scratchHome();
	const { manifests, fetch } = fakeParts();
	const runtimeInstalled = async () => ({ kind: "runtime" as const, state: "installed" as const, path: "/voice/runtime/r" });
	const runtimeMissing = async () => ({ kind: "runtime" as const, state: "missing" as const, path: "/voice/runtime/r" });
	assert.equal(await resolveKokoroLaunch({ voiceHome, manifests, readRuntime: runtimeInstalled }), undefined, "no Kokoro yet");
	await installKokoro({ voiceHome, manifests, fetch });
	assert.equal(await resolveKokoroLaunch({ voiceHome, manifests, readRuntime: runtimeMissing }), undefined, "no runtime");
	const launch = await resolveKokoroLaunch({ voiceHome, manifests, readRuntime: runtimeInstalled });
	const status = await readKokoroStatus({ voiceHome, manifests });
	assert.deepEqual(launch, {
		runtimeRoot: "/voice/runtime/r",
		core: { root: status.roots!.core, files: manifests.core.files.map(({ name, size }) => ({ name, size })) },
		espeak: [
			{ root: status.roots!.espeak, folder: "", files: manifests.espeak.files.map(({ name, size }) => ({ name, size })) },
			{ root: status.roots!.espeakRomance, folder: "lang/roa", files: manifests.espeakRomance.files.map(({ name, size }) => ({ name, size })) },
			{ root: status.roots!.espeakGermanic, folder: "lang/gmw", files: manifests.espeakGermanic.files.map(({ name, size }) => ({ name, size })) },
		],
	});
});

// --- the Miro voice (Piper) ---------------------------------------------------------

test("the Miro voice is pinned to one Hugging Face commit with flat names and the observed redirects", () => {
	assert.equal(MIRO_MANIFEST.baseUrl, "https://huggingface.co/csukuangfj/vits-piper-es_ES-miro-high/resolve/0e1f773561429a9e50fa23d868a40eb341ad83c4");
	assert.equal(MIRO_MANIFEST.id, "vits-piper-es-es-miro-high-0e1f77356142");
	assert.deepEqual(MIRO_MANIFEST.files, [
		{ name: "es_ES-miro-high.onnx", size: 63153775, sha256: "e18073d75c92a5441e0d2770b241f877e984b123e3186ab70a5346c0df999fc5" },
		{ name: "tokens.txt", size: 954, sha256: "620e1aecf1a68fea3ba5850d137b0138fa2037c9b372dad13b95a2a215d0849a" },
		{ name: "README.md", size: 856, sha256: "d759b76d463c7fd92bb382e2575bafe9d8d82c5adeef6a7d7ba0b048a21cc57e" },
	]);
	assert.deepEqual(MIRO_MANIFEST.redirects.map((rule) => rule.origin), ["https://huggingface.co", "https://us.aws.cdn.hf.co"]);
	assert.equal(miroBytes(KOKORO_MANIFESTS), 63_155_585 + kokoroBytes(KOKORO_MANIFESTS) - KOKORO_MANIFESTS.core.files.reduce((sum, file) => sum + file.size, 0), "Miro plus the shared phoneme data");
});

function fakeMiro() {
	const kokoro = fakeParts();
	const data = Buffer.from("fake miro model");
	const tokens = Buffer.from("fake miro tokens");
	const readme = Buffer.from("license");
	const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
	const miro: VoiceModelManifest = {
		...MIRO_MANIFEST,
		id: `test-${MIRO_MANIFEST.id}`,
		files: [
			{ name: "es_ES-miro-high.onnx", size: data.length, sha256: digest(data) },
			{ name: "tokens.txt", size: tokens.length, sha256: digest(tokens) },
			{ name: "README.md", size: readme.length, sha256: digest(readme) },
		],
	};
	const bodies = new Map([[`${MIRO_MANIFEST.baseUrl}/es_ES-miro-high.onnx`, data], [`${MIRO_MANIFEST.baseUrl}/tokens.txt`, tokens], [`${MIRO_MANIFEST.baseUrl}/README.md`, readme]]);
	const urls: string[] = [];
	const fetch: VoiceFetch = async (url, init) => {
		urls.push(url);
		const body = bodies.get(url);
		return body ? new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } }) : kokoro.fetch(url, init);
	};
	return { miro, manifests: kokoro.manifests, fetch, urls };
}

test("installing Miro also installs the shared phoneme data, and a launch needs it all plus the runtime", async () => {
	const voiceHome = scratchHome();
	const { miro, manifests, fetch, urls } = fakeMiro();
	const runtime = async () => ({ kind: "runtime" as const, state: "installed" as const, path: "/voice/runtime/r" });
	assert.equal((await readMiroStatus({ voiceHome, miro, manifests })).state, "missing");
	assert.equal(await resolveMiroLaunch({ voiceHome, miro, manifests, readRuntime: runtime }), undefined);
	await installMiro({ voiceHome, miro, manifests, fetch });
	assert.ok(!urls.some((url) => url.endsWith("/model.onnx") || url.endsWith("/voices.bin")), "the Kokoro model itself is not downloaded");
	assert.equal((await readMiroStatus({ voiceHome, miro, manifests })).state, "installed");
	const launch = await resolveMiroLaunch({ voiceHome, miro, manifests, readRuntime: runtime });
	assert.equal(launch!.kind, "piper");
	assert.deepEqual(launch!.core.files, [{ name: "es_ES-miro-high.onnx", size: 15 }, { name: "tokens.txt", size: 16 }], "the license file is not handed to the worker");
	assert.deepEqual(launch!.espeak.map((part) => part.folder), ["", "lang/roa", "lang/gmw"]);
	assert.equal(await resolveMiroLaunch({ voiceHome, miro, manifests, readRuntime: async () => ({ kind: "runtime" as const, state: "missing" as const, path: "/r" }) }), undefined);
});
