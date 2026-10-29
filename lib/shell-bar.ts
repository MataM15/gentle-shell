import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { GAUGE_CELLS, gaugeTone, paintGauge, renderGauge, type GaugePaint, type GaugeTone } from "./shell-gauge.ts";
import { renderUsageBar, selectUsageLimit, type ProviderUsage, type UsageWindow } from "./shell-usage.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import { CARD_TONE, floatRows, panelInnerWidth, renderCard } from "./shell-card.ts";
import { REVIEW_SCOPE_UNAVAILABLE, REVIEW_SIDEBAR_LABELS, type ReviewSidebarSnapshot } from "./review-sidebar-state.ts";
import type { VisualSettings } from "./visual-customization-policy.ts";
import { renderChangesWidget, type ChangesModel } from "./shell-changes.ts";
import type { RunningJobDisplay } from "./jobs-sidebar-state.ts";
import { JOB_GLYPH } from "./background-jobs-tools.ts";

type Presentation = Pick<VisualSettings, "density" | "visibility">;
type HeaderPresentation = Presentation & Partial<Pick<VisualSettings, "headerPlacement" | "statusPlacement">>;

export { gaugeTone, renderGauge, type GaugeTone };

// Gentle Shell status bar: one line of segments that replaces pi's built-in
// three-line footer. Everything here is pure so the bar can be rendered and
// verified without a live TUI.

export interface ShellBarModel {
	review?: ReviewSidebarSnapshot;
	jobs?: RunningJobDisplay[];
	profile?: string;
	changes?: { files: number; added: number; deleted: number };
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	sessionName: string | undefined;
	modelId: string;
	effort: string | undefined;
	contextPercent: number | null;
	contextWindow: number;
	costTotal: number;
	subscription: boolean;
	usage: ProviderUsage | undefined;
	statuses: string[];
	// Short id of the active dev-binary override; set only while it is active.
	devBinary?: string;
}

// The live header row above the fullscreen rail: session identity plus the
// live counters. Only the structured jobs count may join context/cost when
// Status is absent; opaque extension statuses and working state stay excluded.
export interface ShellHeaderModel {
	jobs?: number;
	cwd: string;
	branch: string | null;
	dirty: number | undefined;
	modelId: string;
	effort: string | undefined;
	profile?: string;
	contextPercent: number | null;
	costTotal: number;
	subscription: boolean;
	// The active provider's subscription usage, shown as its own segment after
	// cost. Unlike the sidebar's old per-model usage table, this is one
	// compact line — the same windows the compact bar already meters.
	usage: ProviderUsage | undefined;
}

export function buildShellHeaderModel(model: ShellBarModel, showJobs = false): ShellHeaderModel {
	const { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage } = model;
	return { cwd, branch, dirty, modelId, effort, profile, contextPercent, costTotal, subscription, usage,
		...(showJobs && model.jobs?.length ? { jobs: model.jobs.length } : {}) };
}

export function shellJobsCount(count: number): string {
	return `${JOB_GLYPH} ${count} job${count === 1 ? "" : "s"}`;
}

/** A column span (`[start, end)`, in the rendered line's visible columns) a click must land in to hit the usage segment. */
export interface HeaderUsageSpan {
	start: number;
	end: number;
}

export interface ShellHeaderResult {
	text: string;
	usageSpan?: HeaderUsageSpan;
}

export interface ShellHeaderChrome {
	rows: string[];
	headerRow: number;
	usageSpan?: HeaderUsageSpan;
	/** Rail only: the `≡ commands` action row and its hit span (the palette opener). */
	commandsRow?: number;
	commandsSpan?: HeaderUsageSpan;
}

export interface ShellBarTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

// Theme roles the bar paints with. Keys are pi theme colors; the Gentle themes
// map them to the rose palette (accent = rose, syntaxFunction = powder blue).
const ROLE = {
	BRAND: "accent",
	SEPARATOR: "dim",
	PATH: "muted",
	BRANCH: "text",
	DIRTY: "warning",
	MODEL: "text",
	EFFORT: "syntaxFunction",
	LABEL: "muted",
	// Row keys sit a step below the values they introduce.
	KEY: "dim",
	VALUE: "text",
	STATUS: "muted",
	SESSION: "dim",
} as const;

export const SHELL_BAR_BRAND = "  gentle shell";
export const SHELL_BAR_SEPARATOR = "⟡";
export const SHELL_BAR_GAUGE_CELLS = GAUGE_CELLS;
const RIGHT_PADDING = 2;
const COMPACT_BRANCH_WIDTH = 15;

