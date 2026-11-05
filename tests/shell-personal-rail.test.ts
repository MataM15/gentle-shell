import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { buildShellHeaderModel, renderShellRailHeader, renderShellStatusBar, shellHeaderCommandsHit, shellHeaderUsageHit, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarRailHeader, sidebarStatusBar } from "../lib/shell-sidebar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import gentleWellness from "../extensions/gentle-wellness.ts";
import { parseWellnessConfig, REMINDERS, WellnessSession } from "../lib/shell-wellness.ts";
import type { WellnessState } from "../lib/wellness-state.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext } from "node:test";

// The owner's personal look on top of upstream's fullscreen rework
// (odd/tasks/shell-personal-rework.md S3, S7; design/shell-personal-rework/01-wide.html).

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const model: ShellBarModel = {
	cwd: "~/work/gentle-pi-review-2750", branch: "feat/shell-visual-snapshots", dirty: undefined, sessionName: undefined, profile: "claude (session)",
	modelId: "claude-fable-5-1", effort: "low", contextPercent: 17, contextWindow: 1000, costTotal: 0, subscription: false,
	permission: { mode: "SUPER-YOLO" }, statuses: [],
	usage: { provider: "anthropic", plan: undefined, fetchedAt: 0, limits: [{ name: "claude-fable-5-1", limitReached: false, windows: [
		{ label: "5h", usedPercent: 5, windowSeconds: 18000, resetAt: null },
		{ label: "week", usedPercent: 40, windowSeconds: 604800, resetAt: null },
	] }] },
};
const rows = (lines: string[]) => lines.map((line) => stripAnsi(line));

test("the rail header stacks model, ctx and cost, then the commands and usage actions between two rules (S3)", () => {
	for (const width of [50, 40]) {
		const chrome = renderShellRailHeader(buildShellHeaderModel(model), plain, width, "alt+u", { density: "minimal", visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } }, "alt+k");
		const text = rows(chrome.rows);
		assert.ok(text.every((row) => visibleWidth(row) <= width), `no row wider than ${width}`);
		assert.equal(text[0]!.trim(), "claude-fable-5-1 · low");
		assert.equal(text[1]!.trim(), "ctx ▰▱▱▱▱▱▱▱ 17% ◇ $0.000");
		assert.match(text[2]!, /^ ┈+ ?$/, "dotted rule");
		assert.equal(text[3]!.trimEnd(), " ≡ commands   [alt+k]");
		assert.equal(text[4]!.trimEnd(), " ◔ usage      [alt+u]");
		assert.match(text[5]!, /^─+$/, "closing rule spans the rail");
		assert.equal(text.length, 6);
		assert.equal(chrome.commandsRow, 3);
		assert.equal(chrome.headerRow, 4);
		assert.ok(shellHeaderCommandsHit(chrome, 3, 3) && shellHeaderCommandsHit(chrome, 12, 3), "commands label is a hit target");
		assert.ok(!shellHeaderCommandsHit(chrome, 3, 4) && !shellHeaderCommandsHit(chrome, 3, 0));
		assert.ok(shellHeaderUsageHit(chrome, 3, 4) && !shellHeaderUsageHit(chrome, 3, 3), "usage label is a hit target");
	}
});

test("the rail header paints only theme roles (S7)", () => {
	const roles = new Set<string>();
	const spy = { fg: (role: string, text: string) => { roles.add(role); return text; }, bold: (text: string) => text };
	renderShellRailHeader(buildShellHeaderModel(model), spy, 50, "alt+u", undefined, "alt+k");
	for (const role of roles) assert.match(role, /^(accent|border|borderAccent|muted|dim|text|success|warning|error|syntaxFunction)$/, role);
});

