import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DINNER_GRACE_MS, parseWellnessConfig, WellnessSession, wellnessDeadline, REMINDERS } from "../lib/shell-wellness.ts";
import gentleWellness, { resolveAgentDir } from "../extensions/gentle-wellness.ts";
import { WellnessStateStore, type WellnessState } from "../lib/wellness-state.ts";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sidebarState } from "../lib/shell-sidebar.ts";
import type { TUI } from "@earendil-works/pi-tui";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const now = Date.parse("2026-09-27T23:30:00Z");
const config = parseWellnessConfig({ enabled: true, language: "es", utcOffsetMinutes: -180 })!;

test("wellness requires valid explicit opt-in and preserves preferences", () => {
	for (const input of [undefined, {}, [], { enabled: false }, { enabled: true, notifications: "yes" },
		{ enabled: true, dinnerTime: "24:00" }, { enabled: true, waterMinutes: 0 },
		{ enabled: true, utcOffsetMinutes: -841 }, { enabled: true, language: "other" }]) {
		assert.equal(parseWellnessConfig(input), undefined);
	}
	assert.equal(config.language, "es");
	assert.equal(config.utcOffsetMinutes, -180);
	assert.equal(parseWellnessConfig({ enabled: true, notifications: false })?.notifications, false);
});

test("UTC minus three dinner is host-timezone independent and rolls to tomorrow", () => {
	assert.equal(wellnessDeadline(config, "dinner", now), Date.parse("2026-09-28T00:00:00Z"));
	assert.equal(wellnessDeadline(config, "dinner", Date.parse("2026-09-28T00:00:00Z")), Date.parse("2026-09-29T00:00:00Z"));
});

test("rendering never consumes notices and resets affect only the selected reminder", () => {
	const model = new WellnessSession(config, now);
	model.render(now + 30 * 60000, 48, theme);
	assert.deepEqual(model.tick(now + 30 * 60000), ["water", "dinner"]);
	assert.deepEqual(model.tick(now + 30 * 60000), []);
	assert.equal(model.reset("unknown", now), false);
	assert.equal(model.reset("water", now), true);
	assert.deepEqual(model.tick(now + 30 * 60000), ["water"]);
});

test("Spanish rail, clock and date stay bounded and the card paints no reset glyph", () => {
	const model = new WellnessSession(config, now);
	for (const width of [48, 44, 35, 20]) {
		const lines = model.render(now, width, theme);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.match(lines.join("\n"), /Breaks/);
		assert.doesNotMatch(lines[0]!, /✿/, `rail card title has no glyph at ${width}`);
		assert.match(lines.join("\n"), /Agua/);
		assert.doesNotMatch(lines.join("\n"), /↻/, `no reset glyph survives at ${width}`);
	}
});

test("each reset click target spans that row's whole label and stops at the clock", () => {
	const model = new WellnessSession(config, now);
	const lines = model.render(now, 48, theme);
	for (const [target, label] of [["water", "Agua"], ["break", "Descanso"], ["stretch", "Estirar"]] as const) {
		const y = lines.findIndex((line) => line.includes(label));
		assert.ok(y >= 0, `${label} is painted`);
		const from = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(label)));
		for (let x = from; x < from + label.length; x++) assert.equal(model.resetTargetAt(x, y), target, `column ${x} of ${label}`);
		assert.equal(model.resetTargetAt(from + label.length, y), undefined, "the clock and the time stay inert");
	}
	const dinnerRow = lines.findIndex((line) => line.includes("Cena"));
	assert.equal(model.resetTargetAt(1, dinnerRow), undefined, "dinner has no manual reset");
});

