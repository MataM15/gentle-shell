import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { renderPanelHeader, renderPanelRow, withPanelFrame } from "../lib/shell-panel.ts";
import { renderShellStatusSections, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";
import { renderTodoSection, type TodoState } from "../lib/shell-todo.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// T4 (odd/tasks/shell-personal-rework.md S5, S7): the rail's sections as neon
// rounded cards, `▾ TITLE` and the count inset in the top border, and the last
// rail row `» hide panel · alt+h`.

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text };
const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const todos: TodoState = {
	tasks: [
		{ id: 1, title: "Rebuild the chain", status: "done" }, { id: 2, title: "Create the issue", status: "done" },
		{ id: 3, title: "Run focused, typecheck, package check and the whole suite", status: "in_progress", note: "job-1" },
		{ id: 4, title: "Push tracker + 13 slice branches and open the pull requests", status: "pending" },
		{ id: 5, title: "Record slice boundaries and PR numbers", status: "pending" },
		{ id: 6, title: "Remove the temporary worktrees and scratch", status: "pending" },
	],
	nextId: 7, updatedTurn: 0,
};
const status: ShellBarModel = {
	cwd: "~/work/gentle-pi-review-2750", branch: "feat/shell-visual-snapshots", dirty: undefined, sessionName: undefined, profile: "claude (session)",
	modelId: "claude-fable-5-1", effort: "low", contextPercent: 17, contextWindow: 1000, costTotal: 0, subscription: false, usage: undefined,
	permission: { mode: "SUPER-YOLO", detail: "no permission prompts; private paths stay blocked" },
	statuses: ["🧠 gentle-pi · ready"], integrations: ["🧠 gentle-pi · ready"],
};
const visibility = { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false };

function fixture(columns: number) {
	const original = () => ({ type: "vstack", entries: [] });
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: original };
	const host = { mode: "fullscreen", terminal: { columns }, layoutRoot: root, requestRender() {} };
	return { host, tui: host as unknown as TUI, root };
}
type Node = { type: string; entries: Array<{ component: Component & { [NODE]?: () => Node } }> };
function railScroll(f: ReturnType<typeof fixture>): { scroll: ScrollView; hasColumn: boolean } {
	const top = f.root[NODE]() as Node;
	const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
	const entry = hstack.entries[1]!.component;
	if (entry instanceof ScrollView) return { scroll: entry, hasColumn: false };
	const column = entry[NODE]!() as Node;
	return { scroll: column.entries.map((candidate) => candidate.component).find((candidate) => candidate instanceof ScrollView) as ScrollView, hasColumn: true };
}
const clicks: Array<{ key: string; x: number; y: number; width: number }> = [];
function install(columns: number, style: CardStyle = CARD_STYLE.NEON, control?: Parameters<typeof installSidebar>[5]) {
	setCardStyle(style);
	const f = fixture(columns);
	const part = (key: string, render: (width: number) => string[]) => sidebarPart(f.tui, key, { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => key, render, invalidate() {},
		handleMouse(event) { clicks.push({ key, x: event.x, y: event.y, width: event.width }); return { handled: true }; },
	} as never);
	part("todo", (width) => { const section = renderTodoSection(todos, plain, width, { collapsed: false, staleTurns: 0 }); return [section.header, ...section.body]; });
	part("jobs", (width) => [renderPanelHeader(plain, width, { title: "Jobs", count: "1 running", open: true }), renderPanelRow(width, "● job-1 pnpm test", "2m03s")]);
	part("agents", (width) => [renderPanelHeader(plain, width, { title: "Agents", count: "idle", open: true }), renderPanelRow(width, "none running · /gentle:agents history")]);
	part("footer", (width) => renderShellStatusSections(status, plain, width, { density: "minimal", visibility }, undefined).lines);
	const dispose = installSidebar(f.tui, plain, () => "auto", () => "top", () => "minimal", control);
	return { ...f, dispose };
}
const screen = (f: ReturnType<typeof fixture>, columns: number, rows = 60) => renderLayoutFrame(f.root, columns, rows, () => {}).lines.map(stripAnsi);
const railOf = (lines: string[], columns: number) => lines.map((line) => line.slice(columns - 50).trimEnd());

