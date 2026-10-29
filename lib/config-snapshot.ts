import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

// Human-invoked config snapshot for the existing protected config home.
//
// The model-facing tools and shell are deliberately blocked from the Gentle AI
// config home (lib/auto-permission-runtime.ts), so the only way to preserve
// those preferences is a command a person runs from the TUI, confirms in a
// dialog, and that never becomes a model-callable tool. This module is a
// one-way, metadata-first copy: it reads a fixed list of noncredential JSON
// preference files, refuses anything abnormal (symlinks, hardlinks, oversized
// files, invalid JSON, secret-bearing keys, concurrent changes), writes a new
// private directory with verified copies, and records identities and hashes in
// a manifest. There is no restore, import, apply, or edit path.

export const CONFIG_SNAPSHOT_COMMAND = "gentle:config-snapshot";
export const CONFIG_SNAPSHOT_MANIFEST_FILE = "manifest.json";
export const CONFIG_SNAPSHOT_SCHEMA = "gentle-pi.config-snapshot/v1";
export const CONFIG_SNAPSHOT_MAX_FILE_BYTES = 256 * 1024;
export const CONFIG_SNAPSHOT_MAX_TOTAL_BYTES = 1024 * 1024;
export const CONFIG_SNAPSHOT_USAGE = [
	`/${CONFIG_SNAPSHOT_COMMAND}          read-only status: names, hashes, and absence only`,
	`/${CONFIG_SNAPSHOT_COMMAND} create /absolute/new/directory`,
	"  copies the fixed preference files after a confirmation dialog (TUI only)",
].join("\n");

export interface ConfigSnapshotFileSpec {
	readonly name: string;
	readonly category: string;
	/** Permissions and runtime guardrails are captured for reference only. */
	readonly readOnly: boolean;
}

// The fixed source list. No path argument exists anywhere in this command, so a
// snapshot can never inventory arbitrary config-home files.
export const CONFIG_SNAPSHOT_FILES: readonly ConfigSnapshotFileSpec[] = Object.freeze([
	{ name: "persona.json", category: "persona", readOnly: false },
	{ name: "models.json", category: "models", readOnly: false },
	{ name: "profiles.json", category: "profiles", readOnly: false },
	{ name: "dev-binary.json", category: "dev-binary", readOnly: false },
	{ name: "channel.json", category: "channel", readOnly: false },
	{ name: "rail.json", category: "rail", readOnly: false },
	{ name: "visual-customization.json", category: "visual", readOnly: false },
	{ name: "banner.json", category: "banner", readOnly: false },
	{ name: "animations.json", category: "animations", readOnly: false },
	{ name: "card-content.json", category: "card-content", readOnly: false },
	{ name: "card-style.json", category: "card-style", readOnly: false },
	{ name: "vim.json", category: "vim", readOnly: false },
	{ name: "visual-profiles.json", category: "visual-profiles", readOnly: false },
	{ name: "history-capture.json", category: "history-capture", readOnly: false },
	{ name: "builtin-codemode-optout.json", category: "builtin-codemode-optout", readOnly: false },
	{ name: "voice-settings.json", category: "voice", readOnly: false },
	{ name: "notifications.json", category: "notifications", readOnly: false },
	{ name: "background-subagents.json", category: "background-subagents", readOnly: false },
	{ name: "double-esc-cancel.json", category: "double-esc", readOnly: false },
	{ name: "permission-mode.json", category: "permissions", readOnly: true },
	{ name: "runtime-guardrails.json", category: "runtime-guardrails", readOnly: true },
]);

export type SnapshotRefusalCode =
	| "source-symlink"
	| "source-nonregular"
	| "source-hardlink"
	| "source-too-large"
	| "total-too-large"
	| "invalid-json"
	| "secret-key"
	| "read-error"
	| "destination-not-absolute"
	| "destination-root"
	| "destination-exists"
	| "destination-in-config-home"
	| "destination-in-source"
	| "destination-in-project"
	| "destination-changed"
	| "parent-missing"
	| "parent-not-directory"
	| "symlinked-ancestor"
	| "concurrent-change"
	| "io-error";

