import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { chromeSurface, renderPanelHeader, renderPanelRow, renderStaticPanelHeader, setChromeSurface } from "../lib/shell-panel.ts";
import { renderShellStatusSections, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { SIDEBAR_TABS, sidebarTabSections } from "../lib/shell-sidebar-tabs.ts";
import { sidebarHeader, sidebarPart, sidebarRailHeader } from "../lib/shell-sidebar.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// T7 (odd/tasks/shell-personal-rework.md S13, S9, S12): the rail tabs are back,
// styled as in d6fb874a5, below the pinned header and Breaks.

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text };
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const status: ShellBarModel = {
	cwd: "~/work/gentle-pi-review-2750", branch: "feat/shell-visual-snapshots", dirty: undefined, sessionName: undefined, profile: "claude (session)",
	modelId: "claude-fable-5-1", effort: "low", contextPercent: 17, contextWindow: 1000, costTotal: 0, subscription: false, usage: undefined,
	permission: { mode: "SUPER-YOLO" }, statuses: ["🧠 gentle-pi · ready"], integrations: ["🧠 gentle-pi · ready"],
};
const visibility = { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false };
type Node = { type: string; entries: Array<{ component: Component & { [NODE]?: () => Node } }> };
const click = (x: number, y: number, width = 50, height = 12): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false });

function install(columns: number, onTabSelect?: (tab: string) => void, voice?: () => string[], theme: typeof plain & { bg?(role: string, text: string): string } = plain) {
	setCardStyle(CARD_STYLE.NEON);
	// The default surface: the layout draws each panel section as a transparent card (S17).
	const surfaceBefore = chromeSurface();
	setChromeSurface("transparent");
	const original = () => ({ type: "vstack", entries: [] });
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: original };
	const host = { mode: "fullscreen", terminal: { columns }, layoutRoot: root, requestRender() {} };
	const tui = host as unknown as TUI;
	const clicks: string[] = [];
	// Every section, Otras sesiones and Limits included, is a panel section the layout frames.
	const part = (key: string, render: (width: number) => string[]) => sidebarPart(tui, key, { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => key, render, invalidate() {},
		handleMouse(event) { clicks.push(`${key}@${event.y}`); return { handled: true }; },
	} as never);
	const card = (title: string, count: string, ...rows: string[]) => (width: number) => [renderPanelHeader(plain, width, { title, count, open: true }), ...rows.map((row) => renderPanelRow(width, row))];
	// A registered title row, so the fallback banner never joins the rail.
	sidebarHeader(tui, { render: () => [" title"], invalidate() {} });
	sidebarRailHeader(tui, { render: () => ["claude-fable-5-1 · low", "━".repeat(50)], invalidate() {} });
	sidebarPart(tui, "wellness", { render: () => ["Breaks"], invalidate() {} });
	if (voice) sidebarPart(tui, "voice", { render: () => [], invalidate() {} }, { digest: () => voice().join("|"), render: voice, invalidate() {} });
	part("todo", card("Todos", "2/6", "✓ 2 done"));
	part("jobs", card("Jobs", "1 running", "● job-1 pnpm test"));
	part("agents", card("Agents", "idle", "none running"));
	part("sessions", (width) => [renderStaticPanelHeader(plain, width, "Otras sesiones"), ...["● erasure-1570n5", "  hace 1 h · 1 agente"].map((row) => renderPanelRow(width, row))]);
	part("usage", (width) => [renderStaticPanelHeader(plain, width, "Limits"), renderPanelRow(width, "claude · max")]);
	const footerGroups = new Map<number, { groups: Array<{ start: number; end: number }>; loose: number[] }>();
	sidebarPart(tui, "footer", { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => "footer", invalidate() {},
		render: (width: number) => { const view = renderShellStatusSections(status, plain, width, { density: "minimal", visibility }, undefined); footerGroups.set(width, { groups: view.groups, loose: view.loose }); return view.lines; },
		cardGroups: (width: number) => footerGroups.get(width),
		handleMouse(event) { clicks.push(`footer@${event.y}`); return { handled: true }; },
	} as never);
	const uninstall = installSidebar(tui, theme, () => "auto", () => "top", () => "minimal", undefined, { tabs: true, onTabSelect });
	const dispose = () => { uninstall(); setChromeSurface(surfaceBefore); };
	const column = () => {
		const top = root[NODE]() as Node;
		const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
		return hstack.entries[1]!.component[NODE]!() as Node;
	};
	const screen = () => renderLayoutFrame(root, columns, 50, () => {}).lines.map((line) => stripAnsi(line).slice(columns - 50).trimEnd());
	const pinned = () => column().entries[0]!.component;
	return { tui, root, clicks, dispose, column, screen, pinned };
}
const titles = (lines: string[]) => lines.flatMap((line) => /^ ?╭─ (?:[▾▸] )?(.+?) ─/.exec(line)?.[1] ?? []);

