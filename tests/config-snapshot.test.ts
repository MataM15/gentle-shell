import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import test from "node:test";
import {
	CONFIG_SNAPSHOT_COMMAND,
	CONFIG_SNAPSHOT_FILES,
	CONFIG_SNAPSHOT_MANIFEST_FILE,
	CONFIG_SNAPSHOT_MAX_FILE_BYTES,
	createConfigSnapshot,
	formatSnapshotStatus,
	inspectConfigSnapshot,
	parseSnapshotArgs,
} from "../lib/config-snapshot.ts";
import configSnapshotExtension from "../extensions/config-snapshot.ts";

// Synthetic fixtures only: every config home, project root, and destination is
// a fresh directory under the system temp dir, removed in teardown. Nothing
// here reads the user's real Gentle AI config, and the test never invokes the
// live snapshot command.

const scratchRoots: string[] = [];
after(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix = "config-snapshot-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	scratchRoots.push(dir);
	return dir;
}

function configHome(): string {
	const home = join(scratch("config-home-"), "gentle-ai");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return home;
}

function write(home: string, name: string, value: string | Buffer): string {
	const path = join(home, name);
	writeFileSync(path, value, { mode: 0o600 });
	return path;
}

function sha(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function entry(status: ReturnType<typeof inspectConfigSnapshot>, name: string) {
	const found = status.entries.find((item) => item.name === name);
	assert.ok(found, `missing status entry ${name}`);
	return found;
}

test("status reports presence, size, and SHA256 without reading contents into output", () => {
	const home = configHome();
	const persona = Buffer.from(JSON.stringify({ persona: "gentle", displayName: "SENTINEL-CONTENT" }));
	write(home, "persona.json", persona);
	write(home, "profiles.json", JSON.stringify({ profiles: { default: { model: "provider/model" } } }));
	const before = readdirSync(home).sort();

	const status = inspectConfigSnapshot({ configHome: home });
	const lines = formatSnapshotStatus(status);
	const output = lines.join("\n");

	assert.equal(entry(status, "persona.json").state, "present");
	assert.equal(entry(status, "persona.json").bytes, persona.length);
	assert.equal(entry(status, "persona.json").sha256, sha(persona));
	assert.equal(entry(status, "profiles.json").state, "present");
	assert.equal(entry(status, "rail.json").state, "absent");
	assert.equal(status.refusals, 0);
	assert.ok(output.includes("persona.json"));
	assert.ok(output.includes(sha(persona)));
	assert.ok(!output.includes("SENTINEL-CONTENT"), "status must never print file contents");
	assert.deepEqual(readdirSync(home).sort(), before, "status must not write to the config home");
});

test("status fails closed on secret-bearing keys and names only the key path", () => {
	const home = configHome();
	write(home, "models.json", JSON.stringify({ modelProfiles: { default: { apiKey: "sk-SENTINEL-VALUE" } } }));

	const status = inspectConfigSnapshot({ configHome: home });
	const models = entry(status, "models.json");
	const output = formatSnapshotStatus(status).join("\n");

	assert.equal(models.state, "refused");
	assert.equal(models.refusal?.code, "secret-key");
	assert.match(models.refusal?.message ?? "", /models\.json/);
	assert.match(models.refusal?.message ?? "", /modelProfiles\.default\.apiKey/);
	assert.equal(status.refusals, 1);
	assert.ok(!output.includes("sk-SENTINEL-VALUE"), "a secret value must never be reported");
	assert.ok(!output.includes("SENTINEL"), "no secret-derived text may leak");
});

test("status refuses symlinks, hardlinks, nonregular entries, oversized files, and invalid JSON", () => {
	const home = configHome();
	const outside = scratch("config-snapshot-target-");
	const target = join(outside, "target.json");
	writeFileSync(target, JSON.stringify({ persona: "outside" }), { mode: 0o600 });
	symlinkSync(target, join(home, "persona.json"));
	write(home, "banner.json", JSON.stringify({ enabled: true }));
	linkSync(join(home, "banner.json"), join(home, "banner-alias.json"));
	mkdirSync(join(home, "animations.json"));
	write(home, "rail.json", Buffer.alloc(CONFIG_SNAPSHOT_MAX_FILE_BYTES + 1, 0x20));
	write(home, "notifications.json", "{not valid json");

	const status = inspectConfigSnapshot({ configHome: home });
	assert.equal(entry(status, "persona.json").refusal?.code, "source-symlink");
	assert.equal(entry(status, "banner.json").refusal?.code, "source-hardlink");
	assert.equal(entry(status, "animations.json").refusal?.code, "source-nonregular");
	assert.equal(entry(status, "rail.json").refusal?.code, "source-too-large");
	assert.equal(entry(status, "notifications.json").refusal?.code, "invalid-json");
	assert.equal(status.refusals, 5);
});

test("create writes verified private copies and a metadata-only manifest", () => {
	const home = configHome();
	const persona = Buffer.from(JSON.stringify({ persona: "gentle", displayName: "SENTINEL-CONTENT" }));
	const notifications = Buffer.from(JSON.stringify({ schema: "gentle-pi.notifications/v1", enabled: true, audio: { backend: "auto" } }));
	write(home, "persona.json", persona);
	write(home, "notifications.json", notifications);
	const destination = join(scratch("config-snapshot-dest-"), "snapshot");

	const result = createConfigSnapshot({ configHome: home, destination, projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(result.ok, true, JSON.stringify(result));

	assert.equal(statSync(destination).mode & 0o777, 0o700);
	assert.equal(statSync(join(destination, "persona.json")).mode & 0o777, 0o600);
	assert.deepEqual(readFileSync(join(destination, "persona.json")), persona);
	assert.deepEqual(readFileSync(join(destination, "notifications.json")), notifications);
	assert.equal(lstatSync(join(destination, "rail.json"), { throwIfNoEntry: false }), undefined, "absent sources stay absent");

	const manifestText = readFileSync(join(destination, CONFIG_SNAPSHOT_MANIFEST_FILE), "utf8");
	const manifest = JSON.parse(manifestText);
	const personaEntry = manifest.files.find((item: { name: string }) => item.name === "persona.json");
	assert.equal(personaEntry.present, true);
	assert.equal(personaEntry.sha256, sha(persona));
	assert.equal(personaEntry.bytes, persona.length);
	assert.equal(manifest.files.find((item: { name: string }) => item.name === "rail.json").present, false);
	assert.ok(manifest.exclusions.some((line: string) => /credential|auth|\.env/i.test(line)));
	assert.ok(manifest.limitations.some((line: string) => /no restore|not a full/i.test(line)));
	assert.ok(!manifestText.includes("SENTINEL-CONTENT"), "the manifest records metadata only");
	assert.equal(statSync(join(destination, CONFIG_SNAPSHOT_MANIFEST_FILE)).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(destination).sort(), ["manifest.json", "notifications.json", "persona.json"]);
});

test("create refuses an existing destination and leaves it untouched", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const parent = scratch("config-snapshot-dest-");
	const destination = join(parent, "snapshot");
	mkdirSync(destination);
	const keep = write(destination, "keep.txt", "existing data");

	const result = createConfigSnapshot({ configHome: home, destination, projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(result.ok, false);
	assert.equal(result.code, "destination-exists");
	assert.match(result.lines.join("\n"), /Nothing was written/);
	assert.doesNotMatch(result.lines.join("\n"), /remain|retained/i);
	assert.equal(readFileSync(keep, "utf8"), "existing data");
	assert.deepEqual(readdirSync(destination), ["keep.txt"]);
});

test("create refuses destinations inside the config home, source root alias, and project checkout", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const sourceReal = scratch("source-real-");
	const sourceAlias = join(scratch("source-alias-"), "link");
	symlinkSync(sourceReal, sourceAlias);
	const project = scratch("project-");

	const inHome = createConfigSnapshot({ configHome: home, destination: join(home, "snapshot"), projectRoot: project, sourceRoot: sourceAlias });
	assert.equal(inHome.ok, false);
	assert.equal(inHome.code, "destination-in-config-home");

	const inSource = createConfigSnapshot({ configHome: home, destination: join(sourceReal, "snapshot"), projectRoot: project, sourceRoot: sourceAlias });
	assert.equal(inSource.ok, false);
	assert.equal(inSource.code, "destination-in-source");

	const inProject = createConfigSnapshot({ configHome: home, destination: join(project, "snapshot"), projectRoot: project, sourceRoot: sourceAlias });
	assert.equal(inProject.ok, false);
	assert.equal(inProject.code, "destination-in-project");
});

test("create refuses a destination with a symlinked ancestor or a missing parent", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const realParent = scratch("real-parent-");
	const aliasParent = join(scratch("alias-parent-"), "link");
	symlinkSync(realParent, aliasParent);

	const linked = createConfigSnapshot({ configHome: home, destination: join(aliasParent, "snapshot"), projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(linked.ok, false);
	assert.equal(linked.code, "symlinked-ancestor");
	assert.equal(lstatSync(join(realParent, "snapshot"), { throwIfNoEntry: false }), undefined);

	const missing = createConfigSnapshot({ configHome: home, destination: join(scratch("missing-parent-"), "absent", "snapshot"), projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(missing.ok, false);
	assert.equal(missing.code, "parent-missing");
});

test("create refuses symlinked and hardlinked source files instead of skipping required coverage", () => {
	const outside = scratch("source-target-");
	const target = join(outside, "persona.json");
	writeFileSync(target, JSON.stringify({ persona: "outside" }), { mode: 0o600 });

	const linkedHome = configHome();
	symlinkSync(target, join(linkedHome, "persona.json"));
	const linked = createConfigSnapshot({ configHome: linkedHome, destination: join(scratch("dest-"), "snapshot"), projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(linked.ok, false);
	assert.equal(linked.code, "source-symlink");

	const hardHome = configHome();
	write(hardHome, "persona.json", JSON.stringify({ persona: "gentle" }));
	linkSync(join(hardHome, "persona.json"), join(hardHome, "persona-copy.json"));
	const hard = createConfigSnapshot({ configHome: hardHome, destination: join(scratch("dest-"), "snapshot"), projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(hard.ok, false);
	assert.equal(hard.code, "source-hardlink");
});

test("create fails closed on a secret-bearing source without writing output or leaking the value", () => {
	const home = configHome();
	write(home, "profiles.json", JSON.stringify({ profiles: { personal: { accessToken: "tok-SENTINEL-VALUE" } } }));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({ configHome: home, destination, projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(result.ok, false);
	assert.equal(result.code, "secret-key");
	assert.match(result.message, /profiles\.json/);
	assert.match(result.message, /profiles\.personal\.accessToken/);
	assert.ok(!result.message.includes("tok-SENTINEL-VALUE"));
	assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined, "a refused snapshot creates nothing");
});

test("create detects a source change after copying and removes only its partial output", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const notifications = write(home, "notifications.json", JSON.stringify({ enabled: true }));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({
		configHome: home,
		destination,
		projectRoot: scratch("project-"),
		sourceRoot: scratch("source-"),
		testHooks: { afterFileCopied: (name) => { if (name === "notifications.json") writeFileSync(notifications, JSON.stringify({ enabled: false })); } },
	});
	assert.equal(result.ok, false);
	assert.equal(result.code, "concurrent-change");
	assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined, "the newly-owned partial directory is removed");
});

test("cleanup leaves a replacement directory and its files intact when the output directory identity changed", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	write(home, "notifications.json", JSON.stringify({ enabled: true }));
	const parent = scratch("dest-");
	const destination = join(parent, "snapshot");
	const moved = join(parent, "snapshot-moved");

	const result = createConfigSnapshot({
		configHome: home,
		destination,
		projectRoot: scratch("project-"),
		sourceRoot: scratch("source-"),
		testHooks: {
			afterFileCopied: (name) => {
				if (name !== "notifications.json") return;
				renameSync(destination, moved);
				mkdirSync(destination, { mode: 0o700 });
				writeFileSync(join(destination, "persona.json"), "SUBSTITUTE-PERSONA");
				writeFileSync(join(destination, "notifications.json"), "SUBSTITUTE-NOTIFICATIONS");
				throw new Error("simulated directory replacement");
			},
		},
	});

	assert.equal(result.ok, false);
	assert.match(result.lines.join("\n"), /not the one this run created/);
	assert.doesNotMatch(result.lines.join("\n"), /Nothing was written/);
	assert.doesNotMatch(result.lines.join("\n"), /created config snapshot|complete backup/i);
	assert.equal(readFileSync(join(destination, "persona.json"), "utf8"), "SUBSTITUTE-PERSONA", "a substitute directory keeps its files");
	assert.equal(readFileSync(join(destination, "notifications.json"), "utf8"), "SUBSTITUTE-NOTIFICATIONS");
	assert.ok(lstatSync(moved).isDirectory(), "the moved snapshot is left as evidence, not deleted through the replaced path");
});

test("cleanup verifies each recorded file identity and keeps a substituted file", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	write(home, "notifications.json", JSON.stringify({ enabled: true }));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({
		configHome: home,
		destination,
		projectRoot: scratch("project-"),
		sourceRoot: scratch("source-"),
		testHooks: {
			afterFileCopied: (name) => {
				if (name !== "notifications.json") return;
				unlinkSync(join(destination, "persona.json"));
				writeFileSync(join(destination, "persona.json"), "SUBSTITUTE-PERSONA");
				throw new Error("simulated file replacement");
			},
		},
	});

	assert.equal(result.ok, false);
	assert.match(result.lines.join("\n"), /incomplete output at .*snapshot/);
	assert.doesNotMatch(result.lines.join("\n"), /Nothing was written/);
	assert.doesNotMatch(result.lines.join("\n"), /created config snapshot|complete backup/i);
	assert.equal(readFileSync(join(destination, "persona.json"), "utf8"), "SUBSTITUTE-PERSONA", "a file with a different inode is never unlinked");
	assert.equal(lstatSync(join(destination, "notifications.json"), { throwIfNoEntry: false }), undefined, "files this run still owns are cleaned up");
	assert.ok(lstatSync(destination).isDirectory(), "the directory is kept because it is no longer empty");
});

test("a failure after the first copy reports that partial output was removed", () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({
		configHome: home,
		destination,
		projectRoot: scratch("project-"),
		sourceRoot: scratch("source-"),
		testHooks: { afterFileCopied: (name) => { if (name === "persona.json") throw new Error("simulated failure after copy"); } },
	});

	assert.equal(result.ok, false);
	assert.match(result.lines.join("\n"), /partial output was removed/);
	assert.doesNotMatch(result.lines.join("\n"), /Nothing was written/);
	assert.doesNotMatch(result.lines.join("\n"), /created config snapshot|complete backup/i);
	assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined, "the owned partial output is gone");
});

test("the fixed list covers every named noncredential preference and nothing else", () => {
	const names = CONFIG_SNAPSHOT_FILES.map((spec) => spec.name).sort();
	assert.deepEqual(names, [
		"animations.json",
		"background-subagents.json",
		"banner.json",
		"builtin-codemode-optout.json",
		"card-content.json",
		"card-style.json",
		"channel.json",
		"dev-binary.json",
		"double-esc-cancel.json",
		"history-capture.json",
		"models.json",
		"notifications.json",
		"permission-mode.json",
		"persona.json",
		"profiles.json",
		"rail.json",
		"runtime-guardrails.json",
		"vim.json",
		"visual-customization.json",
		"visual-profiles.json",
		"voice-settings.json",
	]);
	const readOnly = CONFIG_SNAPSHOT_FILES.filter((spec) => spec.readOnly).map((spec) => spec.name).sort();
	assert.deepEqual(readOnly, ["permission-mode.json", "runtime-guardrails.json"]);
});

function paddedJson(size: number): Buffer {
	const value = Buffer.from(`{"pad":"${"a".repeat(size - 10)}"}`);
	assert.equal(value.length, size);
	return value;
}

test("create reports an accurate total-budget refusal and writes nothing", () => {
	const home = configHome();
	for (const name of ["persona.json", "models.json", "profiles.json", "rail.json"]) write(home, name, paddedJson(250_000));
	write(home, "notifications.json", paddedJson(60_000));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({ configHome: home, destination, projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(result.ok, false);
	assert.equal(result.code, "total-too-large");
	assert.match(result.message, /notifications\.json is 60000 bytes/);
	assert.match(result.message, /only 48576 of the 1048576-byte total snapshot budget remains/);
	assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined, "an over-budget snapshot creates nothing");
});

test("status reports the same accurate total-budget refusal", () => {
	const home = configHome();
	for (const name of ["persona.json", "models.json", "profiles.json", "rail.json"]) write(home, name, paddedJson(250_000));
	write(home, "notifications.json", paddedJson(60_000));

	const status = inspectConfigSnapshot({ configHome: home });
	assert.equal(entry(status, "notifications.json").refusal?.code, "total-too-large");
	assert.match(entry(status, "notifications.json").refusal?.message ?? "", /notifications\.json is 60000 bytes/);
	assert.match(entry(status, "notifications.json").refusal?.message ?? "", /only 48576 of the 1048576-byte total snapshot budget remains/);
});

test("a single oversized source keeps the per-file limit and an accurate message", () => {
	const home = configHome();
	write(home, "persona.json", Buffer.alloc(CONFIG_SNAPSHOT_MAX_FILE_BYTES + 1, 0x20));
	const destination = join(scratch("dest-"), "snapshot");

	const result = createConfigSnapshot({ configHome: home, destination, projectRoot: scratch("project-"), sourceRoot: scratch("source-") });
	assert.equal(result.ok, false);
	assert.equal(result.code, "source-too-large");
	assert.match(result.message, /262145 bytes/);
	assert.match(result.message, /limit is 262144 bytes/);
	assert.equal(lstatSync(destination, { throwIfNoEntry: false }), undefined);
});

test("the extension registers only a human command and refuses non-interactive invocation", async () => {
	const home = configHome();
	write(home, "persona.json", JSON.stringify({ persona: "gentle" }));
	const project = scratch("project-");
	const source = scratch("source-");
	const registered: Array<{ name: string; handler: (args: string, ctx: unknown) => Promise<void> }> = [];
	let registeredTools = 0;
	const pi = {
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) => { registered.push({ name, handler: options.handler }); },
		registerTool: () => { registeredTools += 1; },
	};
	configSnapshotExtension(pi as never, { env: { GENTLE_PI_CONFIG_HOME: home }, sourceRoot: () => source });

	assert.equal(registered.length, 1);
	assert.equal(registered[0].name, CONFIG_SNAPSHOT_COMMAND);
	assert.equal(registeredTools, 0, "the snapshot must never be model-callable");

	const notices: string[] = [];
	let confirms = 0;
	const headlessDestination = join(scratch("dest-"), "snapshot");
	const headless = {
		cwd: project,
		mode: "json",
		hasUI: false,
		ui: { notify: (message: string) => notices.push(message), confirm: async () => { confirms += 1; return true; } },
	};
	await registered[0].handler(`create ${headlessDestination}`, headless);
	assert.equal(confirms, 0, "no confirmation dialog without a UI");
	assert.ok(notices.some((line) => /interactive TUI/i.test(line)));
	assert.equal(lstatSync(headlessDestination, { throwIfNoEntry: false }), undefined);

	const tuiNotices: string[] = [];
	const tui = {
		cwd: project,
		mode: "tui",
		hasUI: true,
		ui: { notify: (message: string) => tuiNotices.push(message), confirm: async () => false },
	};
	const declined = join(scratch("dest-"), "snapshot");
	await registered[0].handler(`create ${declined}`, tui);
	assert.equal(lstatSync(declined, { throwIfNoEntry: false }), undefined, "a declined confirmation writes nothing");
	assert.ok(tuiNotices.some((line) => /cancel/i.test(line)));
});

test("usage parsing keeps status as the default and requires an absolute create destination", () => {
	assert.deepEqual(parseSnapshotArgs(""), { kind: "status" });
	assert.deepEqual(parseSnapshotArgs("status"), { kind: "status" });
	assert.deepEqual(parseSnapshotArgs("help"), { kind: "help" });
	assert.deepEqual(parseSnapshotArgs("create /tmp/snapshot"), { kind: "create", destination: "/tmp/snapshot" });
	assert.equal(parseSnapshotArgs("create relative/dir").kind, "error");
	assert.equal(parseSnapshotArgs("create").kind, "error");
	assert.equal(parseSnapshotArgs("restore /tmp/snapshot").kind, "error");
});
