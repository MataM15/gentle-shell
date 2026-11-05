#!/usr/bin/env node
// Unused imports and locals in lib/ and extensions/ (TypeScript's noUnusedLocals).
//
// Dead code piled up after the upstream merge (imports of removed cards, a
// receiver nothing read), so this gate fails on any unused import or local.
// Exports are not checked: a module may export for its tests.
//
// UPSTREAM_BASELINE records what upstream's own files already carried when
// the personal rework was merged (origin/main 7ecb826a2). Those files stay
// untouched to keep merges clean, so the gate ratchets them: a file may not
// gain a finding, and lowering a count after an upstream cleanup is welcome.
// Every other file must have none.
//
// Usage:
//   node scripts/check-unused.mjs [--root <dir>]   fail on any finding above the baseline

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const UPSTREAM_BASELINE = {
	"extensions/gentle-ai.ts": 12,
	"extensions/quiet-tools.ts": 1,
	"lib/native-review-cli.ts": 8,
	"lib/review-candidate-view-owner.ts": 1,
	"lib/review-consent-component.ts": 3,
	"lib/review-transaction.ts": 4,
	"lib/star-prompt.ts": 1,
	"lib/vim-operator-engine.ts": 2,
	"lib/windows-session-transport.ts": 3,
};

// "declared but never read", "all imports unused", "declared but never used" (types), destructured variants.
const UNUSED_CODES = new Set(["TS6133", "TS6192", "TS6196", "TS6198", "TS6199", "TS6205"]);
const DIAGNOSTIC = /^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const here = dirname(fileURLToPath(import.meta.url));
const rootFlag = process.argv.indexOf("--root");
const packageRoot = resolve(rootFlag === -1 ? dirname(here) : process.argv[rootFlag + 1]);
const compilerRoot = dirname(here);

function compile() {
	const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
	// The config lives outside the tree so a checked root (or a fixture) needs no tsconfig of its own.
	const scratch = mkdtempSync(join(tmpdir(), "gentle-unused-"));
	try {
		const config = join(scratch, "tsconfig.json");
		writeFileSync(config, JSON.stringify({
			extends: join(compilerRoot, "tsconfig.json"),
			compilerOptions: { noUnusedLocals: true, typeRoots: [join(compilerRoot, "node_modules", "@types")] },
			include: [join(packageRoot, "lib/**/*.ts"), join(packageRoot, "extensions/**/*.ts")],
		}));
		try {
			execFileSync(process.execPath, [tsc, "-p", config], { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			return "";
		} catch (error) {
			return `${error.stdout ?? ""}${error.stderr ?? ""}`;
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const findings = new Map();
for (const line of compile().split(/\r?\n/)) {
	const match = DIAGNOSTIC.exec(line);
	if (!match) continue;
	if (!UNUSED_CODES.has(match[4])) {
		// A real type error or a broken setup must not read as "clean".
		console.error(`unused: unexpected compiler output: ${line}`);
		process.exit(1);
	}
	const file = relative(packageRoot, resolve(packageRoot, match[1])).split("\\").join("/");
	if (!findings.has(file)) findings.set(file, []);
	findings.get(file).push(`${file}:${match[2]}  ${match[5].trim()}`);
}

const failures = [];
for (const [file, lines] of findings) {
	const allowed = UPSTREAM_BASELINE[file] ?? 0;
	if (lines.length > allowed) failures.push(...lines);
}
const shrunk = Object.entries(UPSTREAM_BASELINE).filter(([file, count]) => (findings.get(file)?.length ?? 0) < count);

if (failures.length > 0) {
	console.error(`unused: ${failures.length} unused import(s) or local(s) above the baseline:`);
	for (const line of failures.slice(0, 40)) console.error(`  ${line}`);
	process.exit(1);
}
for (const [file, count] of shrunk) console.log(`unused: ${file} dropped below its baseline of ${count}; lower UPSTREAM_BASELINE.`);
console.log(`unused: clean (${[...findings.values()].reduce((sum, lines) => sum + lines.length, 0)} upstream finding(s) within the baseline)`);