test("the wide status bar keeps branch, mode and the weekly gauge and drops model, ctx and cost (S3)", () => {
	const wide = stripAnsi(renderShellStatusBar(model, plain, 180, "alt+u", undefined, undefined, { rail: true }).rows[0]!);
	assert.equal(visibleWidth(wide), 180);
	assert.match(wide, /^ feat\/shell-visual-snapshots +│ +SUPER-YOLO +week ▰▰▰▱▱▱▱▱ 40% +alt\+u $/);
	assert.doesNotMatch(wide, /claude-fable|ctx|\$0\.000|5h|usage ·/, "shown once, in the rail header");
	const chrome = renderShellStatusBar(model, plain, 180, "alt+u", undefined, undefined, { rail: true });
	assert.ok(chrome.usageSpan && stripAnsi(chrome.rows[0]!).slice(chrome.usageSpan.start, chrome.usageSpan.end).startsWith("week"), "the weekly gauge stays the click target");
	const narrow = stripAnsi(renderShellStatusBar(model, plain, 56, "alt+u", undefined, undefined, { rail: true }).rows[0]!);
	assert.equal(visibleWidth(narrow), 56);
	assert.match(narrow, /feat\/shell-visual-snapshots|…/);
	assert.doesNotMatch(narrow, /claude-fable|ctx|\$0\.000/);
});

function fixture(columns: number) {
	const original = () => ({ type: "vstack", entries: [] });
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: original };
	const host = { mode: "fullscreen", terminal: { columns }, layoutRoot: root, requestRender() {} };
	return { host, tui: host as unknown as TUI, root };
}
type Node = { type: string; entries: Array<{ component: Component & { [NODE]?: () => Node } }> };
const click = (x: number, y: number, width = 50, height = 6): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });

test("the layout pins the rail header above the scrolling sections and forwards its clicks (S3)", () => {
	const f = fixture(180);
	const clicks: Array<[number, number]> = [];
	const header = buildShellHeaderModel(model);
	sidebarRailHeader(f.tui, {
		render: (width) => renderShellRailHeader(header, plain, width, "alt+u", undefined, "alt+k").rows,
		invalidate() {},
		handleMouse(event) { clicks.push([event.x, event.y]); return { handled: true }; },
	});
	sidebarPart(f.tui, "footer", { render: (_width: number) => ["Status"], invalidate() {} });
	const dispose = installSidebar(f.tui, plain);
	const top = f.root[NODE]() as Node;
	const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
	assert.equal(hstack.type, "hstack");
	const column = hstack.entries[1]!.component[NODE]!() as Node;
	assert.equal(column.type, "vstack");
	const pinned = column.entries[0]!.component;
	const lines = rows(pinned.render(50));
	assert.equal(lines[0]!.trim(), "claude-fable-5-1 · low");
	assert.equal(lines.length, 6);
	assert.ok(lines.every((line) => visibleWidth(line) === 50), "pinned rows fill the rail width");
	pinned.handleMouse!(click(3, 3));
	assert.deepEqual(clicks, [[3, 3]]);
	dispose();
});

test("the status bar part stays a full-width row below the rail at 180 columns (S3)", () => {
	const f = fixture(180);
	sidebarPart(f.tui, "footer", { render: (_width: number) => ["Status"], invalidate() {} });
	sidebarStatusBar(f.tui, { render: (width) => [renderShellStatusBar(model, plain, width, "alt+u", undefined, undefined, { rail: true }).rows[0]!], invalidate() {} });
	const dispose = installSidebar(f.tui, plain);
	const top = f.root[NODE]() as Node;
	const bar = top.entries[top.entries.length - 1]!.component;
	assert.match(stripAnsi(bar.render(180)[0]!), /week/);
	dispose();
});

// T3 (S4): the yellow Breaks card pinned under the rail header.

const at = Date.parse("2026-11-05T19:46:00Z");
async function breaksFixture(t: TestContext, columns: number) {
	const handlers = new Map<string, Function>();
	let factory: Function | undefined;
	const resets: string[] = [];
	// Every reminder is due, like the approved mockup (Ahora, Ahora, Ahora, Cena 16h 14m is dinner's own clock).
	const shared: WellnessState = { version: 1, reminders: Object.fromEntries(REMINDERS.map((key) => [key, { deadline: key === "dinner" ? at + (16 * 60 + 14) * 60000 : at - 1000, revision: key }])) as WellnessState["reminders"] };
	gentleWellness({ on(name: string, fn: Function) { handlers.set(name, fn); }, registerCommand() {} } as unknown as ExtensionAPI,
		{}, () => JSON.stringify({ enabled: true, notifications: false, language: "es", utcOffsetMinutes: -180 }), () => ({
			async loadOrInitialize() { return shared; }, async load() { return shared; },
			async reset(target: string) { resets.push(target); return shared; }, async claimDue() { return true; },
		}));
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: at });
	const ctx = { mode: "tui", hasUI: true, ui: { theme: plain, setWidget(_key: string, value: Function | undefined) { factory = value; }, notify() {} } };
	await handlers.get("session_start")!({}, ctx);
	const f = fixture(columns);
	const widget = factory!(f.tui, plain);
	t.after(() => handlers.get("session_shutdown")!());
	return { ...f, widget, resets };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

