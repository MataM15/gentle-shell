import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createRequire } from "node:module";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { framePromptLines, PROMPT_STATE, resolvePromptLayout, type PromptFrameOptions } from "../lib/shell-prompt.ts";
import * as bar from "../lib/shell-bar.ts";
import type { ShellBarModel, ShellBarTheme } from "../lib/shell-bar.ts";
import { DEFAULT_VISUAL_SETTINGS } from "../lib/visual-customization-policy.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { YOLO_STATUS_TEXT } from "../lib/yolo-session-policy.ts";

// Folded rail (odd/tasks/shell-personal-rework.md S18, T11): the owner's
// previous look from fb717450e and f57d77722: the Sesión card, the band composer, and
// the framed editor carrying `≡ commands` on the left and `« panel` on the right.

const plain: ShellBarTheme = { fg: (_color, text) => text, bold: (text) => text };
const initialStyle = cardStyle();
before(() => setCardStyle(CARD_STYLE.NEON));
after(() => setCardStyle(initialStyle));

function model(overrides: Partial<ShellBarModel> = {}): ShellBarModel {
	return {
		cwd: "~/proyectos", branch: "master", dirty: undefined, sessionName: undefined,
		modelId: "claude-fable-5-1", effort: "low", profile: "claude-nan",
		contextPercent: 10, contextWindow: 200_000, costTotal: 0, subscription: false,
		usage: undefined,
		statuses: ["\u{1F9E0} proyectos · ✓ 8 results", YOLO_STATUS_TEXT, "Permissions: YOLO"],
		jobs: [{ id: "j1", label: "ci", startedAt: 1 }],
		...overrides,
	};
}
const render = (data: ShellBarModel, width = 120, hint: string | null = "alt+u") =>
	bar.renderShellSessionCard(data, plain, width, hint ?? undefined, DEFAULT_VISUAL_SETTINGS);
const text = (rows: string[]) => rows.map(stripAnsi);
const column = (row: string, needle: string, from = 0) => visibleWidth(row.slice(0, row.indexOf(needle, from)));

test("S4: Sesión is a titled four-row card of the requested width", () => {
	const { rows } = render(model());
	const plainRows = text(rows);
	assert.equal(rows.length, 6, "frame + 4 body rows + frame");
	assert.match(plainRows[0]!, /^╭─ ?Sesión/);
	assert.match(plainRows[5]!, /^╰─+╯$/);
	for (const width of [120, 90, 61]) assert.ok(render(model(), width).rows.every((row) => visibleWidth(row) === width), `exact width ${width}`);
});

test("S4: three columns aligned by ◇ with two columns of inner padding", () => {
	const rows = text(render(model()).rows);
	assert.match(rows[1]!, /^│ {2}~\/proyectos master /, "row 1 col 1 sits after the 2-column padding");
	assert.match(rows[1]!, /◇ claude-fable-5-1 · low · claude-nan/);
	assert.match(rows[2]!, /^│ {2}ctx ▰▱{7} 10% /);
	assert.match(rows[2]!, /◇ \$0\.000/);
	assert.match(rows[2]!, /◇ ◔ usage alt\+u +│$/, "col 3 is a left-aligned block");
	assert.match(rows[3]!, /^│ {2}\u{1F9E0} proyectos · ✓ 8 results/u);
	assert.match(rows[3]!, /◇ ⧗ 1 job/);
	assert.match(rows[3]!, /◇ Permissions: YOLO {2}│$/);
	const col2 = [1, 2, 3].map((i) => column(rows[i]!, "◇"));
	assert.equal(new Set(col2).size, 1, "col 2 diamonds share one column");
	const col3 = [2, 3].map((i) => column(rows[i]!, "◇", column(rows[i]!, "◇") + 1));
	assert.equal(col3[0], col3[1], "col 3 diamonds share one column");
	const col1End = Math.max(...[1, 2, 3].map((i) => visibleWidth(rows[i]!.slice(0, rows[i]!.indexOf("◇")).trimEnd())));
	const col2Width = visibleWidth("◇ claude-fable-5-1 · low · claude-nan");
	const left = col2[0]! - col1End, right = col3[0]! - (col2[0]! + col2Width);
	assert.ok(Math.abs(left - right) <= 1, `col 2 is centred between col 1 and col 3 (${left}/${right})`);
});

