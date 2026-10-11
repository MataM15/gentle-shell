import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { railPanelKey, readRailCollapsed, writeRailCollapsed } from "../lib/rail-collapse.ts";

// S14 (odd/tasks/palette-button.md): the collapsed rail is remembered across
// sessions in the Gentle config home, and alt+h toggles it unless remapped.

function home(t: test.TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-rail-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("a missing file means expanded; writes round-trip and stay atomic JSON", (t) => {
	const dir = home(t);
	assert.equal(readRailCollapsed({ gentlePiConfigHome: dir }), false);
	const path = writeRailCollapsed(true, { gentlePiConfigHome: dir });
	assert.equal(path, join(dir, "rail.json"));
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { schema: "gentle-pi.rail/v1", collapsed: true });
	assert.equal(readRailCollapsed({ gentlePiConfigHome: dir }), true);
	writeRailCollapsed(false, { gentlePiConfigHome: dir });
	assert.equal(readRailCollapsed({ gentlePiConfigHome: dir }), false);
});

test("a malformed or foreign file reads as expanded", (t) => {
	const dir = home(t);
	for (const raw of ["{", "[]", JSON.stringify({ collapsed: true }), JSON.stringify({ schema: "gentle-pi.rail/v1", collapsed: "yes" }), JSON.stringify({ schema: "gentle-pi.rail/v1", collapsed: true, extra: 1 })]) {
		writeFileSync(join(dir, "rail.json"), raw);
		assert.equal(readRailCollapsed({ gentlePiConfigHome: dir }), false, raw);
	}
});

test("the panel shortcut defaults to alt+h, can be remapped, and off or empty disables it", () => {
	assert.equal(railPanelKey({}), "alt+h");
	assert.equal(railPanelKey({ GENTLE_PI_PANEL_KEY: " ctrl+alt+p " }), "ctrl+alt+p");
	assert.equal(railPanelKey({ GENTLE_PI_PANEL_KEY: "off" }), undefined);
	assert.equal(railPanelKey({ GENTLE_PI_PANEL_KEY: "OFF" }), undefined);
	assert.equal(railPanelKey({ GENTLE_PI_PANEL_KEY: "" }), undefined);
});