test("a framed panel header insets the title and count in a rounded top border (S5)", () => {
	const header = withPanelFrame(() => renderPanelHeader(plain, 43, { title: "Todos", count: "2/6", open: true }));
	assert.equal(visibleWidth(header), 47);
	assert.match(header, /^╭─ ▾ TODOS ─+ 2\/6 ─╮$/);
	assert.match(withPanelFrame(() => renderPanelHeader(plain, 43, { title: "Todos", count: "2/6", open: false })), /^╭─ ▸ TODOS /);
	assert.match(withPanelFrame(() => renderPanelHeader(plain, 43, { title: "Review", open: true })), /^╭─ ▾ REVIEW ─+╮$/, "no count: the rule runs to the corner");
	assert.equal(visibleWidth(withPanelFrame(() => renderPanelHeader(plain, 12, { title: "Integrations", count: "2", open: true }))), 16, "a long title clips instead of overflowing");
	assert.equal(renderPanelRow(30, "x").length, 30, "outside the frame rows keep their two-column indent");
	assert.match(renderPanelRow(30, "x"), /^ {2}x/);
	assert.match(withPanelFrame(() => renderPanelRow(30, "x")), /^x/, "inside a card the frame is the indent");
});

test("a framed panel paints only theme roles (S7)", () => {
	const roles = new Set<string>();
	const spy = { fg: (role: string, text: string) => { roles.add(role); return text; }, bold: (text: string) => text };
	withPanelFrame(() => renderPanelHeader(spy, 43, { title: "Todos", count: "2/6", open: true, hovered: true }));
	for (const role of roles) assert.match(role, /^(accent|border|borderAccent|muted|dim|text|success|warning|error)$/, role);
});

for (const columns of [180, 140]) {
	test(`neon rail at ${columns} columns draws TODOS, JOBS, AGENTS, CHANGES, INTEGRATIONS as rounded cards with a gap between (S5)`, (t) => {
		const found = cardStyle();
		t.after(() => setCardStyle(found));
		const f = install(columns);
		t.after(f.dispose);
		const lines = railOf(screen(f, columns), columns);
		const tops = lines.map((line, y) => [line, y] as const).filter(([line]) => /^ ?╭─ /.test(line));
		const titles = tops.map(([line]) => /▾ (\S+)/.exec(line)?.[1]);
		assert.deepEqual(titles, ["TODOS", "JOBS", "AGENTS", "CHANGES", "INTEGRATIONS"], "upstream's order, every section its own card");
		for (const [, y] of tops) {
			assert.equal(lines[y - 1]?.trim() ?? "", "", `a gap row above the card at ${y}`);
			assert.equal(visibleWidth(lines[y]!.trimEnd()), 49, "one pad column plus a 48-column card: the rail minus its inset");
		}
		const text = lines.join("\n");
		assert.match(text, /╭─ ▾ TODOS ─+ 2\/6 ─╮/);
		assert.match(text, /╭─ ▾ JOBS ─+ 1 running ─╮/);
		assert.match(text, /│ ✓ 2 done +│/);
		assert.match(text, /│ ● job-1 pnpm test +2m03s │/);
		assert.equal((text.match(/╰─+╯/g) ?? []).length, 5, "every card closes");
		assert.doesNotMatch(text, /Activity|Sessions|Resources/, "no tab row");
		for (const line of lines) assert.ok(visibleWidth(line) <= 50, line);
	});
}

test("float style keeps upstream's flat panel sections, no cards (S5)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(180, CARD_STYLE.FLOAT);
	t.after(f.dispose);
	const text = railOf(screen(f, 180), 180).join("\n");
	assert.match(text, /▾ TODOS +2\/6/);
	assert.doesNotMatch(text, /╭─ ▾/);
});