export function shellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.GENTLE_PI_AGENTS_CHILD === "1") return false;
	const value = env.GENTLE_PI_SHELL?.trim().toLowerCase();
	return !(value === "0" || value === "false" || value === "off");
}

// Herdr's native Pi detection matches Pi's standard loader row ("⠋ Working...").
// Inside a Herdr pane keep that row, which Pi shows only during real activity,
// so detection works without a local manifest override.
export function keepNativeWorkingRow(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && env.GENTLE_PI_AGENTS_CHILD !== "1";
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatCost(total: number, subscription = false): string {
	const amount = total >= 1 ? total.toFixed(2) : total.toFixed(3);
	return subscription ? `$${amount} sub` : `$${amount}`;
}

// Extensions may paint their status themselves (pi-mcp-adapter does); the bar
// owns the palette, so their escapes go and the text takes the status role.
function sanitizeStatus(text: string): string {
	return sanitizeTerminalText(text.replace(/[\r\n\t]/g, " ")).replace(/ +/g, " ").trim();
}

// Shared by the compact bar, the sidebar Status card, and the fullscreen
// header row, so the three surfaces never drift on how they paint the same
// facts.
function locationSegment(model: Pick<ShellBarModel, "cwd" | "branch" | "dirty">, theme: ShellBarTheme): string {
	const dirty = model.dirty ? ` ${theme.fg(ROLE.DIRTY, `±${model.dirty}`)}` : "";
	return model.branch
		? `${theme.fg(ROLE.PATH, model.cwd)} ${theme.fg(ROLE.BRANCH, model.branch)}${dirty}`
		: theme.fg(ROLE.PATH, model.cwd) + dirty;
}

function executionSegment(modelId: string, effort: string | undefined, theme: ShellBarTheme): string {
	return effort
		? `${theme.fg(ROLE.MODEL, modelId)} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.EFFORT, effort)}`
		: theme.fg(ROLE.MODEL, modelId);
}

function contextSegment(contextPercent: number | null, theme: ShellBarTheme, paint?: GaugePaint): string {
	const percentText = contextPercent === null ? "?%" : `${Math.round(contextPercent)}%`;
	return `${theme.fg(ROLE.LABEL, "ctx")} ${paintGauge(contextPercent, theme, GAUGE_CELLS, paint)} ${theme.fg(ROLE.VALUE, percentText)}`;
}

function costSegment(costTotal: number, subscription: boolean, theme: ShellBarTheme): string {
	return theme.fg(ROLE.VALUE, formatCost(costTotal, subscription));
}

function buildSegments(model: ShellBarModel, theme: ShellBarTheme, presentation?: Presentation, paint?: GaugePaint): string[] {
	const location = locationSegment(model, theme);
	const modelSegment = executionSegment(model.modelId, model.effort, theme);
	const context = contextSegment(model.contextPercent, theme, paint);
	const cost = costSegment(model.costTotal, model.subscription, theme);
	const usage = model.usage ? renderUsageBar(model.usage, theme, model.modelId, paint) : undefined;
	const statuses = model.statuses.map((status) => theme.fg(ROLE.STATUS, sanitizeStatus(status)));
	return [
		...(presentation?.density === "minimal" ? [] : [theme.fg(ROLE.BRAND, SHELL_BAR_BRAND)]),
		location,
		...(presentation?.visibility.modelDetails === false ? [] : [modelSegment]),
		...(presentation?.visibility.usageCost === false ? [] : [context, cost, ...(usage ? [usage] : [])]),
		...(model.jobs?.length ? [theme.fg(ROLE.STATUS, shellJobsCount(model.jobs.length))] : []),
		...statuses,
	];
}

// When the line overflows, the location gives way first: the path shrinks to
// its last segment and a long branch is clipped, so the trailing statuses
// (MCP servers, extension notices) survive on ordinary terminal widths.
function compactModel(model: ShellBarModel): ShellBarModel {
	const cwd = model.cwd.split("/").filter((part) => part.length > 0).pop() ?? model.cwd;
	const branch = model.branch && visibleWidth(model.branch) > COMPACT_BRANCH_WIDTH ? clipText(model.branch, COMPACT_BRANCH_WIDTH) : model.branch;
	return { ...model, cwd, branch };
}

// Plain clip: pi's truncateToWidth wraps the result in resets, which would end
// up inside a painted segment.
function clipText(text: string, max: number): string {
	let clipped = "";
	for (const char of text) {
		if (visibleWidth(clipped + char) > max - 1) break;
		clipped += char;
	}
	return `${clipped}…`;
}

function joinSegments(segments: string[], theme: ShellBarTheme): string {
	return segments.join(` ${theme.fg(ROLE.SEPARATOR, SHELL_BAR_SEPARATOR)} `);
}

const DEV_BINARY_SHORT_ID_LENGTH = 7;
const COMMIT_DIRECTORY = /^[0-9a-f]{40}$/i;

/** The 7-char commit from a 40-hex directory in the override path, else the digest's first 7 chars. */
export function devBinaryShortId(path: string, sha256: string): string {
	const commit = path.split(/[\\/]/).find((part) => COMMIT_DIRECTORY.test(part));
	return (commit ?? sha256).slice(0, DEV_BINARY_SHORT_ID_LENGTH).toLowerCase();
}

// A Status row: a short key and a value. `values` lists the same fact from
// widest to narrowest; the first that fits the line wins and the last one is
// truncated, so a value never wraps mid-phrase.
interface StatusRow {
	key: string;
	values: string[];
}

const STATUS_KEY_MAX = 8;
const STATUS_KEY_GAP = 2;
const STATUS_YOLO = /YOLO ON\b.*destructive confirmations remain/i;
const STATUS_PERMISSIONS = /^Permissions:\s*(.+)$/i;
const STATUS_MEMORY = /^\u{1F9E0}\s*(.+)$/u;

// Opaque extension statuses carry no structure, so only the shapes the shell
// itself publishes get a key and a shorter wording; anything else keeps its
// text under a generic key.
function statusRow(status: string): StatusRow {
	if (STATUS_YOLO.test(status)) return { key: "YOLO", values: ["on · confirm destructive", "on"] };
	const permissions = STATUS_PERMISSIONS.exec(status);
	if (permissions) return { key: "Perms", values: [permissions[1]!] };
	const memory = STATUS_MEMORY.exec(status);
	if (memory) return { key: "Memory", values: [memory[1]!] };
	return { key: "Info", values: [status] };
}

// Sidebar groups use structured fields, never positional compact-bar segments
// or inferred meanings from opaque extension status strings.
export function renderShellSidebarBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation): string[] {
	// Values read at normal weight; only the two identity facts stay strong.
	const value = (text: string) => theme.fg(ROLE.VALUE, text);
	const strong = (text: string) => theme.fg(ROLE.VALUE, theme.bold(text));
	const label = (text: string) => theme.fg(ROLE.LABEL, text);
	const dimmed = (text: string) => theme.fg(ROLE.KEY, text);
	const changes = model.changes;
	// Rows are fitted to one line before they reach the card: the key column is
	// shared by every group, so the values line up down the whole card.
	const innerWidth = panelInnerWidth(theme, width);
	const inset = Math.min(1, innerWidth - 1);
	// Model, effort, context, cost, and the per-model usage table now live in
	// the always-visible header row (and /gentle:usage for the full table);
	// this event-driven card keeps only what a footer/model-switch event does
	// not already refresh every frame.
	const plain = (text: string) => [text];
	const integrations: Array<{ key: string; values: string[]; paint: (text: string) => string }> = [
		...model.statuses.map((status) => ({ ...statusRow(sanitizeStatus(status)), paint: (text: string) => theme.fg(ROLE.STATUS, text) })),
		...(model.devBinary ? [{
			key: "Build",
			values: [`gentle-ai dev · ${sanitizeStatus(model.devBinary)} · field-test`, `dev · ${sanitizeStatus(model.devBinary)} · field-test`],
			paint: (text: string) => theme.fg("warning", text),
		}] : []),
	];
	type Row = { key: string; values: string[]; paint: (text: string) => string };
	const row = (key: string, text: string | string[], paint: (text: string) => string = value): Row => ({ key, values: typeof text === "string" ? plain(text) : text, paint });
	const groups: Array<{ title: string; rows: Row[] }> = [
		{
			// Location block: where this session runs and what it changed, in one
			// block instead of one row group per fact.
			title: "Project",
			rows: [
				row("Path", model.cwd),
				...(model.branch ? [row("Branch", model.branch, strong)] : []),
				...(model.sessionName ? [row("Session", model.sessionName)] : []),
				...(model.profile ? [row("Profile", sanitizeStatus(model.profile), strong)] : []),
				...(presentation?.visibility.changes === false ? [] : [
					changes?.files
						? { key: "Changes", values: [`${changes.files} ${changes.files === 1 ? "file" : "files"} · ${theme.fg("success", `+${changes.added}`)} ${theme.fg("error", `−${changes.deleted}`)}`], paint: (text: string) => text }
						: row("Changes", "No captured changes", label),
					row("", "/gentle:changes", label),
				]),
			],
		},
		...(model.review && presentation?.visibility.rdd !== false ? [{
			title: "   RDD",
			rows: [
				row("State", REVIEW_SIDEBAR_LABELS[model.review.state]),
				// Unknown scope is an internal sentinel, not something the user acts on.
				...(model.review.scope !== REVIEW_SCOPE_UNAVAILABLE ? [row("Scope", sanitizeStatus(model.review.scope), label)] : []),
			],
		}] : []),
		// Running jobs live in their own sidebar card (extensions/gentle-shell.ts
		// registers the "jobs" rail part); the compact bar keeps the count.
		{ title: "Integrations", rows: integrations.length ? integrations : [row("", "No status reported", label)] },
	];
	const keyWidth = Math.min(STATUS_KEY_MAX, groups.reduce((widest, group) => group.rows.reduce((inner, entry) => Math.max(inner, visibleWidth(entry.key)), widest), 0));
	const valueRoom = Math.max(1, innerWidth - inset - keyWidth - (keyWidth > 0 ? STATUS_KEY_GAP : 0));
	const fit = (entry: Row) => {
		const fitting = entry.values.find((candidate) => visibleWidth(candidate) <= valueRoom);
		return fitting !== undefined ? entry.paint(fitting) : entry.paint(truncateToWidth(entry.values[entry.values.length - 1]!, valueRoom, "…"));
	};
	const key = (entry: Row) => dimmed(truncateToWidth(entry.key, keyWidth, "…", true)) + " ".repeat(keyWidth > 0 ? STATUS_KEY_GAP : 0);
	const body = groups.flatMap((group, index) => [
		...(index && (!presentation || presentation.density === "comfortable") ? [""] : []),
		...(presentation?.density === "minimal" ? [] : [label(group.title)]),
		...group.rows.map((entry) => " ".repeat(inset) + key(entry) + fit(entry)),
	]);
	return renderCard({ title: "Status", body, tone: CARD_TONE.INFO, rail: true }, theme, width, { expanded: true, panel: true });
}