test("only a due reminder paints Ahora bold in accent, and other values keep the normal weight", () => {
	// Accent stands in for the theme's accent role; anything else stays untagged.
	const ansi = { fg: (role: string, text: string) => role === "accent" ? `\x1b[35m${text}\x1b[39m` : text, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
	const model = new WellnessSession({ ...config, dinnerTime: "08:00" }, now);
	for (const width of [48, 40]) {
		const before = model.render(now, width, ansi).join("\n");
		assert.doesNotMatch(before, /\x1b\[35m/, `nothing due at ${width} columns paints no accent`);
		const text = model.render(now + 30 * 60000, width, ansi).join("\n");
		assert.ok(text.includes("\x1b[35m\x1b[1mAhora\x1b[22m\x1b[39m"), `the due item is bold accent at ${width} columns`);
		assert.equal(text.match(/Ahora/g)?.length, 1, "only the due reminder is marked");
		assert.doesNotMatch(text, /\x1b\[35m1h 30m/, "the other values keep the normal weight");
	}
});

test("narrow widths render a compact card with the time in the title", () => {
	const model = new WellnessSession(config, now);
	for (const width of [43, 35]) {
		const lines = model.render(now, width, theme);
		assert.ok(lines.length <= 4, `width ${width} used ${lines.length} rows`);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.match(lines[0]!, /Breaks · 20:30/);
		assert.doesNotMatch(lines[0]!, /✿/, "a rail card title: no glyph");
		const body = lines.join("\n");
		for (const label of ["Agua", "Descanso", "Estirar", "Cena"]) assert.match(body, new RegExp(label));
		assert.equal(model.resetTargetAt(0, 1), undefined);
	}
	assert.equal(model.render(now, 44, theme).length, 6);
});

test("a due reminder takes the accent label and the warning frame at every width", () => {
	// Zero-width escapes keep wrapping honest; yellow stands in for the warning role.
	const ansi = { fg: (role: string, text: string) => role === "warning" ? `\x1b[33m${text}\x1b[39m` : role === "accent" ? `\x1b[35m${text}\x1b[39m` : text, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
	// Dinner away from the fixture's 21:00 so only water comes due 30 minutes later.
	const model = new WellnessSession({ ...config, dinnerTime: "08:00" }, now);
	for (const width of [48, 40]) {
		const before = model.render(now, width, ansi).join("\n");
		assert.doesNotMatch(before, /\x1b\[33m/, `nothing due at ${width} columns keeps the info tone`);
		const due = model.render(now + 30 * 60000, width, ansi);
		const text = due.join("\n");
		assert.ok(text.includes("\x1b[35m\x1b[1mAhora\x1b[22m\x1b[39m"), `the due label carries the accent at ${width} columns`);
		assert.ok(due[0]!.includes("\x1b[33m"), `the frame takes the warning tone at ${width} columns`);
		assert.equal(text.match(/Ahora/g)?.length, 1, "only the due reminder is marked");
		assert.ok(due.every((line) => visibleWidth(line) <= width), `bounded at ${width} columns`);
	}
});

test("shared revisions synchronize deadlines and rearm notification latches", () => {
	const model = new WellnessSession(config, now);
	const shared: WellnessState = { version: 1, reminders: Object.fromEntries(REMINDERS.map(key => [key, { deadline: now, revision: key }])) as WellnessState["reminders"] };
	assert.equal(model.applySharedState(shared), true);
	assert.deepEqual(model.tick(now), [...REMINDERS]);
	assert.equal(model.applySharedState(shared), false);
	assert.deepEqual(model.tick(now), []);
	shared.reminders.water = { deadline: now, revision: "next" };
	assert.equal(model.applySharedState(shared), true);
	assert.deepEqual(model.tick(now), ["water"]);
});

test("dinner past its grace window is stale; within it, it stays due", () => {
	const model = new WellnessSession(config, now);
	const dinner = wellnessDeadline(config, "dinner", now);
	assert.equal(model.dinnerExpired(dinner), false);
	assert.equal(model.dinnerExpired(dinner + DINNER_GRACE_MS - 1), false);
	assert.equal(model.dinnerExpired(dinner + DINNER_GRACE_MS), true);
});

test("store keeps only the current revision's claim, pruning superseded ones on reset and startup", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "wellness-claims-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = new WellnessStateStore(root, config);
	const dir = join(root, "gentle-wellness-state");
	const claims = () => readdirSync(dir).filter((name) => name.startsWith(".claim-")).sort();
	const first = (await store.loadOrInitialize(now))!;
	const due = first.reminders.water.deadline;
	assert.equal(await store.claimDue("water", first.reminders.water.revision, due), true);
	assert.equal(await store.claimDue("water", first.reminders.water.revision, due), false, "the kept claim still blocks a repeat");
	const stale = `.claim-break-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}`;
	writeFileSync(join(dir, stale), "");
	const reset = (await store.reset("water", due))!;
	assert.notEqual(reset.reminders.water.revision, first.reminders.water.revision);
	assert.deepEqual(claims(), [stale], "the superseded water claim is gone; other reminders are untouched by a water reset");
	await new WellnessStateStore(root, config).loadOrInitialize(due);
	assert.deepEqual(claims(), [], "startup prunes claims whose revision is no longer current");
});

// In-memory store and UI only: these tests never touch preferences or shared files.
async function extensionFixture(t: TestContext, notifications = true, enabled = true, reset?: (target: string) => WellnessState, frozenNow?: number) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	let factory: Function | undefined;
	const notices: string[] = [];
	let claims = 0;
	let loads = 0;
	const resets: string[] = [];
	const shared: WellnessState = { version: 1, reminders: Object.fromEntries(REMINDERS.map(key => [key, { deadline: 0, revision: key }])) as WellnessState["reminders"] };
	gentleWellness({
		on(name: string, fn: Function) { handlers.set(name, fn); },
		registerCommand(name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, def); },
	} as unknown as ExtensionAPI,
		{}, () => JSON.stringify({ enabled, notifications, language: "es", utcOffsetMinutes: -180 }), () => ({
			async loadOrInitialize() { loads++; return shared; }, async load() { return shared; },
			async reset(target: string) { resets.push(target); return reset?.(target) ?? shared; }, async claimDue() { claims++; return true; },
		}));
	if (frozenNow === undefined) t.mock.timers.enable({ apis: ["setInterval"] });
	else t.mock.timers.enable({ apis: ["setInterval", "Date"], now: frozenNow });
	const ctx = { mode: "tui", hasUI: true, ui: { theme, setWidget(_key: string, value: Function | undefined) { factory = value; }, notify(text: string) { notices.push(text); } } };
	await handlers.get("session_start")!({}, ctx);
	const tui = { terminal: { columns: 140 }, requestRender() {} } as unknown as TUI;
	const widget = factory?.(tui);
	t.after(() => handlers.get("session_shutdown")!());
	return { tui, widget, notices, resets, commands, ctx, claims: () => claims, loads: () => loads };
}

test("extension registers the optional rail and delivers Spanish due notices once", async t => {
	const f = await extensionFixture(t);
	assert.ok(sidebarState(f.tui).parts.has("wellness"));
	t.mock.timers.tick(1000);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(f.claims(), 4);
	assert.ok(f.notices.includes("Hora de tomar agua."));
	t.mock.timers.tick(1000);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(f.claims(), 4);
	f.widget.dispose();
	assert.equal(sidebarState(f.tui).parts.has("wellness"), false);
});

test("a stale dinner rolls over to the next dinner time without a late notice", async t => {
	const future = Date.now() + 86_400_000;
	const f = await extensionFixture(t, true, true, (target) => ({ version: 1, reminders: Object.fromEntries(REMINDERS.map(key =>
		[key, key === target ? { deadline: future, revision: "rolled" } : { deadline: future, revision: key }])) as WellnessState["reminders"] }));
	t.mock.timers.tick(1000);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.deepEqual(f.resets, ["dinner"]);
	assert.equal(f.notices.includes("Hora de cenar."), false);
});

test("notification opt-out keeps the widget without emitting notices", async t => {
	const f = await extensionFixture(t, false);
	t.mock.timers.tick(1000);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.ok(f.widget);
	assert.equal(f.claims(), 4);
	assert.deepEqual(f.notices, []);
});

test("disabled wellness neither mounts nor initializes persistence", async t => {
	const f = await extensionFixture(t, true, false);
	assert.equal(f.widget, undefined);
	assert.equal(f.loads(), 0);
});

test("command gentle-wellness reset validates arguments and notifies user", async t => {
	const f = await extensionFixture(t);
	const command = f.commands.get("gentle-wellness")!;
	assert.ok(command);
	// Invalid usage
	await command.handler("unknown", f.ctx);
	assert.ok(f.notices.some(n => n.includes("Uso:")));

	await command.handler("reset invalidTarget", f.ctx);
	assert.ok(f.notices.some(n => n.includes("Uso:")));

	// Valid resets
	await command.handler("reset water", f.ctx);
	assert.ok(f.resets.includes("water"));
	assert.ok(f.notices.some(n => n.includes("Recordatorio reiniciado: Agua")));

	await command.handler("reset all", f.ctx);
	assert.ok(f.resets.includes("all"));
	assert.ok(f.notices.some(n => n.includes("Recordatorios reiniciados")));
});

test("resolveAgentDir honors PI_CODING_AGENT_DIR override", () => {
	assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent/dir" }), "/custom/agent/dir");
});

async function pollFor(t: TestContext, seconds: number) {
	for (let second = 0; second < seconds; second++) {
		t.mock.timers.tick(1000);
		for (let i = 0; i < 12; i++) await Promise.resolve();
	}
}

test("the actual Wellness rail exposes a stable digest that changes when displayed text changes", async t => {
	const f = await extensionFixture(t, true, true, undefined, Date.parse("2026-09-27T23:30:05Z"));
	const rail = sidebarState(f.tui).parts.get("wellness")!;
	assert.equal(typeof rail.digest, "function");
	rail.render(48);
	const first = rail.digest!();
	assert.equal(rail.digest!(), first);
	await pollFor(t, 5);
	assert.equal(rail.digest!(), first, "unchanged displayed text retains the same digest");
	await pollFor(t, 60);
	assert.notEqual(rail.digest!(), first, "changed clock text invalidates the rail");
});

// Every Pi render re-lays out the whole transcript, so a 1 s repaint made idle long sessions burn a core.
test("the 1 s poll requests a render only when the painted card changes", async t => {
	const f = await extensionFixture(t, true, true, undefined, Date.parse("2026-09-27T23:30:05Z"));
	let renders = 0;
	f.tui.requestRender = () => { renders++; };
	assert.ok(f.widget.render(140).length > 0, "the rail painted the card");
	await pollFor(t, 5);
	assert.equal(f.claims(), 4, "due reminders are still claimed every poll");
	assert.equal(renders, 0, "no render while the clock and reminders show the same text");
	await pollFor(t, 60);
	assert.equal(renders, 1, "the minute change repaints once");
});

test("a hidden phone-width card never requests a render from the poll", async t => {
	const f = await extensionFixture(t, true, true, undefined, Date.parse("2026-09-27T23:30:05Z"));
	let renders = 0;
	f.tui.requestRender = () => { renders++; };
	(f.tui.terminal as { columns: number }).columns = 40;
	assert.deepEqual(f.widget.render(40), []);
	await pollFor(t, 120);
	assert.equal(renders, 0);
});

test("phone-sized terminals (43 columns or fewer) hide the Wellness paint but keep reminders and resets running", async t => {
	const f = await extensionFixture(t);
	const columns = f.tui.terminal as { columns: number };
	for (const width of [40, 43]) {
		columns.columns = width;
		assert.deepEqual(f.widget.render(width), [], `hidden at ${width} columns`);
	}
	columns.columns = 44;
	assert.ok(f.widget.render(44).length > 0, "painted again one column past the phone breakpoint");
	columns.columns = 56;
	assert.ok(f.widget.render(56).length > 0, "the portrait layout shows Breaks below the editor at 56 columns");
	columns.columns = 40;
	t.mock.timers.tick(1000);
	for (let i = 0; i < 12; i++) await Promise.resolve();
	assert.equal(f.claims(), 4, "due reminders are still claimed");
	assert.ok(f.notices.includes("Hora de tomar agua."), "notices are still delivered");
	await f.commands.get("gentle-wellness")!.handler("reset water", f.ctx);
	assert.equal(f.resets.at(-1), "water", "the reset command still works while hidden");
});

test("a stale reset hit never fires while Wellness is hidden on a phone-sized terminal, and works again above 43", async t => {
	const f = await extensionFixture(t);
	const columns = f.tui.terminal as { columns: number };
	const rows = f.widget.render(140);
	const y = rows.findIndex(row => row.includes("Agua"));
	assert.ok(y >= 0, "the reset row is painted when wide");
	const x = visibleWidth(rows[y]!.slice(0, rows[y]!.indexOf("Agua")));
	const click = { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 140, height: rows.length, shift: false, alt: false, ctrl: false } as const;
	const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
	for (const width of [43, 40]) {
		columns.columns = width;
		assert.deepEqual(f.widget.render(width), []);
		assert.equal(f.widget.handleMouse?.(click), undefined, `hidden click is not handled at ${width}`);
		await flush();
		assert.deepEqual(f.resets, [], `no reset at ${width}`);
	}
	columns.columns = 141;
	const again = f.widget.render(141);
	const row = again.findIndex(line => line.includes("Agua"));
	const col = visibleWidth(again[row]!.slice(0, again[row]!.indexOf("Agua")));
	assert.equal(f.widget.handleMouse?.({ ...click, x: col, y: row, screenX: col, screenY: row, width: 141 })?.handled, true, "visible again: the reset label works");
	await flush();
	assert.equal(f.resets.length, 1);
});

// S5 (odd/tasks/folded-band.md): the folded band restores the ↻ reset glyph column.
test("S5: resetGlyphs paints ↻ for Agua, Descanso and Estirar, immediately left of the clock, and never for Cena", () => {
	const model = new WellnessSession(config, now);
	const lines = model.render(now, 50, theme, { resetGlyphs: true });
	assert.equal(lines.length, 6);
	assert.ok(lines.every((line) => visibleWidth(line) === 50));
	const glyphRows = [1, 2, 3].map((y) => lines[y]!);
	const columns = glyphRows.map((line) => visibleWidth(line.slice(0, line.indexOf("↻"))));
	assert.equal(new Set(columns).size, 1, "one glyph column");
	assert.ok(lines[4]!.includes("Cena") && !lines[4]!.includes("↻"), "dinner has no glyph");
	assert.match(lines[1]!, /Agua +\d+m +↻ +[┌│└╶╷ ]/, "the glyph sits between the countdown and the clock");
});

test("S5: with resetGlyphs both the ↻ glyph and the row label reset that reminder", () => {
	const model = new WellnessSession(config, now);
	const lines = model.render(now, 50, theme, { resetGlyphs: true });
	for (const [target, label, y] of [["water", "Agua", 1], ["break", "Descanso", 2], ["stretch", "Estirar", 3]] as const) {
		const glyph = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf("↻")));
		const from = visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(label)));
		assert.equal(model.resetTargetAt(glyph, y), target, `glyph of ${label}`);
		for (let x = from; x < from + label.length; x++) assert.equal(model.resetTargetAt(x, y), target, `label column ${x}`);
		assert.equal(model.resetTargetAt(glyph + 2, y), undefined, "the clock stays inert");
		assert.equal(model.resetTargetAt(glyph, y + 10), undefined, "other rows are inert");
	}
	const dinner = lines.findIndex((line) => line.includes("Cena"));
	for (let x = 0; x < 50; x++) assert.equal(model.resetTargetAt(x, dinner), undefined, "dinner has no reset target");
});

test("S5: without resetGlyphs the rail format is unchanged, and a later plain render drops the glyph hits", () => {
	const model = new WellnessSession(config, now);
	const withGlyphs = model.render(now, 50, theme, { resetGlyphs: true });
	const glyph = visibleWidth(withGlyphs[1]!.slice(0, withGlyphs[1]!.indexOf("↻")));
	const rail = model.render(now, 50, theme);
	assert.doesNotMatch(rail.join("\n"), /↻/);
	assert.equal(model.resetTargetAt(glyph, 1), undefined, "stale glyph hit is gone after the rail render");
	assert.deepEqual(rail, model.render(now, 50, theme, { resetGlyphs: false }));
	assert.doesNotMatch(model.render(now, 40, theme, { resetGlyphs: true }).join("\n"), /↻/, "compact narrow card never paints glyphs");
});
