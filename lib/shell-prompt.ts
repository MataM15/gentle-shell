import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "./terminal-theme.ts";
import { CARD_STYLE, type CardStyle } from "./shell-card.ts";

// Pure prompt chrome: neon keeps Pi's rule/content/rule rows in a rounded
// frame; float retains those indices as painted status/content/padding.

export const PROMPT_STATE = {
	IDLE: "idle",
	WORKING: "working",
	QUEUED: "queued",
} as const;

export type PromptState = (typeof PROMPT_STATE)[keyof typeof PROMPT_STATE];

const PETAL_TONE = {
	BRIGHT: "borderAccent",
	ROSE: "accent",
	SOFT: "thinkingHigh",
	DEEP: "mdQuoteBorder",
	WARNING: "warning",
} as const;

export type PetalTone = (typeof PETAL_TONE)[keyof typeof PETAL_TONE];

// Keep Pi's original loader cadence while carrying the banner's reflected-light
// language into the compact working labels. The highlight enters before the
// word, crosses it as a soft symmetric wave, then exits before wrapping.
export const SHELL_PULSE_MS = 80;
export const SHELL_SCANNER_STEPS = 15;
const SCANNER_ENTRY_OFFSET = 3;

/** Banner-style reflected-light wave across text; foreground only. */
export function scanWorkingText(text: string, tick: number, fg: (role: string, text: string) => string): string {
	const phase = ((Math.floor(tick) % SHELL_SCANNER_STEPS) + SHELL_SCANNER_STEPS) % SHELL_SCANNER_STEPS;
	const head = phase - SCANNER_ENTRY_OFFSET;
	return Array.from(text, (char, index) => {
		const distance = Math.abs(head - index);
		const role = distance === 0 ? "borderAccent" : distance === 1 ? "accent" : distance === 2 ? "thinkingHigh" : "muted";
		return fg(role, char);
	}).join("");
}
const PETAL_TONE_FRAMES = [PETAL_TONE.DEEP, PETAL_TONE.SOFT, PETAL_TONE.ROSE, PETAL_TONE.BRIGHT, PETAL_TONE.ROSE, PETAL_TONE.SOFT, PETAL_TONE.DEEP, PETAL_TONE.DEEP] as const;

export interface PromptFrameOptions {
	style?: CardStyle;
	bg?: (role: string, text: string) => string;
	state: PromptState;
	tick: number;
	borderColor: (text: string) => string;
	fg: (color: string, text: string) => string;
	bold?: (text: string) => string;
	/**
	 * Overrides the editor's own bottom scroll indicator (e.g. "esc again to
	 * cancel"). Both share the bottom rule / float hint slot; an explicit
	 * hint always wins because it reflects state the editor cannot render on
	 * its own.
	 */
	escHint?: string;
	/**
	 * Overrides the generic "working…" label while state is WORKING with an
	 * explicit, orchestrator-reported ODD phase label (e.g. "exploring…").
	 * Ignored outside the WORKING state; undefined falls back to "working…".
	 */
	workingLabel?: string;
	/**
	 * Present only while the right rail (and its `≡ commands` card row) is not
	 * visible: paints `≡ commands · key` after the petal. `hint` is the resolved
	 * shortcut; absent means the shortcut is disabled and no key is shown.
	 */
	commandsLabel?: { hint?: string };
	/**
	 * Present only while the user folded the rail away and it could show:
	 * paints `« panel · key` at the right end of the top border (float: of the
	 * hint row). `hint` is the resolved shortcut; absent when it is disabled.
	 */
	panelLabel?: { hint?: string };
}

/** Columns of the clickable commands label on row 0 of the framed prompt. */
export interface PromptLabelSpan {
	start: number;
	end: number;
}

export interface PromptChrome {
	lines: string[];
	/** Where the commands label sits on row 0; undefined when it is absent or did not fit. */
	commandsSpan?: PromptLabelSpan;
	/** Where `« panel` sits on row 0; undefined when it is absent or did not fit. */
	panelSpan?: PromptLabelSpan;
}