const HEADER_BRAND = "  Gentle Shell";

// Narrower than the width, widest first: dropping the profile, then the
// effort, then the whole location keeps the brand and the bare model id
// alive as long as anything can still share the row with the right-aligned
// counters.
function headerLeftStages(model: ShellHeaderModel, theme: ShellBarTheme, showModelDetails: boolean): string[][] {
	const brand = theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	const location = locationSegment(model, theme);
	if (!showModelDetails) return [[brand, location], [brand]];
	const withEffort = executionSegment(model.modelId, model.effort, theme);
	const modelOnly = executionSegment(model.modelId, undefined, theme);
	const withProfile = model.profile ? `${withEffort} ${theme.fg(ROLE.LABEL, "·")} ${theme.fg(ROLE.MODEL, sanitizeStatus(model.profile))}` : withEffort;
	return [
		[brand, location, withProfile],
		[brand, location, withEffort],
		[brand, location, modelOnly],
		[brand, modelOnly],
		[brand],
	];
}

// The bar's usage segment reads like the rail's usage action row: the same
// one-cell icon and rose label, then its windows, then the dim key hint.
const USAGE_LABEL_ROLE = "borderAccent";
const USAGE_HINT_ROLE = "dim";

function usageWindowText(window: UsageWindow, theme: ShellBarTheme, withGauge: boolean, paint?: GaugePaint): string {
	const percent = `${Math.round(window.usedPercent)}%`;
	const parts = [
		...(window.label.length > 0 ? [theme.fg(ROLE.LABEL, window.label)] : []),
		...(withGauge ? [paintGauge(window.usedPercent, theme, GAUGE_CELLS, paint)] : []),
		theme.fg(ROLE.VALUE, percent),
	];
	return parts.join(" ");
}

