import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { acquireReadingTurn, paneFocused, READING_TURN_FILE } from "../lib/voice-presence.ts";

// Where voice may act (S8, S9): whether this herdr pane is the focused one, and
// one reading at a time across every Pi process.

test("outside herdr the pane counts as focused and herdr is never asked", async () => {
	const calls: string[][] = [];
	assert.equal(await paneFocused({ env: {}, run: async (_command, args) => { calls.push(args); return ""; } }), true);
	assert.deepEqual(calls, []);
});

test("inside herdr the pane is focused only when herdr says so", async () => {
	const env = { HERDR_PANE_ID: "w1C4:p1", HERDR_BIN_PATH: "/bin/herdr" };
	const answer = (focused: unknown) => JSON.stringify({ id: "cli:pane:get", result: { pane: { pane_id: "w1C4:p1", focused } } });
	const calls: Array<{ command: string; args: string[] }> = [];
	const run = (output: string) => async (command: string, args: string[]) => { calls.push({ command, args }); return output; };
	assert.equal(await paneFocused({ env, run: run(answer(true)) }), true);
	assert.deepEqual(calls[0], { command: "/bin/herdr", args: ["pane", "get", "w1C4:p1"] });
	assert.equal(await paneFocused({ env, run: run(answer(false)) }), false);
	assert.equal(await paneFocused({ env, run: run(answer("yes")) }), false, "anything but true is not focused");
	assert.equal(await paneFocused({ env, run: run("not json") }), false);
	assert.equal(await paneFocused({ env, run: async () => { throw new Error("herdr down"); } }), false, "a failed lookup never opens the microphone");
	assert.equal(await paneFocused({ env: { HERDR_PANE_ID: "w1C4:p1" }, run: run(answer(true)) }), true);
	assert.equal(calls.at(-1)!.command, "herdr", "the binary on the PATH when herdr names none");
});

const scratchRoot = join(import.meta.dirname, "..", "tmp");
mkdirSync(scratchRoot, { recursive: true });
const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(scratchRoot, "voice-turn-"));
	dirs.push(dir);
	return dir;
};
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a free turn is taken at once, recorded with this pid, and released", async () => {
	const dir = scratch();
	const release = await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 101, isAlive: () => true });
	assert.ok(release);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, READING_TURN_FILE), "utf8")), { pid: 101 });
	release();
	assert.throws(() => readFileSync(join(dir, READING_TURN_FILE)), "the turn file is gone");
	release();
});

test("a turn held by a live process waits, and is taken once that process releases it", async () => {
	const dir = scratch();
	const first = await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 101, isAlive: () => true });
	let second: (() => void) | undefined;
	const waiting = acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 202, isAlive: () => true, pollMs: 5 }).then((release) => { second = release; });
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(second, undefined, "still waiting");
	first!();
	await waiting;
	assert.ok(second);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, READING_TURN_FILE), "utf8")), { pid: 202 });
	second!();
});

test("a turn left by a dead process, or an unreadable turn file, is taken over", async () => {
	for (const content of [JSON.stringify({ pid: 999 }), "garbage"]) {
		const dir = scratch();
		writeFileSync(join(dir, READING_TURN_FILE), content);
		const release = await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 303, isAlive: (pid) => pid !== 999, pollMs: 5 });
		assert.ok(release, content);
		assert.deepEqual(JSON.parse(readFileSync(join(dir, READING_TURN_FILE), "utf8")), { pid: 303 });
		release!();
	}
});

test("waiting ends without a turn when the reading is cancelled or waits too long", async () => {
	const dir = scratch();
	const held = await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 101, isAlive: () => true });
	const controller = new AbortController();
	const cancelled = acquireReadingTurn({ dir, signal: controller.signal, pid: 202, isAlive: () => true, pollMs: 5 });
	controller.abort();
	assert.equal(await cancelled, undefined);
	assert.equal(await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 202, isAlive: () => true, pollMs: 5, maxWaitMs: 20 }), undefined);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, READING_TURN_FILE), "utf8")), { pid: 101 }, "the holder keeps its turn");
	held!();
});

test("releasing never removes a turn another process took over", async () => {
	const dir = scratch();
	const release = await acquireReadingTurn({ dir, signal: new AbortController().signal, pid: 101, isAlive: () => true });
	writeFileSync(join(dir, READING_TURN_FILE), JSON.stringify({ pid: 404 }));
	release!();
	assert.deepEqual(JSON.parse(readFileSync(join(dir, READING_TURN_FILE), "utf8")), { pid: 404 });
});