// A terminal cell cannot grow, so the petal earns presence with weight and
// the brightest rose in the theme. Working spins through four flowers.
export const PROMPT_PETAL = "✿";
const PETAL_FRAMES = ["✿", "❀", "❁", "✾"] as const;
export const PROMPT_HINT = "type, or / for commands";
export const DOUBLE_ESC_CANCEL_HINT = "esc again to cancel";
export const IDLE_ESC_CLEAR_HINT = "esc again to clear";
const LABEL_ROLE = "muted";
const HINT_ROLE = "dim";
const COMMANDS_ICON = "≡";
const COMMANDS_NAME = "commands";
const COMMANDS_LABEL_ROLE = "accent";
const COMMANDS_SEPARATOR = " · ";
const FAKE_CURSOR = "\x1b[7m \x1b[0m";
const SCROLL_INDICATOR = /[↑↓] \d+ more/;
const STATE_LABEL: Record<PromptState, string | undefined> = {
	[PROMPT_STATE.IDLE]: undefined,
	[PROMPT_STATE.WORKING]: "working…",
	[PROMPT_STATE.QUEUED]: "queued",
};

export function petalTone(state: PromptState, tick: number): PetalTone {
	if (state === PROMPT_STATE.QUEUED) return PETAL_TONE.WARNING;
	if (state === PROMPT_STATE.WORKING) return PETAL_TONE_FRAMES[tick % PETAL_TONE_FRAMES.length];
	return PETAL_TONE.BRIGHT;
}

export function petalGlyph(state: PromptState, tick: number): string {
	if (state === PROMPT_STATE.IDLE) return PROMPT_PETAL;
	return PETAL_FRAMES[tick % PETAL_FRAMES.length];
}

function scrollIndicator(rule: string): string | undefined {
	return stripAnsi(rule).match(SCROLL_INDICATOR)?.[0];
}

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function stateLabel(options: PromptFrameOptions): string | undefined {
	if (options.state === PROMPT_STATE.WORKING) return options.workingLabel ?? STATE_LABEL[PROMPT_STATE.WORKING];
	return STATE_LABEL[options.state];
}

// Widths always come from visibleWidth; ≡ is one cell, like every glyph here.
// Only the icon and name are clickable (nameWidth); the key hint is not.
function commandsLabel(options: PromptFrameOptions): { text: string; width: number; nameWidth: number } | undefined {
	const spec = options.commandsLabel;
	if (!spec) return undefined;
	const name = `${COMMANDS_ICON} ${COMMANDS_NAME}`;
	const hint = spec.hint ? COMMANDS_SEPARATOR + spec.hint : "";
	return { text: options.fg(COMMANDS_LABEL_ROLE, name) + (hint ? options.fg(HINT_ROLE, hint) : ""), width: visibleWidth(name + hint), nameWidth: visibleWidth(name) };
}

const PANEL_NAME = "« panel";

// `« panel · key`: the arrow and word in the commands-label role, the key dim.
function panelLabel(options: PromptFrameOptions): { text: string; width: number; nameWidth: number } | undefined {
	const spec = options.panelLabel;
	if (!spec) return undefined;
	const hint = spec.hint ? COMMANDS_SEPARATOR + spec.hint : "";
	return { text: options.fg(COMMANDS_LABEL_ROLE, PANEL_NAME) + (hint ? options.fg(HINT_ROLE, hint) : ""), width: visibleWidth(PANEL_NAME + hint), nameWidth: visibleWidth(PANEL_NAME) };
}

// The top rule's tail after `fill` rule cells: plain `─…─╮`, or with room,
// `─…─ « panel · key ─╮` and where `« panel` landed. Dropped whole when the
// rule would lose its last cell before the label.
function closeTopRule(width: number, fill: number, options: PromptFrameOptions): { tail: string; span?: PromptLabelSpan } {
	const panel = panelLabel(options);
	if (panel && fill - panel.width - 3 >= 1) {
		const start = width - 3 - panel.width;
		return { tail: options.borderColor(` ${rule(fill - panel.width - 3)} `) + panel.text + options.borderColor(" ─╮"), span: { start, end: start + panel.nameWidth } };
	}
	return { tail: options.borderColor(` ${rule(fill)}╮`) };
}