// Three degrading shapes for the same windows, narrowest last: every window
// with its gauge, every window as text only, or just the first window as
// text only. A provider with no usage data at all has no windows to shape,
// so all three collapse to the bare "usage" label plus the shortcut hint.
type UsageStage = "full" | "text" | "primary";
function usageSegmentText(windows: UsageWindow[], theme: ShellBarTheme, stage: UsageStage, hint: string | undefined, paint?: GaugePaint): string {
	const label = theme.fg(USAGE_LABEL_ROLE, "◔ usage");
	const shown = stage === "primary" ? windows.slice(0, 1) : windows;
	const body = shown.map((window) => usageWindowText(window, theme, stage === "full", paint)).join(` ${theme.fg(ROLE.LABEL, "·")} `);
	const head = body.length > 0 ? `${label} ${body}` : label;
	return hint ? `${head} ${theme.fg(USAGE_HINT_ROLE, hint)}` : head;
}

// The float header is a full-width INFO background bar with a two-column
// inset on each side, closed below by the header edge line. floatRows paints
// the background inside one-column transparent margins; those margin cells
// are painted too, so the bar reaches both edges. Undefined for neon, a width
// under the float minimum, or a theme without a background.
function floatHeaderRow(theme: ShellBarTheme, width: number, content: (width: number) => string): string | undefined {
	const painted = floatHeaderPaint(theme, width, content);
	if (painted === undefined) return undefined;
	const { inner, open } = painted;
	// The background spans the full width: the margin cells are painted too, so
	// the bar reaches both edges with no frame on its sides.
	const side = `${open} `;
	return `${side}${inner.slice(open.length, -BG_RESET.length)}${side}${BG_RESET}`;
}

