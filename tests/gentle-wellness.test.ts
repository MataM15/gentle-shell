import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gentleWellness from "../extensions/gentle-wellness.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";
import { REMINDERS } from "../lib/shell-wellness.ts";
import type { WellnessState } from "../lib/wellness-state.ts";

// Wellness inside the folded band (odd/tasks/folded-band.md S2d, S5, S6, S7):
// the extension paints ↻ glyphs in the rail and the band alike, hides its
// standalone below-editor paint then, and keeps its resets honest.

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const at = Date.parse("2026-09-27T23:30:05Z");

async function fixture(t: TestContext) {
	const handlers = new Map<string, Function>();
	let factory: Function | undefined;
	const resets: string[] = [];
	const shared: WellnessState = { version: 1, reminders: Object.fromEntries(REMINDERS.map((key) => [key, { deadline: at + 3_600_000, revision: key }])) as WellnessState["reminders"] };
	gentleWellness({ on(name: string, fn: Function) { handlers.set(name, fn); }, registerCommand() {} } as unknown as ExtensionAPI,
		{}, () => JSON.stringify({ enabled: true, notifications: false, language: "es", utcOffsetMinutes: -180 }), () => ({
			async loadOrInitialize() { return shared; }, async load() { return shared; },
			async reset(target: string) { resets.push(target); return shared; }, async claimDue() { return true; },
		}));
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: at });
	const ctx = { mode: "tui", hasUI: true, ui: { theme, setWidget(_key: string, value: Function | undefined) { factory = value; }, notify() {} } };
	await handlers.get("session_start")!({}, ctx);
	let renders = 0;
	const tui = { terminal: { columns: 160 }, requestRender() { renders++; } } as unknown as TUI;
	const widget = factory!(tui);
	t.after(() => handlers.get("session_shutdown")!());
	const state = sidebarState(tui);
	return { tui, widget, state, resets, renders: () => renders, raw: () => state.parts.get("wellness")! };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("S2d: the standalone below-editor Breaks paint stays up with no band to hand off to", async (t) => {
	const f = await fixture(t);
	assert.ok(f.widget.render(160).length > 0, "the fallback paints");
	assert.ok(f.raw().render(50).length > 0, "the registered part still renders");
});

test("the registered part paints ↻ glyphs", async (t) => {
	const f = await fixture(t);
	const rail = f.raw().render(50);
	assert.equal((rail.join("\n").match(/↻/g) ?? []).length, 3, "the card keeps the reset affordance visible");
});

test("S7: the digest is stable while nothing changes", async (t) => {
	const f = await fixture(t);
	f.raw().render(50);
	const rail = f.raw().digest!();
	assert.equal(f.raw().digest!(), rail);
});

test("S6: a click on the ↻ glyph or the label resets that reminder through the registered part", async (t) => {
	const f = await fixture(t);
	const lines = f.raw().render(50);
	const click = (x: number, y: number) => f.raw().handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 50, height: lines.length, shift: false, alt: false, ctrl: false } as never);
	const glyph = visibleWidth(lines[2]!.slice(0, lines[2]!.indexOf("↻")));
	assert.equal(click(glyph, 2)?.handled, true);
	await flush();
	assert.deepEqual(f.resets, ["break"]);
	const label = visibleWidth(lines[3]!.slice(0, lines[3]!.indexOf("Estirar")));
	assert.equal(click(label, 3)?.handled, true);
	await flush();
	assert.deepEqual(f.resets, ["break", "stretch"]);
	assert.equal(click(glyph, 4), undefined, "Cena is inert");
});

test("a click on the ↻ glyph resets that reminder after the part repainted elsewhere", async (t) => {
	const f = await fixture(t);
	const glyphLines = f.raw().render(50);
	const glyph = visibleWidth(glyphLines[1]!.slice(0, glyphLines[1]!.indexOf("↻")));
	f.raw().render(50);
	const result = f.raw().handleMouse?.({ type: "click", button: "left", x: glyph, y: 1, screenX: glyph, screenY: 1, width: 50, height: 6, shift: false, alt: false, ctrl: false } as never);
	await flush();
	assert.equal(result?.handled, true);
	assert.equal(f.resets.length, 1);
});
