import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";
import {
	framePromptChrome,
	framePromptLines,
	scanWorkingText,
	PROMPT_STATE,
	petalGlyph,
	petalTone,
	SHELL_PULSE_MS,
	SHELL_SCANNER_STEPS,
	withPromptHint,
	type PromptFrameOptions,
} from "../lib/shell-prompt.ts";

test("scanner reflects a symmetric light wave across working text at Pi's original cadence", () => {
	const fg = (role: string, char: string) => `<${role}>${char}</${role}>`;
	assert.equal(SHELL_PULSE_MS, 80);
	assert.equal(SHELL_SCANNER_STEPS, 15);
	for (const word of ["working…", "Thinking…"]) {
		for (let tick = 0; tick < SHELL_SCANNER_STEPS; tick++) {
			const frame = scanWorkingText(word, tick, fg);
			assert.equal(frame.replace(/<[^>]+>/g, ""), word);
		}
		assert.match(scanWorkingText(word, 0, fg), /^(<muted>.<\/muted>)+$/);
		assert.match(scanWorkingText(word, 3, fg), new RegExp(`^<borderAccent>${word[0]}</borderAccent><accent>${word[1]}</accent><thinkingHigh>${word[2]}</thinkingHigh>`));
		assert.match(scanWorkingText(word, 4, fg), new RegExp(`^<accent>${word[0]}</accent><borderAccent>${word[1]}</borderAccent><accent>${word[2]}</accent>`));
		assert.match(scanWorkingText(word, 5, fg), new RegExp(`^<thinkingHigh>${word[0]}</thinkingHigh><accent>${word[1]}</accent><borderAccent>${word[2]}</borderAccent>`));
		assert.match(scanWorkingText(word, 14, fg), /^(<muted>.<\/muted>)+$/);
		assert.equal(scanWorkingText(word, SHELL_SCANNER_STEPS, fg), scanWorkingText(word, 0, fg));
	}
	for (const width of [1, 8, 20, 40]) {
		for (let tick = 0; tick < SHELL_SCANNER_STEPS; tick++) {
			const lines = framePromptLines(editorLines(Math.max(4, width)), width, options({ state: PROMPT_STATE.WORKING, tick, fg: (_role, text) => text }));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
});

test("compact banner pulse rises from ink through fresh color to a bright tip then fades", () => {
	const tones = Array.from({ length: 8 }, (_, tick) => petalTone(PROMPT_STATE.WORKING, tick));
	assert.deepEqual(tones, ["mdQuoteBorder", "thinkingHigh", "accent", "borderAccent", "accent", "thinkingHigh", "mdQuoteBorder", "mdQuoteBorder"]);
	assert.equal(petalTone(PROMPT_STATE.WORKING, 8), tones[0]);
});

// The Gentle Shell prompt wraps pi's editor output (a top rule, padded content
// lines, a bottom rule) in a rounded frame with a petal that shows the agent
// state. Framing is pure: it takes the editor's lines and returns new ones.

const CURSOR = "\x1b[7m \x1b[0m";

function options(overrides: Partial<PromptFrameOptions> = {}): PromptFrameOptions {
	return {
		style: "neon",
		state: PROMPT_STATE.IDLE,
		tick: 0,
		borderColor: (text) => text,
		fg: (color, text) => `<${color}>${text}</${color}>`,
		...overrides,
	};
}

test("framePromptLines sets the petal in bold when the theme offers it", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ bold: (text) => `*${text}*` }));
	assert.match(lines[0], /<borderAccent>\*✿\*<\/borderAccent>/);
});

function editorLines(width: number, content: string[] = [` ${CURSOR}`]): string[] {
	const inner = width - 2;
	return ["─".repeat(inner), ...content.map((line) => line + " ".repeat(inner - visibleWidth(line))), "─".repeat(inner)];
}

test("framePromptLines draws rounded corners, side rules, and keeps every line at width", () => {
	const width = 40;
	const lines = framePromptLines(editorLines(width), width, options({ fg: (_c, t) => t }));
	assert.equal(lines.length, 3);
	for (const line of lines) assert.equal(visibleWidth(line), width, `line "${stripAnsi(line)}" is not ${width} wide`);
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ ─+╮$/);
	assert.match(stripAnsi(lines[1]), /^│ .* │$/);
	assert.match(stripAnsi(lines[2]), /^╰─+╯$/);
});

