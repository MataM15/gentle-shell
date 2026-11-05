import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { CARD_STYLE, cardStyle, setCardStyle, type CardStyle } from "../lib/shell-card.ts";
import { chromeSurface, railTitleCase, renderPanelHeader, renderPanelRow, renderStaticPanelHeader, setChromeSurface } from "../lib/shell-panel.ts";
import { renderShellStatusSections, type ShellBarModel } from "../lib/shell-bar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { renderUsageCard, type ProviderUsage } from "../lib/shell-usage.ts";
import { sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";
import { renderTodoSection, type TodoState } from "../lib/shell-todo.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// T4 and T10 (odd/tasks/shell-personal-rework.md S5, S7, S17): the rail's
// sections as the transparent surface's conversation cards in the owner's
// style (mixed-case amber title, detail after a dot, `▾` folds), and the last
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

// Real SGR, one color per role, so widths measure as a terminal draws them and a hard-coded color shows up.
const ROLE_COLOR: Record<string, number> = { borderAccent: 214, muted: 245, text: 255, accent: 211, border: 167, dim: 240, warning: 220 };
const tagged = { fg: (role: string, text: string) => `\x1b[38;5;${ROLE_COLOR[role] ?? 250}m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m`, strikethrough: (text: string) => text };
const amberBold = (title: string) => new RegExp(`\\x1b\\[38;5;${ROLE_COLOR.borderAccent}m\\x1b\\[1m${title}\\x1b\\[22m\\x1b\\[39m`);
function useSurface(t: { after(fn: () => void): void }, value: "transparent" | "tinted") {
	const found = chromeSurface();
	setChromeSurface(value);
	t.after(() => setChromeSurface(found));
}

test("rail titles keep the owner's mixed case: first letter up, the rest down, escape codes intact", () => {
	assert.equal(railTitleCase("AGENTS"), "Agents");
	assert.equal(railTitleCase("OTRAS SESIONES"), "Otras sesiones");
	assert.equal(railTitleCase("\x1b[33mLIMITS\x1b[39m"), "\x1b[33mLimits\x1b[39m");
});

test("a transparent rail draws each section as a neon card titled in mixed case with its detail after a dot (S17 row 2)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	const f = install(180);
	t.after(f.dispose);
	const text = railOf(screen(f, 180), 180).join("\n");
	assert.match(text, /╭─ ▾ Agents · idle ─+╮/);
	assert.match(text, /╭─ ▾ Todos · 2\/6 ─+╮/);
	assert.match(text, /╭─ ▾ Jobs · 1 running ─+╮/);
	assert.doesNotMatch(text, /AGENTS|TODOS|JOBS/, "no upper-case titles");
	assert.match(text, /│ none running · \/gentle:agents history +│/, "the rows sit inside the frame");
});

test("the card title is amber bold, with the detail muted, and the frame stays on theme roles (S7)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	setCardStyle(CARD_STYLE.NEON);
	const f = fixture(180);
	sidebarPart(f.tui, "agents", { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => "agents", invalidate() {},
		render: (width: number) => [renderPanelHeader(tagged, width, { title: "Agents", count: "1 running", open: true }), renderPanelRow(width, "● sdd-explore")],
	} as never);
	t.after(installSidebar(f.tui, tagged, () => "auto", () => "top", () => "minimal"));
	const row = renderLayoutFrame(f.root, 180, 20, () => {}).lines.find((line) => stripAnsi(line).includes("Agents"))!;
	assert.match(row, amberBold("Agents"), "amber (borderAccent), bold");
	assert.match(row, new RegExp(`\\x1b\\[38;5;${ROLE_COLOR.muted}m·\\x1b\\[39m \\x1b\\[38;5;${ROLE_COLOR.muted}m1 running\\x1b\\[39m`), "the detail is muted");
	for (const [, color] of row.matchAll(/\x1b\[38;5;(\d+)m/g)) assert.ok(Object.values(ROLE_COLOR).includes(Number(color)), `color ${color} comes from a theme role`);
});

