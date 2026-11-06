import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { framePromptLines, PROMPT_STATE, resolvePromptLayout, type PromptFrameOptions } from "../lib/shell-prompt.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

// Narrow editor (odd/tasks/shell-personal-rework.md S19, T12): below 140 columns the editor is the
// owner's rose framed box with `≡ commands · alt+k` at the left of its top border and `[ Panel ]`
// at the right only when it fits whole. 98 is the owner's terminal.

const INSTALLED_PI = (createRequire(import.meta.url)("@earendil-works/pi-tui/package.json") as { version: string }).version;
const plain = (_role: string, text: string) => text;
const options = (overrides: Partial<PromptFrameOptions> = {}): PromptFrameOptions => ({ style: "neon", state: PROMPT_STATE.IDLE, tick: 0, borderColor: (text) => text, fg: plain, ...overrides });
const editorLines = (width: number) => ["─".repeat(width - 2), " " + " ".repeat(width - 3), "─".repeat(width - 2)];
const frame = (width: number, overrides: Partial<PromptFrameOptions> = {}) =>
	framePromptLines(editorLines(width), width, options(overrides), resolvePromptLayout(width, "neon", undefined, false)).map(stripAnsi);

for (const width of [98, 80, 56, 44]) {
	test(`S19: the narrow framed editor at ${width} columns leads with ≡ commands and closes with [ Panel ]`, () => {
		const rows = frame(width, { commandsLabel: { hint: "alt+k" }, framedPanelButton: true });
		assert.match(rows[0]!, /^╭─ {3}≡ commands · alt\+k ─+ \[ Panel \] ─╮$/, "commands left, Panel right, in the framed top border");
		assert.match(rows[rows.length - 1]!, /^╰─+╯$/);
		for (const row of rows) assert.equal(visibleWidth(row), width);
		assert.ok(rows.slice(1, -1).every((row) => row.startsWith("│") && row.endsWith("│")), "a framed box, not a rule");
		assert.doesNotMatch(rows.join("\n"), /waiting for input|✿|🌸|🌹/);
		assert.doesNotMatch(frame(width, { commandsLabel: { hint: "alt+k" } })[0]!, /Panel/, "no button without the panel callback");
	});
}

test("S19: « panel closes the top border instead of the button when the rail can unfold", () => {
	const rows = frame(98, { commandsLabel: { hint: "alt+k" }, panelLabel: { hint: "alt+h" }, framedPanelButton: true });
	assert.match(rows[0]!, /^╭─ {3}≡ commands · alt\+k ─+ « panel · alt\+h ─╮$/);
	assert.doesNotMatch(rows[0]!, /\[ Panel \]/);
});

test("S19: [ Panel ] is dropped whole, never clipped, when it does not fit, and ≡ commands stays", () => {
	for (const width of [30, 32, 34]) {
		const top = frame(width, { commandsLabel: { hint: "alt+k" }, framedPanelButton: true })[0]!;
		assert.equal(visibleWidth(top), width);
		assert.match(top, /≡ commands · alt\+k/);
		assert.doesNotMatch(top, /\[|Panel|Pane/, `no partial button at ${width}`);
	}
});

const editorTheme = { borderColor: (text: string) => text, selectList: {} };
const keybindings = { matches: () => false };
function editor(deps: Partial<ConstructorParameters<typeof GentlePromptEditor>[3]>) {
	const tui = { terminal: { rows: 40, columns: 98 }, requestRender() {} };
	return new GentlePromptEditor(tui as never, editorTheme as never, keybindings as never, {
		fg: plain, bold: (text) => text, requestRender() {}, pending: () => false, now: () => 0,
		doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, tuiVersion: () => INSTALLED_PI, panelChrome: () => false, ...deps,
	});
}
const mouse = (type: TuiMouseEvent["type"], x: number, width: number, button: TuiMouseEvent["button"] = "left"): TuiMouseEvent =>
	({ type, button, x, y: 0, screenX: x, screenY: 0, width, height: 3, shift: false, alt: false, ctrl: false } as TuiMouseEvent);

for (const width of [98, 80, 56, 44]) {
	test(`S19: at ${width} columns a click on ≡ commands or [ Panel ] reaches its own cells only`, () => {
		let opens = 0;
		let panels = 0;
		let enabled = true;
		const prompt = editor({
			commandsLabel: () => ({ hint: "alt+k" }), openCommands: () => { opens++; },
			panelButton: () => enabled, onPanelClick: () => { panels++; },
		});
		try {
			const top = stripAnsi(prompt.render(width)[0]!);
			const commands = top.indexOf("≡ commands");
			const button = top.indexOf("[ Panel ]");
			assert.ok(commands >= 0 && button > commands, "both controls are painted");
			const commandsEnd = commands + "≡ commands · alt+k".length;
			const buttonEnd = button + "[ Panel ]".length;
			for (const x of [commands - 1, commandsEnd, button - 1, buttonEnd]) prompt.handleMouse(mouse("click", x, width));
			prompt.handleMouse(mouse("click", commands, width, "right"));
			assert.deepEqual([opens, panels], [0, 0], "neighbouring cells and the right button are inert");
			assert.equal(prompt.handleMouse(mouse("click", commands, width))?.handled, true);
			assert.equal(prompt.handleMouse(mouse("click", commandsEnd - 1, width))?.handled, true);
			assert.equal(prompt.handleMouse(mouse("click", button, width))?.handled, true);
			assert.equal(prompt.handleMouse(mouse("click", buttonEnd - 1, width))?.handled, true);
			assert.deepEqual([opens, panels], [2, 2]);
			prompt.handleMouse(mouse("click", button, width + 1));
			assert.equal(panels, 2, "a stale width is not a target");
			enabled = false;
			prompt.render(width);
			prompt.handleMouse(mouse("click", button, width));
			assert.equal(panels, 2, "a button that is no longer offered is inert");
		} finally { prompt.dispose(); }
	});
}

test("S19: hovering [ Panel ] in the framed editor repaints it as clickable", () => {
	let renders = 0;
	const prompt = editor({ commandsLabel: () => ({ hint: "alt+k" }), panelButton: () => true, onPanelClick() {}, requestRender: () => { renders++; } });
	try {
		const top = stripAnsi(prompt.render(98)[0]!);
		const at = top.indexOf("[ Panel ]");
		const before = renders;
		assert.equal(prompt.handleMouse(mouse("move", at, 98, "none"))?.handled, true);
		assert.ok(renders > before, "the hover asks for a render");
	} finally { prompt.dispose(); }
});