test("the tab sections follow what each tab held in d6fb874a5", () => {
	assert.deepEqual(SIDEBAR_TABS.map((tab) => tab.label), ["Activity", "Sessions", "Resources", "Status"]);
	assert.deepEqual(sidebarTabSections("activity"), ["agents", "jobs", "todo"]);
	assert.deepEqual(sidebarTabSections("sessions"), ["sessions"]);
	assert.deepEqual(sidebarTabSections("resources"), ["usage"]);
	assert.deepEqual(sidebarTabSections("status"), ["footer"]);
});

test("at 180 columns the tab row sits under the header and Breaks, with the active tab underlined (S13)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(180);
	t.after(f.dispose);
	const lines = f.screen();
	const tabRow = lines.findIndex((line) => /Activity.*Sessions.*Resources.*Status/.test(line));
	assert.ok(tabRow > lines.findIndex((line) => line.includes("Breaks")), "below Breaks");
	assert.ok(tabRow > lines.findIndex((line) => line.includes("claude-fable-5-1")), "below the rail header");
	assert.match(lines[tabRow + 1]!, /^─+$/, "the rule under the tabs");
	assert.deepEqual(titles(lines), ["Agents · idle", "Jobs · 1 running", "Todos · 2/6"], "Activity holds Agents, Jobs, Todos as neon cards titled in the owner's mixed case with their detail");
	assert.doesNotMatch(lines.join("\n"), /Otras sesiones|Limits|Changes/i);
	for (const line of lines) assert.ok(visibleWidth(line) <= 50, line);
});

test("the pinned rows keep the rail width and the labels sit on the published click columns", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(180);
	t.after(f.dispose);
	f.screen();
	const rows = f.pinned().render(50).map(stripAnsi);
	assert.ok(rows.every((row) => visibleWidth(row) === 50));
	const tabRow = rows.findIndex((row) => row.includes("Resources"));
	assert.equal(rows[tabRow]!.indexOf("Activity"), 1);
	assert.equal(rows[tabRow]!.indexOf("Sessions"), 12);
});

test("a click on a tab switches the section set, notifies, and the choice survives repaints (S13)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const selected: string[] = [];
	const f = install(180, (tab) => selected.push(tab));
	t.after(f.dispose);
	let lines = f.screen();
	const tabY = f.pinned().render(50).findIndex((row) => stripAnsi(row).includes("Resources"));
	const pin = (x: number) => f.pinned().handleMouse!(click(x, tabY));
	assert.deepEqual(pin(15), { handled: true, render: true });
	lines = f.screen();
	assert.deepEqual(titles(lines), ["Otras sesiones"], "Sessions tab: Otras sesiones (S9)");
	assert.deepEqual(selected, ["sessions"]);
	f.screen();
	assert.deepEqual(titles(f.screen()), ["Otras sesiones"], "the choice persists across frames");
	pin(26);
	assert.deepEqual(titles(f.screen()), ["Limits"]);
	pin(38);
	assert.deepEqual(titles(f.screen()), ["Changes · clean", "Integrations · 1"], "Status holds upstream's status sections");
	pin(3);
	assert.deepEqual(titles(f.screen()), ["Agents · idle", "Jobs · 1 running", "Todos · 2/6"]);
	assert.deepEqual(selected, ["sessions", "resources", "status", "activity"]);
	assert.equal(f.pinned().handleMouse!({ ...click(15, tabY), button: "right" }), undefined, "only the left button switches");
	assert.equal(f.pinned().handleMouse!(click(15, tabY - 1)), undefined, "the Breaks row is not a tab");
});