test("framePromptLines paints the frame with the editor border color and the petal with the state tone", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ borderColor: (text) => `[b]${text}[/b]`, bold: (text) => `*${text}*` }));
	assert.match(lines[0], /^\[b\]╭─ \[\/b\]<borderAccent>\*✿\*<\/borderAccent>\[b\] ─+╮\[\/b\]$/);
	assert.match(lines[1], /^\[b\]│\[\/b\].*\[b\]│\[\/b\]$/);
	assert.match(lines[2], /^\[b\]╰─+╯\[\/b\]$/);
});

test("framePromptLines renders an explicit ODD phase workingLabel instead of the generic working label", () => {
	const plain = (_color: string, text: string) => text;
	const phased = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain, workingLabel: "exploring…" }));
	assert.match(stripAnsi(phased[0]), /^╭─ ✾ exploring… ─+╮$/);
	assert.equal(visibleWidth(phased[0]), 40);
});

test("framePromptLines falls back to the generic working label when no phase was reported", () => {
	const plain = (_color: string, text: string) => text;
	const fallback = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain, workingLabel: undefined }));
	assert.match(stripAnsi(fallback[0]), /^╭─ ✾ working… ─+╮$/);
});

test("framePromptLines ignores workingLabel outside the working state", () => {
	const plain = (_color: string, text: string) => text;
	const idle = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.IDLE, fg: plain, workingLabel: "exploring…" }));
	assert.equal(stripAnsi(idle[0]).includes("exploring"), false);
	const queued = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.QUEUED, fg: plain, workingLabel: "exploring…" }));
	assert.match(stripAnsi(queued[0]), /^╭─ ✿ queued ─+╮$/);
});

