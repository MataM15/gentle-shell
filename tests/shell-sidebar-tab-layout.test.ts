import assert from "node:assert/strict";
import test from "node:test";
import { renderLayoutFrame, type LayoutBox } from "@earendil-works/pi-tui/dist/layout.js";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart } from "../lib/shell-sidebar.ts";
import { SIDEBAR_TABS } from "../lib/shell-sidebar-tabs.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// S1: the tab row is the rail's only navigation, so the active tab carries a
// real indicator (bold accent label plus an underline on the next row) over a
// faint full-width rule, while the inactive labels dim. The clickable ranges
// stay exactly the published SIDEBAR_TABS geometry.

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
// Real SGR codes: the layout measures painted lines, so a tagged theme would
// inflate every width and deactivate the rail.
const CODES: Record<string, string> = { accent: "91", dim: "90", bold: "1" };
const paint = (role: string, text: string) => `\x1b[${CODES[role]}m${text}\x1b[0m`;
const bold = (text: string) => paint("bold", text);
const theme = { fg: (role: string, text: string) => paint(role, text), bold };
const RULE = "─";

function fixture() {
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	sidebarHeader(tui, { render: () => ["MODEL"], invalidate() {} });
	sidebarPart(tui, "footer", { render: () => ["STATUS CARD"], invalidate() {} });
	const dispose = installSidebar(tui, theme, () => "auto", () => "top", undefined, undefined, { tabs: true });
	const box = () => renderLayoutFrame(root, 160, 24, () => {});
	const find = (node: LayoutBox): Component | undefined =>
		node.children.length === 0 && node.component.render(node.rect.width).some((line) => line.includes("Activity") && line.includes("Resources"))
			? node.component
			: node.children.map(find).find(Boolean);
	const pinned = () => find(box().root)!;
	const rows = () => pinned().render(50);
	const tabRow = () => rows().findIndex((line) => line.includes("Activity") && line.includes("Resources"));
	return { root, host, box, pinned, rows, tabRow, dispose };
}

function click(pinned: Component, label: string, y: number): TuiMouseEvent {
	const tab = SIDEBAR_TABS.find((entry) => entry.label === label)!;
	const x = tab.start + 1;
	return { type: "click", button: "left", x, y, width: 50, height: 20, screenX: 110 + x, screenY: y, shift: false, alt: false, ctrl: false } as TuiMouseEvent;
}

test("the active tab reads bold accent and every inactive label dims", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const row = f.rows()[f.tabRow()]!;
	assert.ok(row.includes(paint("accent", bold(" Activity "))), "the default Activity tab is the active one");
	assert.ok(row.includes(paint("dim", " Sessions ")));
	assert.ok(row.includes(paint("dim", " Resources ")));
	assert.ok(row.includes(paint("dim", " Status ")));
	assert.equal(stripAnsi(row), " Activity   Sessions   Resources   Status ", "labels keep their published click columns");
});

test("the row under the tabs is a faint full-width rule with an accent underline spanning the active label", (t) => {
	const f = fixture();
	t.after(f.dispose);
	assert.equal(f.rows()[f.tabRow() + 1], paint("dim", RULE.repeat(1)) + paint("accent", RULE.repeat(8)) + paint("dim", RULE.repeat(41)), "Activity: the label occupies columns 1-8 and the rule fills the rest");
	const pinned = f.pinned();
	assert.equal(pinned.handleMouse?.(click(pinned, "Sessions", f.tabRow()))?.handled, true);
	assert.equal(f.rows()[f.tabRow() + 1], paint("dim", RULE.repeat(12)) + paint("accent", RULE.repeat(8)) + paint("dim", RULE.repeat(30)), "Sessions: 12 columns before it, 8 under the label, 30 after");
});

// Preserving: the published tab columns still switch the section they own.
test("a tab click still selects its own section", (t) => {
	const f = fixture();
	t.after(f.dispose);
	const pinned = f.pinned();
	assert.match(stripAnsi(f.box().lines.join("\n")), /No activity/);
	assert.equal(pinned.handleMouse?.(click(pinned, "Sessions", f.tabRow()))?.handled, true);
	assert.match(stripAnsi(f.box().lines.join("\n")), /Sessions unavailable/);
});