for (const columns of [180, 140]) {
	test(`Breaks is pinned under the rail header at ${columns} columns with its ↻ resets clickable (S4)`, async (t) => {
		const f = await breaksFixture(t, columns);
		const header = buildShellHeaderModel(model);
		sidebarRailHeader(f.tui, { render: (width) => renderShellRailHeader(header, plain, width, "alt+u", undefined, "alt+k").rows, invalidate() {} });
		sidebarPart(f.tui, "footer", { render: (_width: number) => ["Status"], invalidate() {} });
		const dispose = installSidebar(f.tui, plain);
		const top = f.root[NODE]() as Node;
		const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
		const pinned = (hstack.entries[1]!.component[NODE]!() as Node).entries[0]!.component;
		const lines = rows(pinned.render(50));
		assert.ok(lines.every((line) => visibleWidth(line) === 50));
		assert.equal(lines[5]!.trim().length, 50, "rose rule closes the header");
		assert.equal(lines[6]!.trim(), "", "one gap row");
		assert.match(lines[7]!, /^ ╭─ Breaks ─+╮ $/);
		assert.match(lines[8]!, /^ │ Agua +Ahora +↻ +\S.*│ $/);
		assert.match(lines[9]!, /^ │ Descanso +Ahora +↻ +\S.*│ $/);
		assert.match(lines[10]!, /^ │ Estirar +Ahora +↻ +\S.*│ $/);
		assert.match(lines[11]!, /^ │ Cena +16h 14m +.*jue, 05 nov 2026 +│ $/);
		assert.match(lines[12]!, /^ ╰─+╯ $/);
		assert.equal(lines.length, 13);
		const clickAt = (x: number, y: number) => pinned.handleMouse!({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 50, height: lines.length, shift: false, alt: false, ctrl: false });
		const glyph = (y: number) => visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf("↻")));
		assert.equal(clickAt(glyph(8), 8)?.handled, true);
		await flush();
		assert.equal(clickAt(glyph(9), 9)?.handled, true);
		await flush();
		assert.equal(clickAt(visibleWidth(lines[10]!.slice(0, lines[10]!.indexOf("Estirar"))), 10)?.handled, true, "the row label resets too");
		await flush();
		assert.deepEqual(f.resets, ["water", "break", "stretch"]);
		assert.equal(clickAt(glyph(8), 11), undefined, "Cena has no reset");
		assert.equal(clickAt(1, 3), undefined, "the header's own rows still route to the header part");
		assert.equal(f.widget.render(columns).length, 0, "the below-editor paint steps aside while the rail shows Breaks");
		dispose();
	});
}

test("the Breaks card keeps the warning frame while a reminder is due and the info frame otherwise (S4, S7)", () => {
	const roles = new Set<string>();
	const spy = { fg: (role: string, text: string) => { roles.add(role); return text; }, bold: (text: string) => text };
	const config = parseWellnessConfig({ enabled: true, language: "es", utcOffsetMinutes: -180 })!;
	const session = new WellnessSession(config, at);
	session.render(at + 31 * 60000, 48, spy, { resetGlyphs: true });
	assert.ok(roles.has("warning"), "a due reminder paints the yellow frame");
	roles.clear();
	session.render(at, 48, spy, { resetGlyphs: true });
	assert.ok(!roles.has("warning"), "nothing due: no warning role");
	for (const role of roles) assert.match(role, /^(info|border|accent|muted|dim|text|borderAccent)$/, role);
});
