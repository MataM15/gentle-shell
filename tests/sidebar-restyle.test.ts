import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Container, Spacer, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { CARD_STYLE, setCardStyle } from "../lib/shell-card.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarPart, sidebarRailHeader } from "../lib/shell-sidebar.ts";
import { chromeSurface, renderPanelHeader, renderPanelRow, setChromeSurface } from "../lib/shell-panel.ts";
import { abbreviateModelNames, limitsFailureNotes, renderUsageCard, type ProviderUsage } from "../lib/shell-usage.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\s+$/, "");
const NOW = Date.parse("2026-10-26T22:11:00Z");
const DAY = 86_400_000;

// 1. Gap: the header's closing rule never touches the first card's top border.
async function rail(density: "minimal" | "compact" | "comfortable") {
	const columns = 140;
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return 30; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const lines = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });
	const footer = new Container();
	const above = new Container();
	above.addChild(new Spacer(1));
	const viewport = createChatViewport({
		document: lines(["transcript"]), pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor: lines(["╭─ editor ─╮", "│ prompt   │", "╰──────────╯"]), widgetsBelow: new Container(), footer, scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal, false);
	tui.setLayoutRoot(viewport.root);
	const card = (title: string): string[] => [`╭─ ${title} ${"─".repeat(39 - title.length)}╮`, `│ body${" ".repeat(37)}│`, `╰${"─".repeat(42)}╯`];
	const section = (title: string) => (width: number) => [renderPanelHeader(plain, width, { title, open: true }), renderPanelRow(width, "body")];
	sidebarRailHeader(tui, { render: () => ["HEADER", "─".repeat(50)], invalidate() {} });
	sidebarPart(tui, "wellness", lines([]), { render: () => card("Breaks"), invalidate() {} });
	sidebarPart(tui, "agents", lines([]), { surface: "panel", render: section("Agents"), invalidate() {} } as never);
	footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM"]), { surface: "panel", render: section("Changes"), invalidate() {} } as never));
	installSidebar(tui, plain, () => "auto", () => "top", () => density);
	tui.start();
	tui.requestRender(true);
	await new Promise((resolve) => setTimeout(resolve, 30));
	tui.stop();
	return ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []).map((row) => strip(row).slice(90).trimEnd());
}

for (const density of ["minimal", "compact", "comfortable"] as const) {
	test(`neon rail at ${density} density: one blank row between the header and each card, every top border intact`, async () => {
		setCardStyle(CARD_STYLE.NEON);
		const surface = chromeSurface();
		setChromeSurface("transparent");
		const screen = await rail(density).finally(() => setChromeSurface(surface));
		const rule = screen.findIndex((row) => /^─{50}$/.test(row));
		assert.ok(rule >= 0, "header rule is painted");
		assert.equal(screen[rule + 1], "", "blank gap after the header rule");
		for (const title of ["Breaks", "▾ Agents", "▾ Changes"]) {
			const top = screen.findIndex((row) => row.includes(`╭─ ${title} `));
			assert.ok(top >= 0, `${title} keeps its titled top border`);
			assert.equal(screen[top - 1], "", `blank gap above ${title}`);
		}
	});
}

// 3. Limits grid.
const win = (label: string, usedPercent: number, resetAt: number | null, extra = {}) => ({ label, usedPercent, windowSeconds: 604_800, resetAt, ...extra });
const nan = (name: string, percent: number) => ({ name, limitReached: false, windows: [win("period", percent, NOW + 9 * DAY, { used: percent * 10, budget: 1000 })] });
const usages: ProviderUsage[] = [
	{ provider: "openai-codex", plan: "prolite", fetchedAt: NOW, limits: [{ name: "codex", limitReached: false, windows: [win("week", 46, NOW + 6 * DAY)] }] },
	{ provider: "anthropic", plan: undefined, fetchedAt: NOW, limits: [{ name: "claude", limitReached: false, windows: [win("5h", 5, NOW + 13_000_000), win("week", 95, NOW + 2 * DAY)] }] },
	{ provider: "cliproxyapi", plan: "antigravity · used", heading: "antigravity · used", layout: "accounts", fetchedAt: NOW, unavailable: [{ label: "Pay02", reason: "HTTP 403" }],
		limits: [
			{ name: "Pay01 C7d", account: "Pay01", family: "claude", limitReached: false, windows: [win("", 60, NOW + 2 * DAY)] },
			{ name: "Free01 C7d", account: "Free01", family: "claude", limitReached: false, windows: [win("", 0, NOW + 6 * DAY)] },
		] },
	{ provider: "nan", plan: undefined, fetchedAt: NOW, limits: ["mimo-v2.6-flash", "deepseek-v4-flash", "qwen3.8-flash", "glm5.3-flash", "glm5.2", "glm5.3"].map((name, index) => nan(name, index * 7 + 1)) },
] as ProviderUsage[];

test("Limits: every provider row shares one name | bar | % | reset grid", () => {
	const lines = renderUsageCard(usages, plain, 48, NOW).map(strip);
	const gridRows = lines.filter((line) => /[▰▱]{8}/.test(line));
	assert.equal(gridRows.length, 11, "every provider row is on the grid");
	const barAt = new Set(gridRows.map((line) => line.search(/[▰▱]/)));
	assert.equal(barAt.size, 1, `bars start at one column, got ${[...barAt]}`);
	const percentEnd = new Set(gridRows.map((line) => line.indexOf("%")));
	assert.equal(percentEnd.size, 1, `percentages end at one column, got ${[...percentEnd]}`);
	const resetAt = new Set(gridRows.map((line) => line.search(/\d[dhm]/g) >= 0 ? line.slice(line.indexOf("%") + 1).search(/\S/) : -1));
	assert.equal(resetAt.size, 1, "resets start at one column");
	assert.ok(lines.some((line) => /Pay01 C +[▰▱]{8}/.test(line)), "the family marker sits inside the name column");
	const failure = lines.find((line) => line.includes("Pay02"))!;
	assert.equal(failure.search(/✕/), lines.find((line) => /Pay01 C/.test(line))!.search(/[▰▱]/), "the failure starts where the bars start");
	assert.match(failure, /✕ HTTP 403/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 48, line);
});

test("Limits: failures the card paints are exposed so Status can drop the duplicate", () => {
	assert.deepEqual(limitsFailureNotes(usages), ["Pay02 unavailable (HTTP 403)"]);
	assert.deepEqual(limitsFailureNotes([usages[0]!]), []);
});

// 4. Model abbreviations.
test("model abbreviations are readable, collision-aware and bounded", () => {
	assert.deepEqual(
		abbreviateModelNames(["mimo-v2.6-flash", "deepseek-v4-flash", "qwen3.8-flash", "glm5.3-flash", "glm5.2", "glm5.3"], 20),
		["mimo 2.6", "deepseek v4", "qwen 3.8", "glm 5.3 fl", "glm 5.2", "glm 5.3"],
	);
	assert.deepEqual(abbreviateModelNames(["week", "5h", "claude/gpt"], 20), ["week", "5h", "claude/gpt"], "plain labels are untouched");
	assert.deepEqual(abbreviateModelNames(["deepseek-v4-flash"], 8), ["deepsee…"], "truncation is only the fallback");
	assert.deepEqual(abbreviateModelNames(["mimo-v2.6-flash"], 20), abbreviateModelNames(["mimo-v2.6-flash"], 20), "deterministic");
});
