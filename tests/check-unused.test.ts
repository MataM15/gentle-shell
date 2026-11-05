import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// S11 (odd/tasks/shell-personal-rework.md): the gate that keeps dead imports and locals from piling up.

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = (target?: string) => spawnSync(process.execPath, [join(root, "scripts", "check-unused.mjs"), ...(target ? ["--root", join(root, "tests", "fixtures", "unused", target)] : [])], { encoding: "utf8" });

test("the unused check catches an unused import and an unused local", () => {
	const result = check("dirty");
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stderr, /lib\/unused-import\.ts:1 +'join' is declared but its value is never read/);
	assert.match(result.stderr, /extensions\/unused-local\.ts:2 +'leftover' is declared but its value is never read/);
});

test("the unused check passes a tree whose imports and locals are all read", () => {
	const result = check("clean");
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /unused: clean/);
});

test("lib/ and extensions/ are clean: only upstream's recorded findings remain", () => {
	const result = check();
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