test("a card keeps its own clicks inside the tab (collapse hits the section, not the tab row)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(180);
	t.after(f.dispose);
	f.screen();
	const scroll = f.column().entries.map((entry) => entry.component).find((candidate) => candidate instanceof ScrollView) as ScrollView;
	const lines = f.screen();
	const header = lines.findIndex((line) => /╭─ ▾ Agents/.test(line));
	const top = f.pinned().render(50).length;
	const result = scroll.handleMouse!(click(5, header - 1 - top, 50, 40));
	assert.ok(result?.handled);
	assert.deepEqual(f.clicks, ["agents@0"]);
});

test("below 140 columns there is no rail and so no tab row (S6)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(56);
	t.after(f.dispose);
	assert.doesNotMatch(f.screen().join("\n"), /Activity|Resources/);
});

test("the voice line is pinned under the tabs while recording and gone when idle, on every tab (S10)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	let state: string[] = [];
	const f = install(180, undefined, () => state);
	t.after(f.dispose);
	const pinnedText = () => { f.screen(); return f.pinned().render(50).map(stripAnsi); };
	assert.ok(!pinnedText().some((row) => row.includes("listening")));
	state = [" ● listening "];
	let rows = pinnedText();
	const tabRow = rows.findIndex((row) => row.includes("Resources"));
	assert.match(rows[tabRow + 1]!, /^─+$/);
	assert.match(rows[tabRow + 2]!, /^ +● listening +$/, "the line sits right under the tab rule");
	assert.ok(rows.every((row) => visibleWidth(row) === 50));
	f.pinned().handleMouse!(click(26, tabRow));
	assert.ok(pinnedText().some((row) => row.includes("listening")), "still shown on the Resources tab");
	state = [];
	assert.ok(!pinnedText().some((row) => row.includes("listening")), "idle hides it");
});

test("the rail is one surface on every tab: tinted paints every row, transparent paints none so the terminal background shows through (S12, S17 row 1)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const tinted = { ...plain, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	const f = install(180, undefined, undefined, tinted);
	t.after(f.dispose);
	f.screen();
	const tabY = f.pinned().render(50).findIndex((row) => stripAnsi(row).includes("Resources"));
	for (const surface of ["tinted", "transparent"] as const) {
		setChromeSurface(surface);
		for (const x of [15, 26, 38, 3]) {
			f.pinned().handleMouse!(click(x, tabY));
			const raw = renderLayoutFrame(f.root as never, 180, 50, () => {}).lines;
			// The full-width title row on top is not part of the rail.
			const rail = raw.map((line, row) => ({ line, row })).filter(({ row }) => row > 0);
			if (surface === "tinted") {
				// Every row of the rail column (pinned header, sections, gaps, the fill below the last one) carries the tint.
				assert.deepEqual(rail.filter(({ line }) => !line.includes("\x1b[44m")).map(({ row }) => row), [], `tinted, tab at x=${x}`);
			} else {
				assert.deepEqual(rail.filter(({ line }) => line.includes("\x1b[44m")).map(({ row }) => row), [], `transparent, tab at x=${x}: no row paints a background`);
			}
		}
	}
});