function fitHeaderContent(text: string, width: number): string {
	const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function renderShellHeaderBar(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, paint?: GaugePaint): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	let content: ShellHeaderResult | undefined;
	let contentWidth = targetWidth;
	const row = floatHeaderRow(theme, targetWidth, (inner) => {
		contentWidth = inner;
		content = headerContent(model, theme, inner, usageHint, presentation, paint);
		return content.text;
	});
	if (row === undefined || !content) return headerContent(model, theme, width, usageHint, presentation, paint);
	const { usageSpan } = content;
	// The inset splits evenly around the content, so its left share is where
	// the content's columns start.
	const offset = (targetWidth - contentWidth) / 2;
	return usageSpan ? { text: row, usageSpan: { start: usageSpan.start + offset, end: usageSpan.end + offset } } : { text: row };
}

/** Shared geometry for the rail header and the below-editor header widget. */
export function renderShellHeaderChrome(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, paint?: GaugePaint): ShellHeaderChrome {
	const { text, usageSpan } = renderShellHeaderBar(model, theme, width, usageHint, presentation, paint);
	const targetWidth = Math.max(0, Math.floor(width));
	const painted = floatHeaderPaint(theme, targetWidth, () => "");
	const rule = renderShellHeaderRule(theme, targetWidth);
	if (painted === undefined) return { rows: [text, rule], headerRow: 0, usageSpan };
	const padding = `${painted.open}${" ".repeat(targetWidth)}${BG_RESET}`;
	if (presentation?.headerPlacement === "below-input") {
		// A lower one-eighth block hugs the painted padding in the next row.
		const upperEdge = theme.fg(HEADER_RULE_ROLE, "▁".repeat(targetWidth));
		return { rows: [upperEdge, padding, text, padding], headerRow: 2, usageSpan };
	}
	return { rows: [padding, text, padding, rule], headerRow: 1, usageSpan };
}

/** The usage segment is interactive only on the content row, never padding or the edge. */
export function shellHeaderUsageHit(chrome: ShellHeaderChrome, x: number, y: number): boolean {
	const { usageSpan } = chrome;
	return y === chrome.headerRow && usageSpan !== undefined && x >= usageSpan.start && x < usageSpan.end;
}

/** The rail's commands action is interactive only on its own row, within its label and key hint. */
export function shellHeaderCommandsHit(chrome: ShellHeaderChrome, x: number, y: number): boolean {
	const { commandsSpan } = chrome;
	return chrome.commandsRow !== undefined && y === chrome.commandsRow && commandsSpan !== undefined && x >= commandsSpan.start && x < commandsSpan.end;
}

// The rail's cards sit one column in from each rail edge; the pinned header
// keeps the same inset so its text lines up with the card borders.
const RAIL_HEADER_INSET = 1;
// Action rows: `≡ commands   [alt+k]`; the key hints share one column. Every
// glyph is one cell wide (≡ rather than ☰, which Pi measures as two cells but
// many terminals draw in one), so Pi and the terminal agree on the columns.
const RAIL_COMMANDS_ICON = "≡";
const RAIL_USAGE_ICON = "◔";
const RAIL_ACTION_KEY_COLUMN = 13;
const RAIL_ACTION_RULE_CHAR = "┄";
const RAIL_ACTION_LABEL_ROLE = "borderAccent";
const RAIL_ACTION_HINT_ROLE = "dim";