test("framePromptLines stays width-safe at narrow widths with the longest ODD phase label", () => {
	const plain = (_color: string, text: string) => text;
	// "implementing…" is the longest ODD_PHASES label (lib/odd-phase.ts).
	const longestLabel = "implementing…";
	for (const width of [1, 4, 8, 10, 14, 20, 40]) {
		const lines = framePromptLines(editorLines(Math.max(4, width)), width, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain, workingLabel: longestLabel }));
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: "${line}" exceeds the frame width`);
	}
	// At a comfortable width the full label still renders, unclipped.
	const comfortable = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain, workingLabel: longestLabel }));
	assert.match(stripAnsi(comfortable[0]), /implementing…/);
});

test("petalTone rests bright, walks the rose ramp while working, and turns to warning when queued", () => {
	assert.equal(petalTone(PROMPT_STATE.IDLE, 2), "borderAccent");
	assert.deepEqual([0, 1, 2, 3, 4].map((tick) => petalTone(PROMPT_STATE.WORKING, tick)), ["mdQuoteBorder", "thinkingHigh", "accent", "borderAccent", "accent"]);
	assert.equal(petalTone(PROMPT_STATE.QUEUED, 1), "warning");
});

test("petalGlyph spins through the flowers while working and rests otherwise", () => {
	assert.equal(petalGlyph(PROMPT_STATE.IDLE, 3), "✿");
	assert.deepEqual([0, 1, 2, 3, 4].map((tick) => petalGlyph(PROMPT_STATE.WORKING, tick)), ["✿", "❀", "❁", "✾", "✿"]);
	assert.equal(petalGlyph(PROMPT_STATE.QUEUED, 1), "❀");
});

test("framePromptLines scans the working word while preserving the frame and queued state", () => {
	const plain = (_color: string, text: string) => text;
	const working = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3 }));
	assert.match(working[0], /<borderAccent>✾<\/borderAccent>/);
	assert.match(working[0], /<borderAccent>w<\/borderAccent><accent>o<\/accent><thinkingHigh>r<\/thinkingHigh>/);
	assert.equal(working[0].replace(/<[^>]+>/g, "").includes("working…"), true);
	const workingPlain = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.WORKING, tick: 3, fg: plain }));
	assert.match(stripAnsi(workingPlain[0]), /^╭─ ✾ working… ─+╮$/);
	assert.equal(visibleWidth(workingPlain[0]), 40);

	const queued = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.QUEUED }));
	assert.match(queued[0], /<warning>✿<\/warning>/);
	assert.match(queued[0], /<muted>queued<\/muted>/);
	const queuedPlain = framePromptLines(editorLines(40), 40, options({ state: PROMPT_STATE.QUEUED, fg: plain }));
	assert.match(stripAnsi(queuedPlain[0]), /^╭─ ✿ queued ─+╮$/);
	assert.equal(visibleWidth(queuedPlain[0]), 40);
});

test("framePromptLines keeps the editor scroll indicators inside the frame", () => {
	const width = 40;
	const inner = width - 2;
	const top = `─── ↑ 2 more ${"─".repeat(inner - 13)}`;
	const bottom = `─── ↓ 3 more ${"─".repeat(inner - 13)}`;
	const lines = framePromptLines([top, ` x${" ".repeat(inner - 2)}`, bottom], width, options({ fg: (_c, t) => t }));
	assert.match(stripAnsi(lines[0]), /^╭─ ✿ ↑ 2 more ─+╮$/);
	assert.match(stripAnsi(lines[2]), /^╰─ ↓ 3 more ─+╯$/);
	for (const line of lines) assert.equal(visibleWidth(line), width);
});

test("framePromptLines shows an explicit escHint on the bottom rule, overriding the editor's own scroll indicator", () => {
	const width = 40;
	const inner = width - 2;
	const bottom = `─── ↓ 3 more ${"─".repeat(inner - 13)}`;
	const lines = framePromptLines(
		["─".repeat(inner), ` x${" ".repeat(inner - 2)}`, bottom],
		width,
		options({ fg: (_c, t) => t, escHint: "esc again to cancel" }),
	);
	assert.match(stripAnsi(lines[2]), /^╰─ esc again to cancel ─+╯$/);
});

test("framePromptLines falls back to the scroll indicator when no escHint is set", () => {
	const width = 40;
	const inner = width - 2;
	const bottom = `─── ↓ 3 more ${"─".repeat(inner - 13)}`;
	const lines = framePromptLines(["─".repeat(inner), ` x${" ".repeat(inner - 2)}`, bottom], width, options({ fg: (_c, t) => t }));
	assert.match(stripAnsi(lines[2]), /^╰─ ↓ 3 more ─+╯$/);
});

test("withPromptHint places a dim hint after the cursor on an empty editor line", () => {
	const inner = 38;
	const line = ` ${CURSOR}${" ".repeat(inner - 2)}`;
	const hinted = withPromptHint(line, "type, or / for commands", (color, text) => `<${color}>${text}</${color}>`);
	assert.match(hinted, /\x1b\[7m \x1b\[0m <dim>type, or \/ for commands<\/dim> +$/);
	const hintedPlain = withPromptHint(line, "type, or / for commands", (_c, t) => t);
	assert.equal(visibleWidth(hintedPlain), inner);
});

test("withPromptHint leaves the line alone when the hint does not fit", () => {
	const line = ` ${CURSOR}${" ".repeat(6)}`;
	const hinted = withPromptHint(line, "type, or / for commands", (_c, t) => t);
	assert.equal(hinted, line);
});

test("neon/fallback working prompt stays transparent at narrow and normal widths", () => {
	for (const width of [0, 1, 2, 3, 8, 40]) {
		const lines = framePromptLines(["──", ` ${CURSOR}界`, "──"], width, options({
			state: PROMPT_STATE.WORKING, fg: (_c, t) => t,
		}));
		for (const [row, line] of lines.entries()) {
			assert.ok(visibleWidth(line) <= width);
			let bg = false, cell = 0;
			for (const token of line.match(/\x1b\[[\d;]*m|[^\x1b]/gu) ?? []) {
				if (token.startsWith("\x1b")) {
					for (const code of token.slice(2, -1).split(";").map(Number)) {
						if (code === 0 || code === 49) bg = false;
						if (code === 44) bg = true;
					}
				} else {
					assert.equal(bg, false, `row ${row}, cell ${cell} must remain transparent`);
					cell += visibleWidth(token);
				}
			}
			assert.equal(bg, false);
		}
	}
});

test("neon/fallback transparent prompt preserves pi's cursor reset", () => {
	const lines = framePromptLines(editorLines(40), 40, options({ fg: (_c, t) => t }));
	assert.ok(lines[1].includes(CURSOR));
	assert.doesNotMatch(lines.join("\n"), /\x1b\[44m/);
});

const floatBg = (_role: string, text: string) => `\x1b[48;2;20;30;40m${text}\x1b[49m`;

test("T2 float prompt keeps status and content inside the background with inset and bottom padding", () => {
	const rows = framePromptLines(["── ↑ 2 more", `ab${CURSOR}cd`, "── ↓ 3 more"], 80, options({
		style: "float", bg: floatBg, fg: (_c, t) => t, state: PROMPT_STATE.WORKING, workingLabel: "exploring…", escHint: "esc again to cancel",
	}));
	assert.equal(rows.length, 3);
	assert.match(stripAnsi(rows[0]), /^ ▎ ✿ exploring… · ↑ 2 more · esc again to cancel/);
	assert.match(stripAnsi(rows[1]), /^ ▎ ab cd + $/);
	assert.ok(rows[1].includes(`${CURSOR}\x1b[48;2;20;30;40m`));
	assert.equal(stripAnsi(rows[2]), ` ▎${" ".repeat(77)} `);
	assert.ok(rows.every((row) => row.startsWith(" \x1b[48;2;20;30;40m") && row.endsWith("\x1b[49m ")));
	assert.ok(rows.every((row) => visibleWidth(row) === 80));
});

test("T2 float prompt falls back byte-exactly before narrow or unusable backgrounds", () => {
	for (const width of [0, 1, 2, 9, 10, 30, 80]) {
		const native = ["──", `x${CURSOR}`, "──"];
		const plain = options({ fg: (_c, t) => t });
		const neon = framePromptLines(native, width, { ...plain, style: "neon", bg: floatBg });
		assert.deepEqual(neon, framePromptLines(native, width, plain));
		for (const bg of [undefined, (_r: string, t: string) => t,
			(_r: string, t: string) => `\x1b[39m${t}\x1b[49m`,
			(_r: string, t: string) => `\x1b[44m\x1b[49m${t}\x1b[49m`,
			(_r: string, _t: string): string => { throw new Error("missing"); }]) {
			assert.deepEqual(framePromptLines(native, width, { ...plain, style: "float", bg }), neon);
		}
		const float = framePromptLines(native, width, { ...plain, style: "float", bg: floatBg });
		if (width < 10) assert.deepEqual(float, neon);
		else assert.match(stripAnsi(float[1]), /^ ▎/);
		assert.ok(float.every((row) => visibleWidth(row) <= width));
	}
});

test("T2 float prompt idle label uses the quiet card background without changing other states or neon", () => {
	const bg = (role: string, text: string) => {
		assert.equal(role, "toolSuccessBg");
		return floatBg(role, text);
	};
	for (const state of [PROMPT_STATE.IDLE, PROMPT_STATE.WORKING, PROMPT_STATE.QUEUED]) {
		const rows = framePromptLines(["──", "draft", "──"], 80, options({ style: "float", bg, state, fg: (_c, t) => t }));
		assert.match(stripAnsi(rows[0]), state === PROMPT_STATE.IDLE ? /✿ waiting for input/ : state === PROMPT_STATE.WORKING ? /working…/ : /queued/);
		if (state !== PROMPT_STATE.IDLE) assert.doesNotMatch(stripAnsi(rows[0]), /waiting for input/);
	}
	const neon = framePromptLines(["──", "draft", "──"], 80, options({ style: "neon", state: PROMPT_STATE.IDLE, fg: (_c, t) => t }));
	assert.doesNotMatch(stripAnsi(neon[0]), /waiting for input/);
});

test("T2 float prompt rearms real SGR resets without altering inversion or marker bytes", () => {
	for (const open of ["\x1b[44m", "\x1b[48;5;24m", "\x1b[48;2;0;30;0m"]) {
		const marker = "\x1b_pi:c\x07";
		const native = `${marker}\x1b[7mx\x1b[0mY\x1b[0;7mZ\x1b[27m`;
		const rows = framePromptLines(["──", native, "──"], 30, options({ style: "float", bg: (_r, t) => `${open}${t}\x1b[49m`, fg: (_c, t) => t }));
		assert.ok(rows[1].includes(`${marker}\x1b[7mx\x1b[0m${open}Y\x1b[0;7m${open}Z\x1b[27m`));
	}
});

// C3: with the rail hidden, the top border carries a clickable
// `≡ commands · key` label one cell after the petal. ≡ is one cell wide.

test("neon top border shows the commands label with one cell around petal and icon", () => {
	const chrome = framePromptChrome(editorLines(60), 60, options({ fg: (_role, text) => text, commandsLabel: { hint: "alt+k" } }));
	const top = stripAnsi(chrome.lines[0]!);
	assert.equal(top, "╭─ ✿ ≡ commands · alt+k " + "─".repeat(60 - 24 - 1) + "╮");
	assert.equal(visibleWidth(top), 60);
	assert.deepEqual(chrome.commandsSpan, { start: 5, end: 15 }, "only the icon and name are clickable, not the key hint");
	assert.equal(top.slice(0, 5), "╭─ ✿ ");
});

test("neon commands label honors a remapped key, no hint when disabled, and stays absent by default", () => {
	const plain = { fg: (_role: string, text: string) => text };
	assert.match(stripAnsi(framePromptLines(editorLines(60), 60, options({ ...plain, commandsLabel: { hint: "ctrl+p" } }))[0]!), /^╭─ ✿ ≡ commands · ctrl\+p ─+╮$/);
	const off = framePromptChrome(editorLines(60), 60, options({ ...plain, commandsLabel: {} }));
	assert.match(stripAnsi(off.lines[0]!), /^╭─ ✿ ≡ commands ─+╮$/);
	assert.deepEqual(off.commandsSpan, { start: 5, end: 15 });
	const absent = framePromptChrome(editorLines(60), 60, options(plain));
	assert.equal(absent.commandsSpan, undefined);
	assert.doesNotMatch(stripAnsi(absent.lines[0]!), /commands/);
});

test("neon commands label keeps working/queued labels and scroll indicators after it", () => {
	const plain = { fg: (_role: string, text: string) => text, commandsLabel: { hint: "alt+k" } };
	const working = framePromptChrome(editorLines(70), 70, options({ ...plain, state: PROMPT_STATE.WORKING }));
	assert.match(stripAnsi(working.lines[0]!), /^╭─ [✿❀❁✾] ≡ commands · alt\+k · working… ─+╮$/);
	assert.deepEqual(working.commandsSpan, { start: 5, end: 15 });
	const lines = editorLines(70);
	lines[0] = "─── ↑ 3 more ───";
	assert.match(stripAnsi(framePromptLines(lines, 70, options(plain))[0]!), /^╭─ ✿ ≡ commands · alt\+k · ↑ 3 more ─+╮$/);
});

test("neon commands label is dropped when it cannot fit, never truncated", () => {
	for (const width of [2, 10, 20, 25]) {
		const chrome = framePromptChrome(editorLines(Math.max(4, width)), width, options({ fg: (_role, text) => text, commandsLabel: { hint: "alt+k" } }));
		assert.equal(chrome.commandsSpan, undefined, `width ${width}`);
		assert.ok(chrome.lines.every((line) => visibleWidth(line) <= width));
	}
	const fits = framePromptChrome(editorLines(26), 26, options({ fg: (_role, text) => text, commandsLabel: { hint: "alt+k" } }));
	assert.deepEqual(fits.commandsSpan, { start: 5, end: 15 });
	assert.equal(visibleWidth(fits.lines[0]!), 26);
});

test("float hint row carries the same label at the same columns", () => {
	const bg = (_role: string, text: string) => `\x1b[44m${text}\x1b[49m`;
	const chrome = framePromptChrome(editorLines(55), 60, options({ style: "float", bg, fg: (_role, text) => text, commandsLabel: { hint: "alt+k" } }));
	const hint = stripAnsi(chrome.lines[0]!);
	assert.match(hint, /^ ▎ ✿ ≡ commands · alt\+k · waiting for input\s*$/);
	assert.equal(visibleWidth(chrome.lines[0]!), 60);
	assert.deepEqual(chrome.commandsSpan, { start: 5, end: 15 });
	assert.equal(hint.indexOf("≡"), 5);
	const absent = framePromptChrome(editorLines(55), 60, options({ style: "float", bg, fg: (_role, text) => text }));
	assert.equal(absent.commandsSpan, undefined);
	assert.doesNotMatch(stripAnsi(absent.lines[0]!), /commands/);
});
