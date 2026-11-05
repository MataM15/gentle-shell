import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { TASK_STATUS, type TaskRecord } from "../lib/agents-protocol.ts";
import { AGENTS_GLYPH, renderAgentsCard } from "../lib/agents-widget.ts";
import { buildShellHeaderModel, renderShellHeaderChrome, renderShellNarrowTopBar, renderShellRailHeader, renderShellStatusBar, renderShellTitleRow, SHELL_BAR_BRAND, type ShellBarModel } from "../lib/shell-bar.ts";
import { renderPanelSheet } from "../lib/shell-panel.ts";
import { framePromptLines, petalGlyph, PROMPT_PETAL, PROMPT_STATE } from "../lib/shell-prompt.ts";
import { renderSidebarBanner } from "../lib/shell-sidebar-banner.ts";
import { renderUsagePanel, UsageStore, type ProviderUsage } from "../lib/shell-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// S16 (odd/tasks/shell-personal-rework.md): the owner's shell has no petal or rose
// decoration anywhere. Their glyph slots stay blank, as in d6fb874a5.

// The banner reads process.env directly; a suite launched from a delegated child must still exercise the parent paths.
delete process.env.GENTLE_PI_AGENTS_CHILD;

const PETALS = /[\u273f\u2740\u2741\u273e\u{1F339}\u{1F338}]/u;
const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const model: ShellBarModel = {
	cwd: "~/work/gentle-pi-review-2750", branch: "feat/shell", dirty: undefined, sessionName: "Release notes", profile: "claude (session)",
	modelId: "claude-fable-5-1", effort: "low", contextPercent: 17, contextWindow: 1000, costTotal: 0, subscription: false,
	permission: { mode: "SUPER-YOLO" }, statuses: [],
	usage: { provider: "anthropic", plan: "max", fetchedAt: 0, limits: [{ name: "claude", limitReached: false, windows: [
		{ label: "5h", usedPercent: 26, windowSeconds: 18000, resetAt: null }, { label: "week", usedPercent: 4, windowSeconds: 604800, resetAt: null },
	] }] },
};
const noPetal = (text: string, what: string) => assert.doesNotMatch(stripAnsi(text), PETALS, what);

test("the wide and narrow chrome paint no petal", () => {
	for (const width of [180, 140, 56, 43]) {
		noPetal(renderShellTitleRow(model, plain, width), `title row at ${width}`);
		noPetal(renderShellTitleRow(model, plain, width, { model: true }), `mobile title row at ${width}`);
		noPetal(renderShellNarrowTopBar(model, plain, width, "alt+u").rows.join("\n"), `narrow top bar at ${width}`);
		noPetal(renderShellStatusBar(model, plain, width, "alt+u", undefined, undefined, { rail: true }).rows.join("\n"), `status bar at ${width}`);
		noPetal(renderShellHeaderChrome(buildShellHeaderModel(model), plain, width, "alt+u").rows.join("\n"), `header chrome at ${width}`);
	}
	noPetal(renderShellRailHeader(buildShellHeaderModel(model), plain, 50, "alt+u", undefined, "alt+k").rows.join("\n"), "rail header");
	noPetal(SHELL_BAR_BRAND, "brand constant");
});

test("the sidebar banner, panel sheet and agents card paint no petal", () => {
	noPetal(renderSidebarBanner(plain, 46).join("\n"), "banner");
	const sheet = renderPanelSheet(new Map([["todo", { render: () => ["▾ TODOS"] }]]), plain, 80, { rows: 10, scrollTop: 0 });
	noPetal(sheet.lines.join("\n"), "panel sheet");
	const task: TaskRecord = { id: "t", agent: "sdd-explore", mode: "task", prompt: "map", label: "map", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "anthropic/claude-sonnet-5", thinking: undefined, sessionPath: null, error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27 };
	noPetal(renderAgentsCard([task], plain, 60, 5000, { collapsed: false }).join("\n"), "agents card");
	noPetal(AGENTS_GLYPH, "agents glyph");
});

test("the editor rule and frames paint no petal in any state", () => {
	const lines = (width: number) => ["─".repeat(width - 2), " ".repeat(width - 2), "─".repeat(width - 2)];
	for (const style of ["neon", "float"] as const) for (const state of [PROMPT_STATE.IDLE, PROMPT_STATE.WORKING, PROMPT_STATE.QUEUED]) for (const tick of [0, 1, 2, 3]) {
		noPetal(framePromptLines(lines(60), 60, { style, state, tick, borderColor: (t) => t, fg: (_c, t) => t }).join("\n"), `${style} ${state} ${tick}`);
		assert.equal(petalGlyph(state, tick), " ");
	}
	assert.equal(PROMPT_PETAL, " ");
});

test("the usage panel and /gentle:usage paint no petal", () => {
	const usage: ProviderUsage = model.usage!;
	noPetal(renderUsagePanel([usage], plain, 80, 0, { provider: "anthropic" }).join("\n"), "usage panel");
	const view = new UsageView(new UsageStore(), { theme: plain, now: () => 0, active: () => ({ provider: "anthropic" }), onRefresh: () => new Promise(() => {}), onClose: () => {}, requestRender: () => {} });
	noPetal(view.render(80).join("\n"), "usage view");
	view.refresh();
	noPetal(view.render(80).join("\n"), "refreshing usage view");
});

// Machinery: no source line in the owner's shell may bring a petal back. Comments
// are free to name the old look; string literals and constants are not.
test("no source file of the shell carries a petal or rose in code", () => {
	const root = join(import.meta.dirname, "..");
	const files = [
		...readdirSync(join(root, "lib")).filter((name) => name.endsWith(".ts")).map((name) => join("lib", name)),
		...["gentle-shell", "gentle-agents", "gentle-todo", "gentle-wellness", "gentle-voice", "gentle-ai", "startup-banner"].map((name) => join("extensions", `${name}.ts`)),
	];
	const offenders = files.flatMap((file) => readFileSync(join(root, file), "utf8").split("\n").flatMap((line, index) => {
		const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
		return PETALS.test(code) ? [`${file}:${index + 1}`] : [];
	}));
	assert.deepEqual(offenders, []);
});

test("the startup banner draws the Gentle Shell title and no rose art, at every width", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	t.mock.method(fs, "readdir", async () => [] as never);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	let header: { render(width: number): string[]; dispose(): void };
	const { default: startup } = await import(new URL("../extensions/startup-banner.ts?no-petals", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	startup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as never);
	t.mock.method(process.stdout, "write", () => true);
	await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => { header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text }); } } });
	t.mock.timers.tick(200);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	try {
		for (const width of [40, 80, 160, 200]) {
			const text = stripAnsi(header!.render(width).join("\n"));
			assert.doesNotMatch(text, PETALS, `banner at ${width}`);
			assert.doesNotMatch(text, /[\u2800-\u28ff]/, `no braille rose art at ${width}`);
			assert.match(text, /GIT:/, "the info block stays");
			if (width >= 160) assert.match(text, /[▒▄▀█]/, "the Gentle Shell title stays");
		}
	} finally { shutdown!(); }
});