/**
 * The header pinned above the wide right rail's scrollable cards. Unlike the
 * one-row header it stacks its groups at rail width and wraps long values
 * rather than dropping the model. A dotted rule opens two aligned action
 * rows, `≡ commands` (`commandsRow`) and `◔ usage` (`headerRow`); every other
 * row and the rules are decorative. A missing hint means that shortcut is off.
 * Location and profile are left to the rail's Status card, which shows them.
 */
export function renderShellRailHeader(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, commandsHint?: string, paint?: GaugePaint): ShellHeaderChrome {
	const targetWidth = Math.max(0, Math.floor(width));
	const inner = targetWidth - RAIL_HEADER_INSET * 2;
	if (inner < 1) return { rows: [], headerRow: -1 };
	const pad = " ".repeat(RAIL_HEADER_INSET);
	const wrap = (text: string) => wrapTextWithAnsi(text, inner).map((line) => pad + line);
	const rows = [
		...(presentation?.density === "minimal" ? [] : wrap(theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND)))),
		...(presentation?.visibility.modelDetails === false ? [] : wrap(executionSegment(model.modelId, model.effort, theme))),
	];
	const jobs = model.jobs ? [theme.fg(ROLE.STATUS, shellJobsCount(model.jobs))] : [];
	const showUsage = presentation?.visibility.usageCost !== false;
	if (showUsage) rows.push(...wrap(joinSegments([...jobs, contextSegment(model.contextPercent, theme, paint), costSegment(model.costTotal, model.subscription, theme)], theme)));
	else if (jobs.length > 0) rows.push(...wrap(joinSegments(jobs, theme)));
	// Two aligned action rows under a dotted rule: icon, label, then a key
	// column. The commands row opens the palette; the usage row the usage panel.
	const action = (icon: string, label: string, hint: string | undefined) => {
		const labelText = truncateToWidth(`${icon} ${label}`, inner, "");
		const keyText = hint ? truncateToWidth(`[${hint}]`, Math.max(0, inner - RAIL_ACTION_KEY_COLUMN), "…") : "";
		const gap = " ".repeat(Math.max(1, RAIL_ACTION_KEY_COLUMN - visibleWidth(labelText)));
		const showKey = keyText !== "" && visibleWidth(labelText) + gap.length + visibleWidth(keyText) <= inner;
		const text = theme.fg(RAIL_ACTION_LABEL_ROLE, labelText) + (showKey ? gap + theme.fg(RAIL_ACTION_HINT_ROLE, keyText) : "");
		return { text: pad + text, end: RAIL_HEADER_INSET + visibleWidth(labelText) + (showKey ? gap.length + visibleWidth(keyText) : 0) };
	};
	rows.push(pad + theme.fg(RAIL_ACTION_HINT_ROLE, RAIL_ACTION_RULE_CHAR.repeat(inner)));
	const commands = action(RAIL_COMMANDS_ICON, "commands", commandsHint);
	const commandsRow = rows.length;
	rows.push(commands.text);
	let headerRow = -1;
	let usageSpan: HeaderUsageSpan | undefined;
	if (showUsage) {
		const usage = action(RAIL_USAGE_ICON, "usage", usageHint);
		headerRow = rows.length;
		rows.push(usage.text);
		usageSpan = { start: RAIL_HEADER_INSET, end: usage.end };
	}
	rows.push(theme.fg(HEADER_RULE_ROLE, HEADER_RULE_CHAR.repeat(targetWidth)));
	return { rows, headerRow, ...(usageSpan ? { usageSpan } : {}), commandsRow, commandsSpan: { start: RAIL_HEADER_INSET, end: commands.end } };
}