export interface SnapshotIdentity {
	dev: string;
	ino: string;
	mode: number;
	nlink: number;
	size: number;
	mtimeMs: number;
}

export interface SnapshotEntry {
	name: string;
	category: string;
	readOnly: boolean;
	state: "present" | "absent" | "refused";
	bytes?: number;
	sha256?: string;
	identity?: SnapshotIdentity;
	refusal?: { code: SnapshotRefusalCode; message: string };
}

export interface ConfigSnapshotStatus {
	configHome: string;
	entries: SnapshotEntry[];
	refusals: number;
	limitations: string[];
}

export interface ConfigSnapshotManifest {
	schema: string;
	createdAt: string;
	configHome: string;
	scope: string;
	exclusions: string[];
	limitations: string[];
	files: Array<{
		name: string;
		category: string;
		readOnly: boolean;
		present: boolean;
		bytes: number | null;
		sha256: string | null;
		identity: SnapshotIdentity | null;
		refusal: string | null;
	}>;
}

export type CreateConfigSnapshotResult =
	| {
			ok: true;
			destination: string;
			manifestPath: string;
			entries: SnapshotEntry[];
			manifest: ConfigSnapshotManifest;
			lines: string[];
	  }
	| { ok: false; code: SnapshotRefusalCode; message: string; lines: string[] };

export interface CreateConfigSnapshotOptions {
	configHome: string;
	destination: string;
	/** The current project checkout, refused as a destination tree. */
	projectRoot?: string;
	/** This package's source root, refused as a destination tree. */
	sourceRoot?: string;
	platform?: NodeJS.Platform;
	/** Test seam for the post-copy source revalidation; never used by the command. */
	testHooks?: { afterFileCopied?: (name: string) => void };
}

const EXCLUSIONS = Object.freeze([
	"Credentials, auth stores, .env files, tokens, and any secret-bearing key: a suspicious key fails the whole snapshot.",
	"Engram memory databases, session transcripts, logs, caches, and arbitrary config-home files.",
	"Project-scoped overrides under <project>/.pi/gentle-ai and any file outside the fixed list above.",
	"No restore, import, apply, or edit: this command only writes a one-way verified copy.",
]);

const LIMITATIONS = Object.freeze([
	"Not a full backup of the Gentle AI/Pi ecosystem; only the fixed preference files are captured.",
	"Permissions and runtime guardrails are read-only copies; they are never restored or applied here.",
	"A required file that is a symlink, hardlink, or nonregular entry fails the snapshot instead of being skipped.",
	"Destinations inside the config home, this package's source root, or the current project checkout are refused.",
	"Secret detection is key-name based: a secret stored under an innocuous key name cannot be detected.",
	"POSIX private modes (0700/0600) are enforced on POSIX filesystems; Windows applies its own access model.",
]);

const BASE_LIMITATIONS = Object.freeze([...LIMITATIONS, "No existing destination or pre-existing data is overwritten or deleted."]);

const OPEN_NOFOLLOW = constants.O_RDONLY
	| (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));

function totalBudgetMessage(name: string, size: number, remaining: number): string {
	return `${name} is ${size} bytes, but only ${remaining} of the ${CONFIG_SNAPSHOT_MAX_TOTAL_BYTES}-byte total snapshot budget remains.`;
}

type ReadResult =
	| { state: "absent" }
	| { state: "present"; bytes: Buffer; sha256: string; identity: SnapshotIdentity }
	| { state: "refused"; code: SnapshotRefusalCode; message: string };

function refusal(code: SnapshotRefusalCode, message: string): { state: "refused"; code: SnapshotRefusalCode; message: string } {
	return { state: "refused", code, message };
}

function identityOf(stat: { dev: number | bigint; ino: number | bigint; mode: number; nlink: number; size: number; mtimeMs: number }): SnapshotIdentity {
	return { dev: String(stat.dev), ino: String(stat.ino), mode: stat.mode & 0o777, nlink: stat.nlink, size: stat.size, mtimeMs: stat.mtimeMs };
}