test("clicks inside a card reach the section in the section's own rows, the border and gaps stay inert (S5)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const f = install(180);
	t.after(f.dispose);
	const rail = railOf(screen(f, 180), 180);
	const { scroll } = railScroll(f);
	// No pinned rows in this fixture: the scroll box starts on screen row 0, so a screen row is a content row.
	const click = (y: number, x = 5): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x + 127, screenY: y, width: 50, height: 60, shift: false, alt: false, ctrl: false });
	const top = (title: string) => rail.findIndex((line) => line.includes(`▾ ${title}`));
	const todo = top("TODOS");
	clicks.length = 0;
	assert.equal(scroll.handleMouse(click(todo))?.handled, true);
	assert.equal(scroll.handleMouse(click(todo + 1))?.handled, true);
	assert.deepEqual(clicks.map(({ key, y, width }) => [key, y, width]), [["todo", 0, 44], ["todo", 1, 44]], "header row 0 is the collapse control, body rows keep their index");
	const bottomBorder = rail.findIndex((line, y) => y > todo && /^ ?╰─+╯/.test(line));
	clicks.length = 0;
	scroll.handleMouse(click(bottomBorder));
	scroll.handleMouse(click(bottomBorder + 1));
	assert.deepEqual(clicks, [], "the bottom border and the gap row are inert");
	// A multi-section part (Status) hit-tests by the rows of its own render.
	const sections = renderShellStatusSections(status, plain, 44, { density: "minimal", visibility }, undefined);
	for (const target of sections.targets) {
		if (target.kind !== "toggle") continue;
		const title = target.section === "integrations" ? "INTEGRATIONS" : target.section.toUpperCase();
		const y = top(title);
		if (y < 0) continue;
		clicks.length = 0;
		scroll.handleMouse(click(y));
		assert.deepEqual(clicks.map(({ key, y: row }) => [key, row]), [["footer", target.row]], `${title} header maps to its row in the Status render`);
	}
});

test("the last rail row is `» hide panel · alt+h`, clickable, with the editor's alt+h behind it (S5)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	let collapsed = false;
	let toggles = 0;
	const f = install(180, CARD_STYLE.NEON, { collapsed: () => collapsed, toggle: () => { toggles++; collapsed = !collapsed; }, hint: () => "alt+h" });
	t.after(f.dispose);
	const lines = screen(f, 180);
	const hideRow = lines.findIndex((line) => line.includes("» hide panel"));
	assert.ok(hideRow >= 0, "the row is painted");
	assert.match(lines[hideRow]!.slice(130).trimEnd(), /^ ?» hide panel · alt\+h$/);
	const top = f.root[NODE]() as Node;
	const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
	const column = hstack.entries[1]!.component[NODE]!() as Node;
	const bottom = column.entries[column.entries.length - 1]!.component;
	assert.match(stripAnsi(bottom.render(50)[0]!).trimEnd(), /^ ?» hide panel · alt\+h$/);
	const event = (x: number): TuiMouseEvent => ({ type: "click", button: "left", x, y: 0, screenX: x, screenY: 0, width: 50, height: 1, shift: false, alt: false, ctrl: false });
	assert.equal(bottom.handleMouse!(event(40)), undefined, "empty space on the row is inert");
	assert.equal(bottom.handleMouse!(event(3))?.handled, true);
	assert.equal(toggles, 1);
});

test("a folded rail returns the native layout and the editor can offer `« panel` (S5)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	let collapsed = false;
	const f = install(180, CARD_STYLE.NEON, { collapsed: () => collapsed, toggle: () => { collapsed = !collapsed; }, hint: () => "alt+h" });
	t.after(f.dispose);
	f.root[NODE]();
	const state = sidebarState(f.tui);
	assert.equal(state.ownsHost?.(), true);
	assert.equal(state.railAvailable?.(), false);
	collapsed = true;
	assert.equal(state.ownsHost?.(), false);
	assert.equal(state.railAvailable?.(), true, "the rail could show again");
	assert.notEqual((f.root[NODE]() as Node).type, "hstack");
});
