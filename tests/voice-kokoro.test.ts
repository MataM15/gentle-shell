import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import type { VoiceModelManifest } from "../lib/voice-artifacts.ts";
import { installKokoro, KOKORO_ESPEAK_LAYOUT, KOKORO_MANIFESTS, KOKORO_PARTS, KOKORO_VOICES, kokoroBytes, readKokoroStatus, type KokoroPart } from "../lib/voice-kokoro.ts";
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