function sameIdentity(left: SnapshotIdentity, right: SnapshotIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink
		&& left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Reads one fixed source file with no-follow and identity checks. The largest
 * accepted size is the caller's budget; a file at the limit is still bounded by
 * reading one extra byte so growth during the read is detected.
 */
function readSourceFile(
	path: string,
	limit: number,
	label: string,
	overLimit?: (size: number) => { code: SnapshotRefusalCode; message: string },
): ReadResult {
	const name = basename(path);
	const tooLarge = (size: number) => refusal(
		overLimit?.(size).code ?? "source-too-large",
		overLimit?.(size).message ?? `${name} is ${size} bytes; the limit is ${limit} bytes.`,
	);
	let listed;
	try {
		listed = lstatSync(path, { throwIfNoEntry: false });
	} catch {
		return refusal("read-error", `${name} could not be inspected; the snapshot was refused.`);
	}
	if (listed === undefined) return { state: "absent" };
	if (listed.isSymbolicLink()) return refusal("source-symlink", `${name} is a symbolic link; required ${label} must be a regular file.`);
	if (!listed.isFile()) return refusal("source-nonregular", `${name} is not a regular file; required ${label} must be a regular file.`);
	if (listed.nlink > 1) return refusal("source-hardlink", `${name} has ${listed.nlink} hard links; a credential alias could share its bytes, so it is refused.`);
	if (listed.size > limit) return tooLarge(listed.size);

	let fd: number | undefined;
	try {
		fd = openSync(path, OPEN_NOFOLLOW);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") return refusal("source-symlink", `${name} is a symbolic link; required ${label} must be a regular file.`);
		if (code === "ENOENT") return refusal("concurrent-change", `${name} disappeared while it was being read.`);
		return refusal("read-error", `${name} could not be opened (${code ?? "unknown error"}).`);
	}
	try {
		const opened = fstatSync(fd);
		if (opened.dev !== listed.dev || opened.ino !== listed.ino) {
			return refusal("concurrent-change", `${name} was replaced while it was being read.`);
		}
		if (!opened.isFile()) return refusal("source-nonregular", `${name} is not a regular file; required ${label} must be a regular file.`);
		if (opened.nlink > 1) return refusal("source-hardlink", `${name} has ${opened.nlink} hard links; a credential alias could share its bytes, so it is refused.`);
		if (opened.size > limit) return tooLarge(opened.size);

		const buffer = Buffer.alloc(opened.size + 1);
		let total = 0;
		while (total < buffer.length) {
			const read = readSync(fd, buffer, total, buffer.length - total, total);
			if (read <= 0) break;
			total += read;
		}
		if (total > opened.size) return refusal("concurrent-change", `${name} grew while it was being read.`);
		if (total !== opened.size) return refusal("concurrent-change", `${name} shrank while it was being read.`);
		const bytes = buffer.subarray(0, total);
		return { state: "present", bytes, sha256: createHash("sha256").update(bytes).digest("hex"), identity: identityOf(opened) };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return refusal("read-error", `${name} could not be read (${code ?? "unknown error"}).`);
	} finally {
		closeSync(fd);
	}
}

// --- secret-key detection (metadata only) ---------------------------------

const SECRET_WORDS = new Set(["secret", "secrets", "password", "passwd", "token", "credential", "credentials", "authorization", "bearer", "cookie", "apikey", "privatekey"]);
const SECRET_PAIRS: ReadonlyArray<readonly [string, string]> = [
	["api", "key"], ["private", "key"], ["access", "key"], ["session", "key"],
	["client", "secret"], ["refresh", "token"], ["auth", "token"],
];

function keyWords(key: string): string[] {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function isSuspiciousKey(key: string): boolean {
	const words = keyWords(key);
	if (words.some((word) => SECRET_WORDS.has(word))) return true;
	return SECRET_PAIRS.some(([first, second]) => words.some((word, index) => word === first && words[index + 1] === second));
}

/** Returns the first suspicious JSON key path, or undefined. Values are never read. */
function findSecretKey(value: unknown): string | undefined {
	const stack: Array<{ value: unknown; path: string; depth: number }> = [{ value, path: "", depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop()!;
		if (current.depth > 64) return current.path || "(root)";
		if (Array.isArray(current.value)) {
			current.value.forEach((item, index) => stack.push({ value: item, path: `${current.path}[${index}]`, depth: current.depth + 1 }));
			continue;
		}
		if (typeof current.value !== "object" || current.value === null) continue;
		for (const [key, item] of Object.entries(current.value as Record<string, unknown>)) {
			const path = current.path === "" ? key : `${current.path}.${key}`;
			if (isSuspiciousKey(key)) return path;
			stack.push({ value: item, path, depth: current.depth + 1 });
		}
	}
	return undefined;
}

/** Validates JSON and fails closed on a suspicious key. Returns a refusal message or undefined. */
function inspectJson(bytes: Buffer, name: string): { code: SnapshotRefusalCode; message: string } | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		return { code: "invalid-json", message: `${name} is not valid JSON; required preferences must parse before they are copied.` };
	}
	const secret = findSecretKey(parsed);
	if (secret !== undefined) {
		return { code: "secret-key", message: `${name} contains a suspicious secret-bearing key at ${secret}; the snapshot refuses it instead of leaking or silently redacting it.` };
	}
	return undefined;
}

// --- path safety ----------------------------------------------------------

function canonicalRoot(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function inside(root: string, target: string, platform: NodeJS.Platform): boolean {
	const normalize = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
	const rel = relative(normalize(root), normalize(target));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// strictNullChecks is off in this repository, so a discriminated union on `ok`
// does not narrow. Optional fields keep every refusal branch type-safe.
interface DestinationCheck {
	ok: boolean;
	code?: SnapshotRefusalCode;
	message?: string;
	destination?: string;
	parent?: string;
}

function checkAncestors(path: string, platform: NodeJS.Platform): DestinationCheck {
	const root = parse(path).root;
	let current = root;
	const rest = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
	for (const segment of rest) {
		current = join(current, segment);
		let stat;
		try {
			stat = lstatSync(current, { throwIfNoEntry: false });
		} catch {
			return { ok: false, code: "io-error", message: `${current} could not be inspected.` };
		}
		if (stat === undefined) return { ok: false, code: "parent-missing", message: `The destination parent ${path} does not exist; it is never created implicitly.` };
		if (stat.isSymbolicLink()) return { ok: false, code: "symlinked-ancestor", message: `${current} is a symbolic link; a snapshot is never written through a symlinked ancestor.` };
		if (!stat.isDirectory()) return { ok: false, code: "parent-not-directory", message: `${current} is not a directory.` };
	}
	return { ok: true };
}

function checkDestination(options: { destination: string; configHome: string; sourceRoot?: string; projectRoot?: string; platform: NodeJS.Platform; expectExisting: boolean }): DestinationCheck {
	const { destination, platform } = options;
	if (!isAbsolute(destination)) return { ok: false, code: "destination-not-absolute", message: "The snapshot destination must be an absolute path." };
	const resolved = resolve(destination);
	if (parse(resolved).root === resolved) return { ok: false, code: "destination-root", message: "The filesystem root cannot be a snapshot destination." };
	const parent = dirname(resolved);
	const ancestors = checkAncestors(parent, platform);
	if (!ancestors.ok) return ancestors;

	const protectedRoots: Array<{ root: string; code: SnapshotRefusalCode; label: string }> = [
		{ root: options.configHome, code: "destination-in-config-home", label: "the Gentle AI config home" },
	];
	if (options.sourceRoot !== undefined) protectedRoots.push({ root: options.sourceRoot, code: "destination-in-source", label: "this package's source root" });
	if (options.projectRoot !== undefined) protectedRoots.push({ root: options.projectRoot, code: "destination-in-project", label: "the current project checkout" });
	for (const item of protectedRoots) {
		if (inside(canonicalRoot(item.root), join(canonicalRoot(parent), basename(resolved)), platform)) {
			return { ok: false, code: item.code, message: `The snapshot destination is inside ${item.label}; choose a directory outside it.` };
		}
	}

	let stat;
	try {
		stat = lstatSync(resolved, { throwIfNoEntry: false });
	} catch {
		return { ok: false, code: "io-error", message: `${resolved} could not be inspected.` };
	}
	if (options.expectExisting) {
		if (stat === undefined) return { ok: false, code: "destination-changed", message: `${resolved} disappeared while the snapshot was being written.` };
		if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, code: "destination-changed", message: `${resolved} was replaced while the snapshot was being written.` };
		if (realpathSync(resolved) !== resolved) return { ok: false, code: "symlinked-ancestor", message: `${resolved} resolves through a symbolic link.` };
	} else if (stat !== undefined) {
		return { ok: false, code: "destination-exists", message: `${resolved} already exists; a snapshot never overwrites or reuses an existing path.` };
	}
	return { ok: true, destination: resolved, parent };
}

// --- status ---------------------------------------------------------------

function scan(configHome: string): SnapshotEntry[] {
	let total = 0;
	const entries: SnapshotEntry[] = [];
	for (const spec of CONFIG_SNAPSHOT_FILES) {
		let result: ReadResult;
		// An absent config home simply reports every fixed file as absent.
		try {
			result = readSourceFile(join(configHome, spec.name), CONFIG_SNAPSHOT_MAX_FILE_BYTES, spec.category);
		} catch {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "refused", refusal: { code: "read-error", message: `${configHome} could not be inspected.` } });
			continue;
		}
		if (result.state === "absent") {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "absent" });
			continue;
		}
		if (result.state === "refused") {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "refused", refusal: { code: result.code, message: result.message } });
			continue;
		}
		if (total + result.bytes.length > CONFIG_SNAPSHOT_MAX_TOTAL_BYTES) {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "refused", refusal: { code: "total-too-large", message: totalBudgetMessage(spec.name, result.bytes.length, CONFIG_SNAPSHOT_MAX_TOTAL_BYTES - total) } });
			continue;
		}
		total += result.bytes.length;
		const bad = inspectJson(result.bytes, spec.name);
		if (bad !== undefined) {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "refused", refusal: bad });
			continue;
		}
		entries.push({
			name: spec.name,
			category: spec.category,
			readOnly: spec.readOnly,
			state: "present",
			bytes: result.bytes.length,
			sha256: result.sha256,
			identity: result.identity,
		});
	}
	return entries;
}

