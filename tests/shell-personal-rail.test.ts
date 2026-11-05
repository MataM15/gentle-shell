import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { buildShellHeaderModel, renderShellRailHeader, renderShellStatusBar, shellHeaderCommandsHit, shellHeaderUsageHit, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarRailHeader, sidebarStatusBar } from "../lib/shell-sidebar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

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
