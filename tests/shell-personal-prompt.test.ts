import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { framePromptLines, PROMPT_STATE, resolvePromptLayout, type PromptFrameOptions } from "../lib/shell-prompt.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The owner's labels in the editor's top rule (odd/tasks/shell-personal-rework.md S5, S6, S7):
// `« panel · alt+h` while the rail is folded away.

const INSTALLED_PI = (createRequire(import.meta.url)("@earendil-works/pi-tui/package.json") as { version: string }).version;
const plain = (_role: string, text: string) => text;
const options = (overrides: Partial<PromptFrameOptions> = {}): PromptFrameOptions => ({ style: "neon", state: PROMPT_STATE.IDLE, tick: 0, borderColor: (text) => text, fg: plain, ...overrides });
const editorLines = (width: number) => ["─".repeat(width - 2), " " + " ".repeat(width - 3), "─".repeat(width - 2)];
const rule = (width: number, overrides: Partial<PromptFrameOptions> = {}) => {
	const layout = resolvePromptLayout(width, "neon", undefined, true);
	return stripAnsi(framePromptLines(editorLines(width), width, options(overrides), layout)[0]!);
};

for (const width of [56, 180]) {
	test(`the panel rule offers « panel · alt+h between the state and the mode at ${width} columns (S5)`, () => {
		const text = rule(width, { escHint: "INSERT", panelLabel: { hint: "alt+h" } });
		assert.equal(visibleWidth(text), width);
		assert.match(text, /^─ ✿ waiting for input ─+ « panel · alt\+h ─ INSERT ─$/);
		assert.match(rule(width, { escHint: "INSERT", panelLabel: {} }), /« panel ─ INSERT ─$/, "no shortcut, no key shown");
		assert.doesNotMatch(rule(width, { escHint: "INSERT" }), /panel/, "absent while the rail shows");
	});
}

test("the « panel label gives way before the rule overflows and uses theme roles only (S5, S7)", () => {
	for (const width of [20, 24, 30]) assert.equal(visibleWidth(rule(width, { escHint: "INSERT", panelLabel: { hint: "alt+h" } })), width);
	assert.doesNotMatch(rule(24, { escHint: "INSERT", panelLabel: { hint: "alt+h" } }), /«/, "no room: the label is dropped, never clipped");
	const roles = new Set<string>();
	const spy = (role: string, text: string) => { roles.add(role); return text; };
	rule(80, { fg: spy, escHint: "INSERT", panelLabel: { hint: "alt+h" } });
	for (const role of roles) assert.match(role, /^(accent|muted|dim|text|warning|borderAccent|thinkingHigh)$/, role);
});

const editorTheme = { borderColor: (text: string) => text, selectList: {} };
const keybindings = { matches: () => false };
function editor(deps: Partial<ConstructorParameters<typeof GentlePromptEditor>[3]>) {
	const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };
	return new GentlePromptEditor(tui as never, editorTheme as never, keybindings as never, {
		fg: plain, bold: (text) => text, requestRender() {}, pending: () => false, now: () => 0,
		doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => INSTALLED_PI, panelChrome: () => true, ...deps,
	});
}
const click = (x: number, y = 0, width = 80): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 3, shift: false, alt: false, ctrl: false });

test("the editor's « panel label unfolds the rail on a click of its own cells only (S5)", () => {
	let shown: { hint?: string } | undefined = { hint: "alt+h" };
	let toggles = 0;
	const prompt = editor({ panelLabel: () => shown, togglePanel: () => { toggles++; } });
	try {
		const rows = prompt.render(80);
		const text = stripAnsi(rows[0]!);
		const start = text.indexOf("« panel");
		assert.ok(start >= 0, "painted in the rule");
		const end = start + "« panel · alt+h".length;
		prompt.handleMouse(click(start - 1));
		prompt.handleMouse(click(end));
		prompt.handleMouse({ ...click(start), type: "click", button: "right" });
		assert.equal(toggles, 0);
		assert.equal(prompt.handleMouse(click(start))?.handled, true);
		assert.equal(prompt.handleMouse(click(end - 1))?.handled, true);
		assert.equal(toggles, 2);
		shown = undefined;
		prompt.render(80);
		prompt.handleMouse(click(start));
		assert.equal(toggles, 2, "a label that is no longer shown is inert");
	} finally { prompt.dispose(); }
});

for (const width of [56, 180]) {
	test(`the panel rule offers ≡ commands · alt+k between the state and the mode at ${width} columns (S6)`, () => {
		const text = rule(width, { escHint: "INSERT", commandsLabel: { hint: "alt+k" } });
		assert.equal(visibleWidth(text), width);
		assert.match(text, /^─ ✿ waiting for input ─+ ≡ commands · alt\+k ─ INSERT ─$/);
		assert.match(rule(width, { escHint: "INSERT", commandsLabel: {} }), /≡ commands ─ INSERT ─$/, "no shortcut, no key shown");
		const both = rule(width, { escHint: "INSERT", commandsLabel: { hint: "alt+k" }, panelLabel: { hint: "alt+h" } });
		if (width >= 100) assert.match(both, /≡ commands · alt\+k {2}« panel · alt\+h ─ INSERT ─$/, "both labels, commands first");
		else assert.match(both, /≡ commands · alt\+k ─ INSERT ─$/, "short of room the panel label gives way first");
		assert.doesNotMatch(rule(width, { escHint: "INSERT" }), /commands/, "absent while the rail card carries the action");
	});
}

test("the commands label takes the slot of the Panel button while it fits and the button returns when it does not (S6)", () => {
	const withBoth = rule(56, { escHint: "INSERT", commandsLabel: { hint: "alt+k" }, panelButton: true });
	assert.match(withBoth, /≡ commands · alt\+k/);
	assert.doesNotMatch(withBoth, /\[ Panel \]/);
	const tight = rule(30, { escHint: "INSERT", commandsLabel: { hint: "alt+k" }, panelButton: true });
	assert.equal(visibleWidth(tight), 30);
	assert.match(tight, /\[ Panel \]/, "no room for the label: the existing control stays reachable");
});

test("the editor's ≡ commands label opens the palette on a click of its own cells only (S6)", () => {
	let shown: { hint?: string } | undefined = { hint: "alt+k" };
	let opens = 0;
	const prompt = editor({ commandsLabel: () => shown, openCommands: () => { opens++; } });
	try {
		const text = stripAnsi(prompt.render(56)[0]!);
		const start = text.indexOf("≡ commands");
		assert.ok(start >= 0);
		const end = start + "≡ commands · alt+k".length;
		prompt.handleMouse(click(start - 1, 0, 56));
		prompt.handleMouse(click(end, 0, 56));
		assert.equal(opens, 0);
		assert.equal(prompt.handleMouse(click(start, 0, 56))?.handled, true);
		assert.equal(prompt.handleMouse(click(end - 1, 0, 56))?.handled, true);
		assert.equal(opens, 2);
		shown = undefined;
		prompt.render(56);
		prompt.handleMouse(click(start, 0, 56));
		assert.equal(opens, 2, "a label that is no longer shown is inert");
	} finally { prompt.dispose(); }
});
