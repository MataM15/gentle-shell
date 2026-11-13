import assert from "node:assert/strict";
import test from "node:test";
import { acquireLocalReadingTurn, paneFocus, paneFocused } from "../lib/voice-presence.ts";

// Where voice may act (S8, S9): whether this herdr pane is the focused one, and
// the local reading turn a session falls back to when the voice listener cannot
// be reached (S6 slice B: the listener owns the shared turn).

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

test("a focus herdr cannot report is unknown, not unfocused, so a reader can keep its old behavior", async () => {
	const env = { HERDR_PANE_ID: "w1C4:p1" };
	const answer = (focused: unknown) => JSON.stringify({ result: { pane: { focused } } });
	const run = (output: string) => async () => output;
	assert.equal(await paneFocus({ env: {}, run: run(answer(false)) }), "focused", "outside herdr there is one terminal");
	assert.equal(await paneFocus({ env, run: run(answer(true)) }), "focused");
	assert.equal(await paneFocus({ env, run: run(answer(false)) }), "unfocused");
	for (const output of [answer("yes"), answer(undefined), "not json", ""]) assert.equal(await paneFocus({ env, run: run(output) }), "unknown", output);
	assert.equal(await paneFocus({ env, run: async () => { throw new Error("herdr down"); } }), "unknown");
	// The microphone keeps its stricter reading: only a focused answer opens it.
	assert.equal(await paneFocused({ env, run: async () => { throw new Error("herdr down"); } }), false);
	assert.equal(await paneFocused({ env, run: run(answer("yes")) }), false);
});

test("the local reading turn lets one reading at a time", async () => {
	const first = await acquireLocalReadingTurn();
	assert.ok(first);
	let second: (() => void) | undefined;
	const waiting = acquireLocalReadingTurn().then((release) => {
		second = release;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(second, undefined, "still waiting");
	first!();
	await waiting;
	assert.ok(second, "the reading that waited takes the turn once it is free");
	second!();
});

test("a cancelled wait leaves the queue in order and never reads alongside its holder", async () => {
	const first = await acquireLocalReadingTurn();
	const controller = new AbortController();
	const cancelled = acquireLocalReadingTurn({ signal: controller.signal });
	controller.abort();
	assert.equal(await cancelled, undefined, "a cancelled reading takes no turn");
	let third: (() => void) | undefined;
	const waiting = acquireLocalReadingTurn().then((release) => {
		third = release;
	});
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(third, undefined, "the queue is never jumped by a cancelled waiter");
	first!();
	await waiting;
	assert.ok(third);
	third!();
});