test("S4: row 4 pins the YOLO status; without it the remaining statuses are joined", () => {
	assert.match(text(render(model()).rows)[4]!, new RegExp(`^│ {2}${YOLO_STATUS_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u"));
	assert.doesNotMatch(text(render(model()).rows)[4]!, /◇/);
	const rows = text(render(model({ statuses: ["a", "b", "c", "d"], jobs: undefined })).rows);
	assert.match(rows[3]!, /^│ {2}a /);
	assert.match(rows[3]!, /◇ b +│$/, "second status fills row 3 col 3");
	assert.match(rows[4]!, /^│ {2}c · d/);
});

test("S4: missing values leave their slot empty without shifting other columns", () => {
	const full = text(render(model()).rows);
	const noJobs = text(render(model({ jobs: undefined })).rows);
	assert.doesNotMatch(noJobs[3]!, /⧗/);
	assert.equal(column(noJobs[3]!, "◇ Permissions"), column(full[3]!, "◇ Permissions"), "col 3 keeps its column");
	const bare = text(render(model({ statuses: [], jobs: undefined, profile: undefined, effort: undefined })).rows);
	assert.equal(bare.length, 6);
	assert.match(bare[1]!, /◇ claude-fable-5-1 {2,}│$/);
	assert.doesNotMatch(bare.join("\n"), /usage alt\+u.*usage alt\+u/s);
});

test("S4: usage without a shortcut still shows the label; no usage cost visibility hides ctx, cost and usage", () => {
	assert.match(text(render(model(), 120, null).rows)[2]!, /◇ ◔ usage +│$/);
	const hidden = bar.renderShellSessionCard(model(), plain, 120, "alt+u", { ...DEFAULT_VISUAL_SETTINGS, visibility: { ...DEFAULT_VISUAL_SETTINGS.visibility, usageCost: false } });
	assert.doesNotMatch(text(hidden.rows).join("\n"), /ctx|usage|\$0/);
	assert.equal(hidden.usageHit, undefined);
});

test("S4: every cell is clipped to its column with an ellipsis, never wrapped", () => {
	const long = model({ cwd: "~/very/long/path/that/keeps/going/and/going", branch: "feature/a-branch-with-a-really-long-name", statuses: ["x".repeat(80), "y".repeat(80), "z".repeat(200)] });
	for (const width of [140, 100, 70, 40]) {
		const { rows } = render(long, width);
		assert.equal(rows.length, 6, `no wrapping at ${width}`);
		assert.ok(rows.every((row) => visibleWidth(row) === width), `exact width ${width}`);
	}
	assert.match(text(render(long, 70).rows).join("\n"), /…/);
});

test("S6: the usage hit covers `◔ usage <key>` on its own row only", () => {
	const result = render(model());
	const rows = text(result.rows);
	const start = column(rows[2]!, "◔");
	const end = visibleWidth(rows[2]!.slice(0, rows[2]!.indexOf("alt+u") + "alt+u".length));
	assert.deepEqual(result.usageHit, { row: 2, start, end });
	assert.equal(bar.shellSessionUsageHit(result, start, 2), true);
	assert.equal(bar.shellSessionUsageHit(result, end - 1, 2), true);
	assert.equal(bar.shellSessionUsageHit(result, end, 2), false);
	assert.equal(bar.shellSessionUsageHit(result, start - 1, 2), false);
	assert.equal(bar.shellSessionUsageHit(result, start, 1), false);
});

test("S3: band composer puts Breaks at 50 columns on the right edge with a 2-column gap", () => {
	const breaks = Array.from({ length: 6 }, (_, i) => `B${i}`.padEnd(50, "·"));
	const band = bar.renderFoldedBand(model(), plain, 160, breaks, "alt+u", DEFAULT_VISUAL_SETTINGS);
	assert.equal(band.rows.length, 6);
	assert.equal(band.rightX, 110);
	for (const [i, row] of band.rows.entries()) {
		const flat = stripAnsi(row);
		assert.equal(visibleWidth(row), 160, `row ${i} is full width`);
		assert.equal(flat.slice(110), breaks[i], `row ${i} right card`);
		assert.equal(flat.slice(108, 110), "  ", `row ${i} gap`);
	}
	const top = stripAnsi(band.rows[0]!);
	assert.equal(top[0], "╭");
	assert.equal(top[107], "╮", "the left card ends two columns before Breaks");
	assert.equal(stripAnsi(band.rows[5]!)[107], "╯");
});

test("S3: without a Breaks card Sesión takes the whole width", () => {
	const band = bar.renderFoldedBand(model(), plain, 160, undefined, "alt+u", DEFAULT_VISUAL_SETTINGS);
	assert.equal(band.rows.length, 6);
	assert.equal(band.rightX, 160);
	assert.ok(band.rows.every((row) => visibleWidth(row) === 160));
});

test("S3: a shorter right card is padded so both cards keep the same height", () => {
	const band = bar.renderFoldedBand(model(), plain, 160, ["only one row".padEnd(50)], "alt+u", DEFAULT_VISUAL_SETTINGS);
	assert.equal(band.rows.length, 6);
	assert.ok(band.rows.every((row) => visibleWidth(row) === 160));
});

test("S3: the float card style keeps the band working through renderCard", () => {
	const prior = cardStyle();
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		const themed = { ...plain, bg: (_c: string, t: string) => t };
		const band = bar.renderFoldedBand(model(), themed, 160, Array.from({ length: 6 }, () => " ".repeat(50)), "alt+u", DEFAULT_VISUAL_SETTINGS);
		assert.equal(band.rows.length, 6);
		assert.ok(band.rows.every((row) => visibleWidth(row) === 160));
		assert.match(stripAnsi(band.rows.join("\n")), /Sesión/);
	} finally { setCardStyle(prior); }
});

// The framed editor rule of the folded rail: `╭─ ≡ commands · alt+k ───── « panel · alt+h ─╮`.

const INSTALLED_PI = (createRequire(import.meta.url)("@earendil-works/pi-tui/package.json") as { version: string }).version;
const options = (overrides: Partial<PromptFrameOptions> = {}): PromptFrameOptions => ({ style: "neon", state: PROMPT_STATE.IDLE, tick: 0, borderColor: (value) => value, fg: (_role, value) => value, ...overrides });
const editorLines = (width: number) => ["─".repeat(width - 2), " " + " ".repeat(width - 3), "─".repeat(width - 2)];
const labels = { commandsLabel: { hint: "alt+k" }, panelLabel: { hint: "alt+h" } };
const frame = (width: number, overrides: Partial<PromptFrameOptions> = {}) =>
	stripAnsi(framePromptLines(editorLines(width), width, options(overrides), resolvePromptLayout(width, "neon", undefined, false))[0]!);

for (const width of [180, 140, 100]) {
	test(`S18: the framed editor carries ≡ commands on the left and « panel on the right of its top border at ${width} columns`, () => {
		const top = frame(width, labels);
		assert.equal(visibleWidth(top), width);
		assert.match(top, /^╭─ {3}≡ commands · alt\+k ─+ « panel · alt\+h ─╮$/);
		assert.match(frame(width, { ...labels, state: PROMPT_STATE.WORKING }), /^╭─ {3}≡ commands · alt\+k · working… ─+ « panel · alt\+h ─╮$/);
		assert.doesNotMatch(top, /✿|🌹|🌸/);
		assert.match(frame(width, { commandsLabel: {}, panelLabel: {} }), /≡ commands ─+ « panel ─╮$/, "no shortcut, no key shown");
	});
}

test("S18: the framed editor drops the panel label before the commands label and never clips either", () => {
	for (const width of [22, 26, 30, 34, 40]) {
		const top = frame(width, labels);
		assert.equal(visibleWidth(top), width);
		assert.ok(!top.includes("« panel") || top.includes("« panel · alt+h"), `${width}: never clipped`);
		assert.ok(!top.includes("≡") || top.includes("≡ commands · alt+k"), `${width}: never clipped`);
	}
	assert.match(frame(40, labels), /≡ commands · alt\+k/);
	assert.doesNotMatch(frame(40, labels), /« panel/, "no room: the panel label gives way first");
});

test("S18: the float editor puts the same labels on its hint row", () => {
	const width = 120;
	const layout = resolvePromptLayout(width, "float", (_role, value) => `\x1b[48;5;22m${value}\x1b[49m`, false);
	assert.ok(layout.background, "float layout with a painted background");
	const row = stripAnsi(framePromptLines(editorLines(width), width, options({ style: "float", ...labels }), layout)[0]!);
	assert.equal(visibleWidth(row), width);
	assert.match(row, /^ ▎ {3}≡ commands · alt\+k · waiting for input {2,}« panel · alt\+h /);
});

const editorTheme = { borderColor: (value: string) => value, selectList: {} };
function editor(deps: Partial<ConstructorParameters<typeof GentlePromptEditor>[3]>) {
	const tui = { terminal: { rows: 40, columns: 180 }, requestRender() {} };
	return new GentlePromptEditor(tui as never, editorTheme as never, { matches: () => false } as never, {
		fg: (_role, value) => value, bold: (value) => value, requestRender() {}, pending: () => false, now: () => 0,
		doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => INSTALLED_PI, panelChrome: () => false, ...deps,
	});
}
const click = (x: number, width: number): TuiMouseEvent => ({ type: "click", button: "left", x, y: 0, screenX: x, screenY: 0, width, height: 3, shift: false, alt: false, ctrl: false });

test("S18: both labels of the framed editor are clickable on their own cells and nowhere else", () => {
	let commands = 0, panel = 0;
	const prompt = editor({ commandsLabel: () => ({ hint: "alt+k" }), panelLabel: () => ({ hint: "alt+h" }), openCommands: () => { commands++; }, togglePanel: () => { panel++; } });
	try {
		const width = 180;
		const text = stripAnsi(prompt.render(width)[0]!);
		assert.match(text, /^╭─ {3}≡ commands · alt\+k ─+ « panel · alt\+h ─╮$/);
		const c = text.indexOf("≡ commands"), p = text.indexOf("« panel");
		prompt.handleMouse(click(c - 1, width)); prompt.handleMouse(click(p - 1, width));
		assert.equal(commands + panel, 0);
		assert.equal(prompt.handleMouse(click(c, width))?.handled, true);
		assert.equal(prompt.handleMouse(click(c + "≡ commands · alt+k".length - 1, width))?.handled, true);
		assert.equal(prompt.handleMouse(click(p, width))?.handled, true);
		assert.equal(prompt.handleMouse(click(p + "« panel · alt+h".length - 1, width))?.handled, true);
		assert.deepEqual([commands, panel], [2, 2]);
	} finally { prompt.dispose(); }
});