test("Otras sesiones and Limits draw the same card title as every other section (S17 row 2)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	setCardStyle(CARD_STYLE.NEON);
	const f = fixture(180);
	for (const [key, title] of [["sessions", "Otras sesiones"], ["usage", "Limits"]] as const) {
		sidebarPart(f.tui, key, { render: () => [], invalidate() {} }, {
			surface: "panel", digest: () => key, invalidate() {},
			render: (width: number) => [renderStaticPanelHeader(tagged, width, title), renderPanelRow(width, `${title} row`)],
		} as never);
	}
	t.after(installSidebar(f.tui, tagged, () => "auto", () => "top", () => "minimal", undefined, { tabs: true }));
	const rows = (tab: string) => {
		const column = (() => {
			const top = f.root[NODE]() as Node;
			const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
			return hstack.entries[1]!.component[NODE]!() as Node;
		})();
		const pinned = column.entries[0]!.component;
		const labels = stripAnsi(pinned.render(50).join("\n"));
		const y = pinned.render(50).findIndex((row) => stripAnsi(row).includes("Activity"));
		const x = stripAnsi(pinned.render(50)[y]!).indexOf(tab);
		assert.ok(labels.includes(tab) && x >= 0);
		pinned.handleMouse!({ type: "click", button: "left", x: x + 1, y, screenX: x + 1, screenY: y, width: 50, height: 4, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
		return renderLayoutFrame(f.root, 180, 40, () => {}).lines;
	};
	const sessions = rows("Sessions").map(stripAnsi).join("\n");
	assert.match(sessions, /╭─ Otras sesiones ─+╮/);
	const resources = rows("Resources");
	assert.match(resources.map(stripAnsi).join("\n"), /╭─ Limits ─+╮/);
	assert.match(resources.find((line) => stripAnsi(line).includes("Limits"))!, amberBold("Limits"), "amber like the others");
});

test("a transparent rail paints no background, a tinted one paints the panel rows (S17 row 1)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	const painted = { ...plain, bg: (_role: string, text: string) => `\x1b[48;5;22m${text}\x1b[49m` };
	const build = (surface: "transparent" | "tinted") => {
		setChromeSurface(surface);
		setCardStyle(CARD_STYLE.NEON);
		const f = fixture(180);
		sidebarPart(f.tui, "agents", { render: () => [], invalidate() {} }, {
			surface: "panel", digest: () => "agents", invalidate() {},
			render: (width: number) => [renderPanelHeader(plain, width, { title: "Agents", count: "idle", open: true }), renderPanelRow(width, "none running")],
		} as never);
		const dispose = installSidebar(f.tui, painted, () => "auto", () => "top", () => "minimal");
		const lines = renderLayoutFrame(f.root, 180, 20, () => {}).lines;
		dispose();
		return lines.map((line) => line.slice(0, line.length));
	};
	const before = chromeSurface();
	t.after(() => setChromeSurface(before));
	assert.ok(!build("transparent").some((line) => line.includes("\x1b[48;5;22m")), "the terminal background shows through every rail row");
	assert.ok(build("tinted").some((line) => line.includes("\x1b[48;5;22m")), "tinted keeps upstream's panel surface");
});

test("a transparent card's title row and body rows reach the section in the section's own rows, the border and gaps stay inert (S17 row 3)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	const f = install(180);
	t.after(f.dispose);
	const rail = railOf(screen(f, 180), 180);
	const { scroll } = railScroll(f);
	// No pinned rows in this fixture: the scroll box starts on screen row 0, so a screen row is a content row.
	const click = (y: number, x = 5): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x + 127, screenY: y, width: 50, height: 60, shift: false, alt: false, ctrl: false });
	const top = (title: string) => rail.findIndex((line) => line.includes(`▾ ${title}`));
	const todo = top("Todos");
	clicks.length = 0;
	assert.equal(scroll.handleMouse(click(todo))?.handled, true);
	assert.equal(scroll.handleMouse(click(todo + 1))?.handled, true);
	assert.deepEqual(clicks.map(({ key, y }) => [key, y]), [["todo", 0], ["todo", 1]], "the title row is the collapse control, body rows keep their index");
	const bottomBorder = rail.findIndex((line, y) => y > todo && /^ ?╰─+╯/.test(line));
	clicks.length = 0;
	scroll.handleMouse(click(bottomBorder));
	scroll.handleMouse(click(bottomBorder + 1));
	assert.deepEqual(clicks, [], "the bottom border and the gap row are inert");
	// A multi-section part (Status) hit-tests by the rows of its own render.
	const sections = renderShellStatusSections(status, plain, 44, { density: "minimal", visibility }, undefined);
	for (const target of sections.targets) {
		if (target.kind !== "toggle") continue;
		const title = target.section === "integrations" ? "Integrations" : target.section[0]!.toUpperCase() + target.section.slice(1);
		const y = top(title);
		if (y < 0) continue;
		clicks.length = 0;
		scroll.handleMouse(click(y));
		assert.deepEqual(clicks.map(({ key, y: row }) => [key, row]), [["footer", target.row]], `${title} title maps to its row in the Status render`);
	}
});