function limitationsFor(platform: NodeJS.Platform): string[] {
	const limitations = [...BASE_LIMITATIONS];
	if (constants.O_NOFOLLOW === undefined) {
		limitations.push(`This platform (${platform}) exposes no O_NOFOLLOW; source symbolic links are refused by lstat plus open-time identity comparison instead.`);
	}
	return limitations;
}

export function inspectConfigSnapshot(options: { configHome: string; platform?: NodeJS.Platform }): ConfigSnapshotStatus {
	const platform = options.platform ?? process.platform;
	const entries = scan(options.configHome);
	return {
		configHome: options.configHome,
		entries,
		refusals: entries.filter((entry) => entry.state === "refused").length,
		limitations: limitationsFor(platform),
	};
}

export function formatSnapshotStatus(status: ConfigSnapshotStatus): string[] {
	const lines = [
		"Gentle AI config snapshot: read-only status",
		`Config home: ${status.configHome}`,
		"Files (metadata only; contents are never shown):",
	];
	for (const entry of status.entries) {
		const label = `${entry.name} [${entry.category}${entry.readOnly ? ", read-only" : ""}]`;
		if (entry.state === "present") lines.push(`  ${label}: present, ${entry.bytes} bytes, sha256 ${entry.sha256}`);
		else if (entry.state === "absent") lines.push(`  ${label}: absent`);
		else lines.push(`  ${label}: refused (${entry.refusal?.code}), ${entry.refusal?.message}`);
	}
	if (status.refusals > 0) lines.push(`${status.refusals} file(s) refused: creation is blocked until each refusal is resolved.`);
	lines.push(`Never included: ${EXCLUSIONS.join(" ")}`);
	lines.push(...status.limitations.map((line) => `Limitation: ${line}`));
	lines.push(`Create: /${CONFIG_SNAPSHOT_COMMAND} create </absolute/new/directory> (interactive TUI, confirmation required).`);
	return lines;
}