function topRule(width: number, options: PromptFrameOptions, indicator: string | undefined): { line: string; span?: PromptLabelSpan; panelSpan?: PromptLabelSpan } {
	const label = indicator ?? stateLabel(options);
	const scanning = options.state === PROMPT_STATE.WORKING;
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const paintedLabel = label && scanning && !indicator ? scanWorkingText(label, options.tick, options.fg) : label ? options.fg(LABEL_ROLE, label) : "";
	const commands = commandsLabel(options);
	const glyphWidth = visibleWidth(glyph);
	if (commands) {
		// Petal, icon, and label each sit one cell apart; the rule resumes one
		// cell after the last label. Without room for at least one rule cell the
		// label is dropped rather than truncated.
		const titleWidth = glyphWidth + 1 + commands.width + (label ? COMMANDS_SEPARATOR.length + visibleWidth(label) : 0);
		const fill = width - titleWidth - 5;
		if (fill >= 1) {
			const title = petal + " " + commands.text + (paintedLabel ? options.fg(HINT_ROLE, COMMANDS_SEPARATOR) + paintedLabel : "");
			const start = 3 + glyphWidth + 1;
			const close = closeTopRule(width, fill, options);
			return { line: options.borderColor("╭─ ") + title + close.tail, span: { start, end: start + commands.nameWidth }, panelSpan: close.span };
		}
	}
	const title = [petal, paintedLabel].filter(Boolean).join(" ");
	const titleWidth = glyphWidth + (label ? visibleWidth(label) + (glyph ? 1 : 0) : 0);
	const fill = width - titleWidth - 5;
	if (fill < 0) return { line: options.borderColor(`╭${rule(width - 2)}╮`) };
	const close = closeTopRule(width, fill, options);
	return { line: options.borderColor("╭─ ") + title + close.tail, panelSpan: close.span };
}

function bottomRule(width: number, options: PromptFrameOptions, indicator: string | undefined): string {
	if (!indicator) return options.borderColor(`╰${rule(width - 2)}╯`);
	const fill = width - 3 - indicator.length - 1 - 1;
	if (fill < 0) return options.borderColor(`╰${rule(width - 2)}╯`);
	return options.borderColor("╰─ ") + options.fg(LABEL_ROLE, indicator) + options.borderColor(` ${rule(fill)}╯`);
}

function sideRules(line: string, innerWidth: number, options: PromptFrameOptions): string {
	const clipped = innerWidth === 0 ? "" : truncateToWidth(line, innerWidth, "");
	const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const content = clipped + padding;
	return options.borderColor("│") + content + options.borderColor("│");
}

export interface PromptLayout {
	width: number;
	nativeWidth: number;
	prefixWidth: number;
	background: string;
}