function headerContent(model: ShellHeaderModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: Presentation, paint?: GaugePaint): ShellHeaderResult {
	const targetWidth = Math.max(0, Math.floor(width));
	const jobs = model.jobs ? theme.fg(ROLE.STATUS, shellJobsCount(model.jobs)) : undefined;
	const ctxCost = joinSegments([
		...(jobs ? [jobs] : []),
		...(presentation?.visibility.usageCost === false ? [] : [contextSegment(model.contextPercent, theme, paint), costSegment(model.costTotal, model.subscription, theme)]),
	], theme);
	const windows = model.usage ? (selectUsageLimit(model.usage, model.modelId)?.windows ?? []) : [];
	const leftStages = headerLeftStages(model, theme, presentation?.visibility.modelDetails !== false)
		.map((stage) => presentation?.density === "minimal" ? stage.slice(1) : stage);
	const minimalLeft = Math.max(0, leftStages.length - 2); // brand + bare model id, before dropping the model too
	// One flat, ordered cascade — never a per-stage nested search — so the
	// left group fully degrades (profile → effort → location) before usage
	// ever gives anything up, and usage fully degrades (gauges → secondary
	// windows → the whole segment) before ctx/cost is touched: every window
	// with its gauge, then text-only, then the first window only, then gone.
	// Unlike the compact bar's usage meter (hidden with no data), this is a
	// standing, clickable affordance — even with nothing to report it still
	// reads "usage" plus the shortcut hint, unless disabled, width permitting.
	const usageStages: Array<UsageStage | undefined> = presentation?.visibility.usageCost === false ? [undefined] : ["full", "text", "primary", undefined];
	const attempts: Array<{ leftIndex: number; usageStage: UsageStage | undefined }> = [
		...leftStages.slice(0, minimalLeft).map((_, leftIndex) => ({ leftIndex, usageStage: usageStages[0] })),
		...usageStages.map((usageStage) => ({ leftIndex: minimalLeft, usageStage })),
		{ leftIndex: leftStages.length - 1, usageStage: undefined },
	];
	for (const { leftIndex, usageStage } of attempts) {
		const usageText = usageStage ? usageSegmentText(windows, theme, usageStage, usageHint, paint) : undefined;
		const right = usageText ? joinSegments([ctxCost, usageText], theme) : ctxCost;
		const left = joinSegments(leftStages[leftIndex]!, theme);
		if (visibleWidth(left) + (right ? RIGHT_PADDING : 0) + visibleWidth(right) > targetWidth) continue;
		const text = left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(right)) + right;
		if (!usageText) return { text };
		const usageStart = visibleWidth(left) + (targetWidth - visibleWidth(left) - visibleWidth(right)) + visibleWidth(ctxCost) + visibleWidth(` ${SHELL_BAR_SEPARATOR} `);
		return { text, usageSpan: { start: usageStart, end: usageStart + visibleWidth(usageText) } };
	}
	const brand = presentation?.density === "minimal" ? "" : theme.fg(ROLE.BRAND, theme.bold(HEADER_BRAND));
	if (jobs && visibleWidth(jobs) <= targetWidth) {
		const left = visibleWidth(brand) + RIGHT_PADDING + visibleWidth(jobs) <= targetWidth ? brand : "";
		return { text: left + " ".repeat(targetWidth - visibleWidth(left) - visibleWidth(jobs)) + jobs };
	}
	return { text: visibleWidth(brand) <= targetWidth ? brand : "" };
}

// A single owner supplies real captured filenames, not ShellBarModel's totals.
// Undefined keeps every legacy surface alive for style/width/theme transitions.
export function renderShellBelowInputFloat(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel, paint?: GaugePaint): ShellHeaderChrome | undefined {
	if (presentation?.headerPlacement !== "below-input") return undefined;
	const targetWidth = Math.max(0, Math.floor(width));
	if (floatHeaderPaint(theme, targetWidth, () => "") === undefined) return undefined;
	const chrome = renderShellHeaderChrome(buildShellHeaderModel(model, presentation.statusPlacement === "hidden"), theme, targetWidth, usageHint, presentation, paint);
	// The row exists only while files are actually tracked; an unborn-only root
	// is silence here (/gentle:changes explains the state on demand).
	const changesRow = Boolean(changes && changes.files.length > 0) && presentation.visibility.changes !== false
		? floatHeaderRow(theme, targetWidth, (inner) => renderChangesWidget(changes, theme, inner)[0] ?? "")
		: undefined;
	const statuses = presentation.statusPlacement === "hidden" ? [] : [
		...(model.jobs?.length ? [shellJobsCount(model.jobs.length)] : []),
		...model.statuses.map(sanitizeStatus).filter(Boolean),
	];
	const statusRow = statuses.length
		? floatHeaderRow(theme, targetWidth, () => joinSegments(statuses.map((status) => theme.fg(ROLE.STATUS, status)), theme))
		: undefined;
	return {
		rows: [
			chrome.rows[0]!,
			chrome.rows[1]!,
			...(changesRow ? [changesRow] : []),
			chrome.rows[2]!,
			...(statusRow ? [statusRow] : []),
			chrome.rows[3]!,
		],
		headerRow: changesRow ? 3 : 2,
		usageSpan: chrome.usageSpan,
	};
}