// --- create ---------------------------------------------------------------

interface FileIdentity {
	dev: string;
	ino: string;
}

function fileIdentityOf(stat: { dev: number | bigint; ino: number | bigint }): FileIdentity {
	return { dev: String(stat.dev), ino: String(stat.ino) };
}

/** True only while `path` still names the exact file or directory recorded. */
function stillSameEntry(path: string, identity: FileIdentity, kind: "file" | "directory"): boolean {
	let stat;
	try {
		stat = lstatSync(path, { throwIfNoEntry: false });
	} catch {
		return false;
	}
	if (stat === undefined || stat.isSymbolicLink()) return false;
	if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) return false;
	return String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}

function unlinkIfStillOwned(path: string, identity: FileIdentity, sha256: string): void {
	if (!stillSameEntry(path, identity, "file")) return;
	// Inode numbers can be reused after unlink+create, so the recorded hash is a
	// second, independent guard: a different file is never removed.
	const candidate = readSourceFile(path, CONFIG_SNAPSHOT_MAX_FILE_BYTES, "cleanup candidate");
	if (candidate.state !== "present") return;
	if (candidate.identity.dev !== identity.dev || candidate.identity.ino !== identity.ino) return;
	if (candidate.sha256 !== sha256) return;
	try { unlinkSync(path); } catch { /* Already gone or refused; fail closed. */ }
}