/** Resolve fallback before native wrapping, selection, completion and mouse geometry. */
export function resolvePromptLayout(width: number, style?: CardStyle, bg?: PromptFrameOptions["bg"]): PromptLayout {
	width = Math.max(0, Math.floor(width));
	let background = "";
	if (style === CARD_STYLE.FLOAT && width >= 10 && bg) {
		try {
			const painted = bg("toolSuccessBg", " ");
			const match = painted.match(/^((?:\x1b\[[\d;]*m)+) (?:\x1b\[(?:49|0)?m)$/);
			if (match) {
				for (const sgr of match[1].matchAll(/\x1b\[([\d;]*)m/g)) {
					for (const command of promptSgrCommands(sgr[1])) {
						const code = command[0];
						if (code === 0 || code === 49) background = "";
						else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) ||
							(code === 48 && ((command[1] === 5 && command.length === 3) || (command[1] === 2 && command.length === 5)))) {
							background = `\x1b[${command.join(";")}m`;
						}
					}
				}
			}
		} catch { /* Missing theme background: retain the entire neon path. */ }
	}
	return { width, nativeWidth: Math.max(1, width - (background ? 5 : 2)), prefixWidth: background ? 3 : 1, background };
}

// Extended-colour parameters belong to one command: zero RGB channels
// must never be interpreted as full styling resets.
function promptSgrCommands(parameters: string): number[][] {
	const codes = parameters.split(";").map(Number);
	const commands: number[][] = [];
	for (let i = 0; i < codes.length;) {
		const extended = codes[i] === 38 || codes[i] === 48 || codes[i] === 58;
		const length = extended && codes[i + 1] === 2 ? 5 : extended && codes[i + 1] === 5 ? 3 : 1;
		commands.push(codes.slice(i, i + length));
		i += length;
	}
	return commands;
}

// Rearm only the panel background, leaving marker/inversion bytes intact.
function rearmPromptBackground(text: string, background: string): string {
	return text.replace(/\x1b\[([\d;]*)m/g, (sgr, parameters: string) =>
		promptSgrCommands(parameters).some(([code]) => code === 0 || code === 49) ? sgr + background : sgr);
}

/** Same chrome and horizontal prefix for editable and native completion rows. */
export function floatPromptRow(line: string, layout: PromptLayout, borderColor: PromptFrameOptions["borderColor"]): string {
	const clipped = truncateToWidth(line, layout.nativeWidth, "");
	const content = borderColor("▎") + " " + clipped + " ".repeat(Math.max(0, layout.nativeWidth - visibleWidth(clipped))) + " ";
	return " " + layout.background + rearmPromptBackground(content, layout.background) + "\x1b[49m ";
}

function floatPromptHint(top: string, bottom: string, options: PromptFrameOptions, width: number): { text: string; span?: PromptLabelSpan; panelSpan?: PromptLabelSpan } {
	const glyph = petalGlyph(options.state, options.tick);
	const petal = options.fg(petalTone(options.state, options.tick), options.bold ? options.bold(glyph) : glyph);
	const label = stateLabel(options) ?? "waiting for input";
	let paintedLabel = "";
	if (label) {
		paintedLabel = options.state === PROMPT_STATE.WORKING
			? scanWorkingText(label, options.tick, options.fg)
			: options.fg(LABEL_ROLE, label);
	}
	const info = [scrollIndicator(top), options.escHint ?? scrollIndicator(bottom)]
		.filter((text): text is string => Boolean(text))
		.map((text) => options.fg(LABEL_ROLE, text));
	const tail = (separator: string) => (paintedLabel ? separator + paintedLabel : "") + (info.length ? " · " + info.join(" · ") : "");
	// The label must end inside `width` (lead included); otherwise it is dropped whole.
	const commands = commandsLabel(options);
	const glyphWidth = visibleWidth(glyph);
	const leadWidth = 2 + glyphWidth + 1;
	let text = "  " + petal + tail(" ");
	let span: PromptLabelSpan | undefined;
	if (commands && leadWidth + commands.width <= width) {
		text = "  " + petal + " " + commands.text + tail(options.fg(HINT_ROLE, COMMANDS_SEPARATOR));
		// Columns on the painted row: " ▎ " precedes the stripped content.
		const start = 3 + glyphWidth + 1;
		span = { start, end: start + commands.nameWidth };
	}
	const hint = truncateToWidth(text, width, "");
	// `« panel · key` right-aligned with one cell to spare, only past a gap.
	const panel = panelLabel(options);
	if (panel && visibleWidth(hint) + 2 + panel.width + 1 <= width) {
		const gap = width - visibleWidth(hint) - panel.width - 1;
		// Painted columns run one ahead of this content (" ▎ " vs "  ").
		const start = width - 1 - panel.width + 1;
		return { text: hint + " ".repeat(gap) + panel.text + " ", span, panelSpan: { start, end: start + panel.nameWidth } };
	}
	return { text: hint + " ".repeat(Math.max(0, width - visibleWidth(hint))), span };
}

export function framePromptLines(lines: string[], width: number, options: PromptFrameOptions, layout = resolvePromptLayout(width, options.style, options.bg)): string[] {
	return framePromptChrome(lines, width, options, layout).lines;
}

/** Same frame as framePromptLines, plus where the commands label landed on row 0. */
export function framePromptChrome(lines: string[], width: number, options: PromptFrameOptions, layout = resolvePromptLayout(width, options.style, options.bg)): PromptChrome {
	width = Math.max(0, Math.floor(width));
	if (layout.background && lines.length >= 2) {
		const hint = floatPromptHint(lines[0], lines[lines.length - 1], options, layout.nativeWidth);
		return {
			lines: [
				floatPromptRow(hint.text.slice(2), layout, options.borderColor),
				...lines.slice(1, -1).map((line) => floatPromptRow(line, layout, options.borderColor)),
				floatPromptRow("", layout, options.borderColor),
			],
			commandsSpan: hint.span,
			panelSpan: hint.panelSpan,
		};
	}
	if (lines.length < 2) return { lines: lines.map((line) => truncateToWidth(line, width, "")) };
	if (width < 2) return { lines: lines.map((_line, index) => width === 0 ? "" : options.borderColor(index === 0 ? "╭" : index === lines.length - 1 ? "╰" : "│")) };
	const innerWidth = width - 2;
	const top = lines[0];
	const bottom = lines[lines.length - 1];
	const content = lines.slice(1, -1).map((line) => sideRules(line, innerWidth, options));
	const head = topRule(width, options, scrollIndicator(top));
	return { lines: [head.line, ...content, bottomRule(width, options, options.escHint ?? scrollIndicator(bottom))], commandsSpan: head.span, panelSpan: head.panelSpan };
}

export function withPromptHint(line: string, hint: string, fg: PromptFrameOptions["fg"]): string {
	const cursorAt = line.indexOf(FAKE_CURSOR);
	if (cursorAt === -1) return line;
	const afterCursor = cursorAt + FAKE_CURSOR.length;
	const trailing = line.slice(afterCursor);
	if (trailing.trim() !== "" || trailing.length < hint.length + 1) return line;
	return `${line.slice(0, afterCursor)} ${fg(HINT_ROLE, hint)}${" ".repeat(trailing.length - hint.length - 1)}`;
}