// The bottom bar when it is the only status row of a narrow fullscreen
// terminal (the header sits below the input and steps aside). It reuses the
// header row's own cascade, so context, cost and usage outlive the location
// on small screens, and keeps extension statuses on a second line instead of
// dropping them the way the header deliberately does.
export function renderShellBottomOnlyBar(model: ShellBarModel, theme: ShellBarTheme, width: number, usageHint?: string, presentation?: HeaderPresentation, changes?: ChangesModel, paint?: GaugePaint): string[] {
	const grouped = renderShellBelowInputFloat(model, theme, width, usageHint, presentation, changes, paint);
	if (grouped) return grouped.rows;
	const headerModel = buildShellHeaderModel(model, true);
	// Neon, missing backgrounds and sub-minimum widths keep the old row count.
	const rows = [headerContent(headerModel, theme, width, usageHint, presentation, paint).text];
	const statuses = model.statuses.map(sanitizeStatus).filter((status) => status.length > 0).map((status) => theme.fg(ROLE.STATUS, status));
	return statuses.length ? [...rows, truncateToWidth(joinSegments(statuses, theme), Math.max(0, Math.floor(width)), "…")] : rows;
}

// The rule row painted directly under the header bar: one full-width horizontal
// line in the same theme role as the editor frame (PROMPT_FRAME_ROLE in
// extensions/gentle-shell.ts), so the status row and the prompt read as one
// panel. It exists only while the fullscreen sidebar is active — when the
// sidebar is not shown the header rail never renders and the rule goes away
// with it.
const HEADER_RULE_CHAR = "─";
const HEADER_RULE_ROLE = "border";
const HEADER_EDGE_CHAR = "▔";
const BG_RESET = "\x1b[49m";

// Paints the header content with floatRows and returns the row without its
// transparent margins plus the background opener. The painted row is
// `<open> <content> <reset>`; the opener has no spaces, so the first space ends
// it. Undefined when the float style does not apply.
function floatHeaderPaint(theme: ShellBarTheme, width: number, content: (width: number) => string): { inner: string; open: string } | undefined {
	let floated = false;
	const [row] = floatRows(CARD_TONE.INFO, theme, width, (inner) => {
		floated = inner !== width;
		return floated ? { body: [` ${fitHeaderContent(content(inner - 2), inner - 2)} `] } : {};
	});
	if (!floated || row === undefined) return undefined;
	const inner = row.slice(1, -1);
	return { inner, open: inner.slice(0, inner.indexOf(" ")) };
}

// In the float style the rule closes the hanging header tab with an upper
// one-eighth block line. Box-drawing lines sit mid-cell: a transparent `└──┘`
// leaves half an unpainted row under the tab, and a painted one overshoots it.
// `▔` hugs the top of its cell, so the line touches the tab's background
// exactly. The edge stays transparent beneath the painted bottom padding.
export function renderShellHeaderRule(theme: ShellBarTheme, width: number): string {
	const targetWidth = Math.max(0, Math.floor(width));
	if (floatHeaderPaint(theme, targetWidth, () => "") !== undefined) return theme.fg(HEADER_RULE_ROLE, HEADER_EDGE_CHAR.repeat(targetWidth));
	return theme.fg(HEADER_RULE_ROLE, HEADER_RULE_CHAR.repeat(targetWidth));
}

export function renderShellBar(model: ShellBarModel, theme: ShellBarTheme, width: number, presentation?: Presentation, paint?: GaugePaint): string[] {
	let segments = buildSegments(model, theme, presentation, paint);
	const right = model.sessionName ? theme.fg(ROLE.SESSION, model.sessionName) : undefined;

	let left = joinSegments(segments, theme);
	if (right && visibleWidth(left) + RIGHT_PADDING + visibleWidth(right) <= width) {
		const padding = " ".repeat(width - visibleWidth(left) - visibleWidth(right));
		return [left + padding + right];
	}

	if (visibleWidth(left) > width) {
		segments = buildSegments(compactModel(model), theme, presentation);
		left = joinSegments(segments, theme);
	}
	while (segments.length > 1 && visibleWidth(left) > width) {
		segments.pop();
		left = joinSegments(segments, theme);
	}
	return [truncateToWidth(left, width, "…")];
}