function writeNewFile(path: string, bytes: Buffer): FileIdentity {
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)), 0o600);
	let identity: FileIdentity;
	try {
		identity = fileIdentityOf(fstatSync(fd));
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	let complete = false;
	try {
		let written = 0;
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written, written);
		chmodSync(path, 0o600);
		complete = true;
	} finally {
		closeSync(fd);
		// Only a file this run still owns is ever removed here.
		if (!complete) unlinkIfStillOwned(path, identity, createHash("sha256").update(bytes).digest("hex"));
	}
	return identity;
}

function readBack(path: string): Buffer {
	const result = readSourceFile(path, CONFIG_SNAPSHOT_MAX_FILE_BYTES, "destination copy");
	if (result.state !== "present") throw new Error(`${basename(path)} could not be verified after writing.`);
	return result.bytes;
}

function fail(code: SnapshotRefusalCode, message: string, outcome: string[] = ["Nothing was written."]): CreateConfigSnapshotResult {
	return { ok: false, code, message, lines: [`Snapshot refused (${code}): ${message}`, ...outcome] };
}

export function createConfigSnapshot(options: CreateConfigSnapshotOptions): CreateConfigSnapshotResult {
	const platform = options.platform ?? process.platform;
	const destination = resolve(options.destination);

	// 1. Plan the destination before reading anything: a bad destination must be
	//    refused without touching sources or creating a directory.
	const planned = checkDestination({
		destination,
		configHome: options.configHome,
		sourceRoot: options.sourceRoot,
		projectRoot: options.projectRoot,
		platform,
		expectExisting: false,
	});
	if (!planned.ok) return fail(planned.code ?? "io-error", planned.message ?? "The destination was refused.");

	// 2. Read and validate every fixed source file into bounded memory. Required
	//    files are never skipped; one refusal fails the whole snapshot.
	const captured: Array<{ spec: ConfigSnapshotFileSpec; bytes: Buffer; sha256: string; identity: SnapshotIdentity }> = [];
	const entries: SnapshotEntry[] = [];
	let total = 0;
	for (const spec of CONFIG_SNAPSHOT_FILES) {
		const remaining = CONFIG_SNAPSHOT_MAX_TOTAL_BYTES - total;
		let result: ReadResult;
		try {
			result = readSourceFile(
				join(options.configHome, spec.name),
				Math.min(CONFIG_SNAPSHOT_MAX_FILE_BYTES, remaining),
				spec.category,
				remaining < CONFIG_SNAPSHOT_MAX_FILE_BYTES
					? (size) => ({ code: "total-too-large", message: totalBudgetMessage(spec.name, size, remaining) })
					: undefined,
			);
		} catch {
			return fail("read-error", `${options.configHome} could not be inspected.`);
		}
		if (result.state === "absent") {
			entries.push({ name: spec.name, category: spec.category, readOnly: spec.readOnly, state: "absent" });
			continue;
		}
		if (result.state === "refused") return fail(result.code, result.message);
		if (total + result.bytes.length > CONFIG_SNAPSHOT_MAX_TOTAL_BYTES) {
			return fail("total-too-large", totalBudgetMessage(spec.name, result.bytes.length, remaining));
		}
		const bad = inspectJson(result.bytes, spec.name);
		if (bad !== undefined) return fail(bad.code, bad.message);
		total += result.bytes.length;
		captured.push({ spec, bytes: result.bytes, sha256: result.sha256, identity: result.identity });
		entries.push({
			name: spec.name,
			category: spec.category,
			readOnly: spec.readOnly,
			state: "present",
			bytes: result.bytes.length,
			sha256: result.sha256,
			identity: result.identity,
		});
	}

	// 3. Revalidate the destination immediately before creating it.
	const rechecked = checkDestination({
		destination,
		configHome: options.configHome,
		sourceRoot: options.sourceRoot,
		projectRoot: options.projectRoot,
		platform,
		expectExisting: false,
	});
	if (!rechecked.ok) return fail(rechecked.code ?? "io-error", rechecked.message ?? "The destination was refused.");

	const created: Array<{ path: string; identity: FileIdentity; sha256: string }> = [];
	let destinationCreated = false;
	let destinationIdentity: FileIdentity | undefined;
	try {
		mkdirSync(destination, { recursive: false, mode: 0o700 });
		destinationCreated = true;
		destinationIdentity = fileIdentityOf(lstatSync(destination));
		chmodSync(destination, 0o700);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return fail("destination-exists", `${destination} already exists; a snapshot never overwrites or reuses an existing path.`);
		if (destinationCreated) {
			return fail("io-error", `${destination} could not be prepared (${code ?? "unknown error"}).`, [
				`Snapshot failed; the new directory ${destination} may remain and was not removed because its identity is unverified.`,
			]);
		}
		return fail("io-error", `${destination} could not be created (${code ?? "unknown error"}).`);
	}

	const expectOwnedDestination = (): void => {
		if (destinationIdentity !== undefined && stillSameEntry(destination, destinationIdentity, "directory")) return;
		throw Object.assign(new Error(`${destination} was replaced while the snapshot was being written.`), { refusal: "destination-changed" as const });
	};

	try {
		// 4. Copy each file exclusively, verify its bytes, then let the caller
		//    observe the post-copy source revalidation hook.
		for (const item of captured) {
			const target = join(destination, item.spec.name);
			const stillThere = checkDestination({
				destination,
				configHome: options.configHome,
				sourceRoot: options.sourceRoot,
				projectRoot: options.projectRoot,
				platform,
				expectExisting: true,
			});
			if (!stillThere.ok) throw Object.assign(new Error(stillThere.message ?? "The destination changed."), { refusal: stillThere.code ?? "destination-changed" });
			expectOwnedDestination();
			created.push({ path: target, identity: writeNewFile(target, item.bytes), sha256: item.sha256 });
			if (!readBack(target).equals(item.bytes)) throw Object.assign(new Error(`${item.spec.name} changed after it was written.`), { refusal: "destination-changed" as const });
			options.testHooks?.afterFileCopied?.(item.spec.name);
		}

		// 5. Re-read every source after copying: identity and hash must still match.
		for (const item of captured) {
			const again = readSourceFile(join(options.configHome, item.spec.name), CONFIG_SNAPSHOT_MAX_FILE_BYTES, item.spec.category);
			if (again.state !== "present") throw Object.assign(new Error(`${item.spec.name} could not be verified after copying.`), { refusal: "concurrent-change" as const });
			if (again.sha256 !== item.sha256 || !sameIdentity(again.identity, item.identity)) {
				throw Object.assign(new Error(`${item.spec.name} changed while the snapshot was being written.`), { refusal: "concurrent-change" as const });
			}
		}

		const manifest: ConfigSnapshotManifest = {
			schema: CONFIG_SNAPSHOT_SCHEMA,
			createdAt: new Date().toISOString(),
			configHome: options.configHome,
			scope: "Fixed named noncredential JSON preferences in the global Gentle AI config home.",
			exclusions: [...EXCLUSIONS],
			limitations: limitationsFor(platform),
			files: entries.map((entry) => ({
				name: entry.name,
				category: entry.category,
				readOnly: entry.readOnly,
				present: entry.state === "present",
				bytes: entry.bytes ?? null,
				sha256: entry.sha256 ?? null,
				identity: entry.identity ?? null,
				refusal: entry.refusal?.code ?? null,
			})),
		};
		const manifestPath = join(destination, CONFIG_SNAPSHOT_MANIFEST_FILE);
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
		expectOwnedDestination();
		created.push({ path: manifestPath, identity: writeNewFile(manifestPath, manifestBytes), sha256: createHash("sha256").update(manifestBytes).digest("hex") });
		if (JSON.parse(readBack(manifestPath).toString("utf8")).schema !== CONFIG_SNAPSHOT_SCHEMA) {
			throw Object.assign(new Error("The manifest failed verification."), { refusal: "destination-changed" as const });
		}

		const present = entries.filter((entry) => entry.state === "present").length;
		const absent = entries.filter((entry) => entry.state === "absent").length;
		return {
			ok: true,
			destination,
			manifestPath,
			entries,
			manifest,
			lines: [
				`Created config snapshot: ${destination}`,
				`Files: ${present} copied and verified, ${absent} absent and recorded, 0 refused.`,
				`Manifest: ${manifestPath} (identities and SHA256 only; no file contents).`,
				"This is a one-way copy: there is no restore, import, or apply. It is not a full ecosystem backup.",
			],
		};
	} catch (error) {
		// 6. Remove only what this run still owns. Unlinking is kept path-based, so
		//    every recorded file and the directory itself are re-checked by
		//    dev/ino first: a replaced directory or file is left untouched.
		const destinationIsOurs = destinationCreated && destinationIdentity !== undefined
			&& stillSameEntry(destination, destinationIdentity, "directory");
		let outcome: string[];
		if (!destinationCreated) {
			outcome = ["Nothing was written."];
		} else if (!destinationIsOurs) {
			outcome = [`Snapshot failed; ${destination} is not the one this run created, so this run removed nothing there.`];
		} else {
			for (const item of created.reverse()) unlinkIfStillOwned(item.path, item.identity, item.sha256);
			let removed = false;
			try {
				rmdirSync(destination);
				removed = true;
			} catch { /* Not empty: keep the remaining evidence. */ }
			outcome = removed
				? [`Snapshot failed; its partial output was removed. ${destination} no longer exists.`]
				: [`Snapshot failed; incomplete output at ${destination} was retained because this run still owned only part of it.`];
		}
		const refusalCode = (error as { refusal?: SnapshotRefusalCode }).refusal ?? "io-error";
		const message = error instanceof Error ? error.message : "The snapshot failed.";
		return fail(refusalCode, message, outcome);
	}
}

// --- command arguments ----------------------------------------------------

export type ParsedSnapshotArgs =
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "create"; destination: string }
	| { kind: "error"; message: string };

export function parseSnapshotArgs(args: string): ParsedSnapshotArgs {
	const trimmed = args.trim();
	if (trimmed === "" || trimmed === "status") return { kind: "status" };
	if (trimmed === "help") return { kind: "help" };
	const create = /^create\s+(.+)$/.exec(trimmed);
	if (create !== null) {
		const destination = create[1].trim();
		if (!isAbsolute(destination)) return { kind: "error", message: "The create destination must be an absolute path." };
		return { kind: "create", destination };
	}
	if (trimmed === "create") return { kind: "error", message: "The create destination must be an absolute path." };
	return { kind: "error", message: `Unknown arguments. ${CONFIG_SNAPSHOT_USAGE}` };
}