test("float style draws the same mixed-case cards on a transparent rail (S17 row 2)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	const f = install(180, CARD_STYLE.FLOAT);
	t.after(f.dispose);
	const text = railOf(screen(f, 180), 180).join("\n");
	assert.match(text, /▾ Todos · 2\/6/);
	assert.doesNotMatch(text, /TODOS/);
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


test("cards sit one blank, unpainted row apart at the owner's minimal density (S12)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	const f = install(180);
	t.after(f.dispose);
	const rail = railOf(screen(f, 180), 180);
	const bottom = rail.findIndex((line) => /^ ?╰─+╯/.test(line));
	assert.equal(rail[bottom + 1], "", "a blank row after the first card");
	assert.match(rail[bottom + 2]!, /^ ?╭─ ▾ /, "then the next card");
});

test("the Todos collapse key rides the card's top rule, the count stays beside the title (S17 row 3)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	setCardStyle(CARD_STYLE.NEON);
	const f = fixture(180);
	sidebarPart(f.tui, "todo", { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => "todo", invalidate() {},
		render: (width: number) => { const section = renderTodoSection(todos, plain, width, { collapsed: false, staleTurns: 0, collapseKey: "ctrl+shift+t" }); return [section.header, ...section.body]; },
	} as never);
	t.after(installSidebar(f.tui, plain, () => "auto", () => "top", () => "minimal"));
	const text = railOf(screen(f, 180), 180);
	assert.match(text.find((row) => row.includes("Todos"))!, /^╭─ ▾ Todos · 2\/6 ─+ ctrl\+shift\+t ╮$/);
});

test("the real Limits section in panel mode fills its card: every row closes on the frame, none is cut with an ellipsis (S14, S17 row 2)", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	useSurface(t, "transparent");
	setCardStyle(CARD_STYLE.NEON);
	const now = 1_788_600_000_000;
	const win = (label: string, usedPercent: number, seconds: number) => ({ label, usedPercent, windowSeconds: seconds, resetAt: now + seconds * 500 });
	const usages = [{ provider: "anthropic", plan: "max", fetchedAt: now, limits: [{ name: "claude", limitReached: false, windows: [win("5h", 26, 18000), win("week", 4, 604800)] }] }] as ProviderUsage[];
	const f = fixture(180);
	sidebarPart(f.tui, "usage", { render: () => [], invalidate() {} }, {
		surface: "panel", digest: () => "usage", invalidate() {},
		render: (width: number) => renderUsageCard(usages, plain, width, now, { panel: true }),
	} as never);
	t.after(installSidebar(f.tui, plain, () => "auto", () => "top", () => "minimal", undefined, { tabs: true }));
	const column = (() => {
		const top = f.root[NODE]() as Node;
		const hstack = top.type === "hstack" ? top : top.entries[1]!.component[NODE]!() as Node;
		return hstack.entries[1]!.component[NODE]!() as Node;
	})();
	const pinned = column.entries[0]!.component;
	const tabRows = pinned.render(50).map(stripAnsi);
	const y = tabRows.findIndex((row) => row.includes("Resources"));
	pinned.handleMouse!({ type: "click", button: "left", x: tabRows[y]!.indexOf("Resources") + 1, y, screenX: 0, screenY: y, width: 50, height: tabRows.length, shift: false, alt: false, ctrl: false } as TuiMouseEvent);
	const rail = railOf(screen(f, 180), 180).filter((row) => /^ ?[╭│╰]/.test(row));
	assert.match(rail[0]!, /^ ?╭─ Limits ─+╮$/);
	assert.ok(rail.length > 4, "the card has its rows");
	for (const row of rail.slice(1, -1)) assert.match(row, /│$/, `"${row}" closes on the frame`);
	assert.doesNotMatch(rail.join("\n"), /…/, "no row is cut");
});
