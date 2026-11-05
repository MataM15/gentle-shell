import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { parseModelRef } from "./agents-config.ts";
import { paintGauge, type GaugePaint } from "./shell-gauge.ts";
import { cardInnerWidth, renderCard } from "./shell-card.ts";
import { PANEL_ROW_INDENT, renderPanelRow, renderStaticPanelHeader } from "./shell-panel.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "./bridge-cost.ts";

// Gentle Shell subscription usage: the rate-limit windows each connected
// provider reports. Codex sends them as SSE headers and through its usage
// endpoint; both land in the same model. Parsing is pure and never keeps
// account details beyond the plan name.

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
	// Raw allowance numbers, kept only by providers that report them (NaN).
	// Aggregates are weighted by budget, so averaging percentages is never
	// needed; nothing renders these fields directly.
	used?: number;
	budget?: number;
}

// Optional hints for the compact Limits card (gentle-pi:usage-source/v1).
// A source that never sets them renders exactly as before.
export type UsageFamily = "gemini" | "claude";
const USAGE_FAMILIES: readonly string[] = ["gemini", "claude"];
const USAGE_LAYOUT_ACCOUNTS = "accounts";

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
	// Compact layout: the account this limit belongs to and its model family.
	account?: string;
	family?: UsageFamily;
	/** "provider" when the limit covers every model of the provider (Codex's main limit). */
	scope?: "provider";
}

export interface UsageUnavailable {
	label: string;
	reason: string;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
	// "accounts": one compact card row per account (see renderUsageCard).
	layout?: typeof USAGE_LAYOUT_ACCOUNTS;
	// The card's section title for that layout, in place of provider and plan.
	heading?: string;
	// The snapshot is an older one kept because the latest refresh failed.
	stale?: boolean;
	// Accounts whose quota could not be read; one failure row each on the card.
	unavailable?: UsageUnavailable[];
}

export interface UsageTheme {
	fg(color: string, text: string): string;
}

interface RawWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface RawRateLimit {
	limit_reached?: boolean;
	primary_window?: RawWindow | null;
	secondary_window?: RawWindow | null;
}

interface RawAdditionalLimit {
	limit_name?: string;
	rate_limit?: RawRateLimit | null;
}

interface RawCodexUsage {
	plan_type?: string;
	rate_limit?: RawRateLimit | null;
	additional_rate_limits?: RawAdditionalLimit[] | null;
}

interface RawNanModel {
	model?: unknown;
	cap?: unknown;
	fullCap?: unknown;
	tokensUsed?: unknown;
	periodEnd?: unknown;
	windowHours?: unknown;
	windowTokens?: unknown;
	fullWindowTokens?: unknown;
	windowTokensUsed?: unknown;
	windowResetsAt?: unknown;
}

interface RawNanQuota {
	models?: unknown;
	periodEnd?: unknown;
}

export const CODEX_PROVIDER = "openai-codex";
export const ANTHROPIC_PROVIDER = "anthropic";
export const NAN_PROVIDER = "nan";
const ANTHROPIC_MAIN_LIMIT = "claude";
const ANTHROPIC_PREFIX = "anthropic-ratelimit-unified-";
const ANTHROPIC_WINDOWS: ReadonlyArray<[key: string, seconds: number]> = [
	["5h", 18_000],
	["7d", 604_800],
];
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// The endpoint Claude's own usage settings read with the subscription OAuth
// token. Not a published API, so the payload is validated field by field.
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// The NaN Cloud dashboard backend; not part of NaN's published OpenAPI, so the
// fetch that uses it is fixed-origin, redirect-refusing, and schema-validated.
export const NAN_QUOTA_URL = "https://cloud-api.nan.builders/api/usage/quota";
// The model's own allowance for the billing period carries no label: the model
// id names it in the bar, and the reset text says what the window is in the
// panel. Only a sub-window on top of it (a rolling `4h`) needs a name.
const NAN_PERIOD_LABEL = "";
// The dashboard's own published fallbacks for a model that reports rolling
// numbers without naming its budget.
const NAN_DEFAULT_WINDOW_TOKENS = 400_000_000;
const NAN_DEFAULT_WINDOW_HOURS = 4;
const CODEX_MAIN_LIMIT = "codex";
const CODEX_ACCOUNT_CLAIM = "https://api.openai.com/auth";
const HEADER_PREFIX = "x-codex-";
const PANEL_METER_CELLS = 16;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;
const WEEK = 604_800;
const ROLE = {
	PROVIDER: "text",
	PLAN: "muted",
	LIMIT: "customMessageLabel",
	LABEL: "muted",
	PERCENT: "text",
	RESET: "dim",
	SEPARATOR: "muted",
} as const;
export const USAGE_EMPTY_MESSAGE = "No subscription usage yet. Usage arrives with the next response, or press r to fetch it.";
export const SUPPORTED_USAGE_PROVIDERS: readonly string[] = [CODEX_PROVIDER, ANTHROPIC_PROVIDER, NAN_PROVIDER];
const DEFAULT_PENDING_NOTE = "no usage yet · r to fetch";
const PENDING_NOTE: Record<string, string> = {
	[CODEX_PROVIDER]: DEFAULT_PENDING_NOTE,
	[NAN_PROVIDER]: DEFAULT_PENDING_NOTE,
	[ANTHROPIC_PROVIDER]: "usage arrives with the first response",
};
const UNSUPPORTED_NOTE = "no subscription usage for this provider";
const ACTIVE_MARK = "active";
// What a targeted provider with no snapshot says after a refresh actually ran
// and answered nothing. Generic on purpose: it names no endpoint, key, or
// account detail, exactly like the other notes here.
export const USAGE_FETCH_FAILED_NOTE = "fetch failed · r to retry";

export interface ActiveProvider {
	provider: string;
}

// A generic hook so an extension holding its own provider (its own API token,
// its own usage endpoint) can plug a usage source into the shell without the
// shell ever knowing that provider's name. Emitted on `pi.events` as payload
// under `USAGE_SOURCE_EVENT`; gentle-shell validates the shape below and
// ignores anything else, so a malformed or foreign event never reaches a
// fetch call. Re-registration for the same provider replaces the previous
// source, so a second `session_start` emitting the same payload is a no-op
// in effect, not an accumulation.
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
const USAGE_SOURCE_PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface UsageSource {
	schema: typeof USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote?: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined>;
}

// Pure and defensive: the payload crosses an event bus from another
// extension, so nothing here is trusted until every field is checked. Any
// mismatch returns undefined rather than throwing, exactly like the other
// payload parsers in this file.
export function parseUsageSource(value: unknown): UsageSource | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.schema !== USAGE_SOURCE_SCHEMA) return undefined;
	if (typeof raw.provider !== "string" || !USAGE_SOURCE_PROVIDER_PATTERN.test(raw.provider)) return undefined;
	if (typeof raw.fetch !== "function") return undefined;
	if (raw.pendingNote !== undefined && typeof raw.pendingNote !== "string") return undefined;
	const source: UsageSource = { schema: USAGE_SOURCE_SCHEMA, provider: raw.provider, fetch: raw.fetch as UsageSource["fetch"] };
	if (typeof raw.pendingNote === "string") source.pendingNote = raw.pendingNote;
	return source;
}

// One source per provider, most recent registration wins. Nothing here fetches
// or touches the network; it only remembers who to ask.
export class UsageSourceRegistry {
	private readonly sources = new Map<string, UsageSource>();

	register(source: UsageSource): void {
		this.sources.set(source.provider, source);
	}

	get(provider: string): UsageSource | undefined {
		return this.sources.get(provider);
	}

	has(provider: string): boolean {
		return this.sources.has(provider);
	}

	providers(): string[] {
		return [...this.sources.keys()];
	}

	note(provider: string): string | undefined {
		const source = this.sources.get(provider);
		return source ? (source.pendingNote ?? DEFAULT_PENDING_NOTE) : undefined;
	}
}

export function providerNote(provider: string, registry?: UsageSourceRegistry): string {
	return PENDING_NOTE[provider] ?? registry?.note(provider) ?? UNSUPPORTED_NOTE;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseSourceUsageWindow(value: unknown): UsageWindow | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.label !== "string") return undefined;
	if (!isFiniteNumber(raw.usedPercent)) return undefined;
	if (!isFiniteNumber(raw.windowSeconds)) return undefined;
	if (raw.resetAt !== null && !isFiniteNumber(raw.resetAt)) return undefined;
	if (raw.used !== undefined && !isFiniteNumber(raw.used)) return undefined;
	if (raw.budget !== undefined && !isFiniteNumber(raw.budget)) return undefined;
	const window: UsageWindow = { label: raw.label, usedPercent: raw.usedPercent, windowSeconds: raw.windowSeconds, resetAt: raw.resetAt as number | null };
	if (raw.used !== undefined) window.used = raw.used as number;
	if (raw.budget !== undefined) window.budget = raw.budget as number;
	return window;
}

function parseSourceUsageLimit(value: unknown): UsageLimit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.name !== "string") return undefined;
	if (typeof raw.limitReached !== "boolean") return undefined;
	if (!Array.isArray(raw.windows)) return undefined;
	const windows: UsageWindow[] = [];
	for (const entry of raw.windows) {
		const window = parseSourceUsageWindow(entry);
		if (!window) return undefined;
		windows.push(window);
	}
	if (raw.account !== undefined && typeof raw.account !== "string") return undefined;
	if (raw.family !== undefined && typeof raw.family !== "string") return undefined;
	const limit: UsageLimit = { name: raw.name, limitReached: raw.limitReached, windows };
	if (typeof raw.account === "string") limit.account = raw.account;
	// An unknown family is a hint from a newer source, not a malformed payload.
	if (typeof raw.family === "string" && USAGE_FAMILIES.includes(raw.family)) limit.family = raw.family as UsageFamily;
	return limit;
}

function parseUnavailable(value: unknown): UsageUnavailable[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const entries: UsageUnavailable[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") return undefined;
		const raw = entry as Record<string, unknown>;
		if (typeof raw.label !== "string" || typeof raw.reason !== "string") return undefined;
		entries.push({ label: raw.label, reason: raw.reason });
	}
	return entries;
}

// A registered source's resolved value crosses the same trust boundary a
// parsed HTTP payload does: it is foreign code's own object, so it is
// validated field by field and never recorded by reference. Every accepted
// shape is rebuilt from scratch, so a source mutating its own object after
// returning it can never reach a snapshot gentle-shell already recorded.
export function parseProviderUsage(value: unknown, expectedProvider: string): ProviderUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	if (raw.provider !== expectedProvider) return undefined;
	if (raw.plan !== undefined && typeof raw.plan !== "string") return undefined;
	if (!isFiniteNumber(raw.fetchedAt)) return undefined;
	if (!Array.isArray(raw.limits)) return undefined;
	const limits: UsageLimit[] = [];
	for (const entry of raw.limits) {
		const limit = parseSourceUsageLimit(entry);
		if (!limit) return undefined;
		limits.push(limit);
	}
	if (raw.heading !== undefined && typeof raw.heading !== "string") return undefined;
	if (raw.layout !== undefined && typeof raw.layout !== "string") return undefined;
	if (raw.stale !== undefined && typeof raw.stale !== "boolean") return undefined;
	const unavailable = raw.unavailable === undefined ? undefined : parseUnavailable(raw.unavailable);
	if (raw.unavailable !== undefined && !unavailable) return undefined;
	const usage: ProviderUsage = { provider: raw.provider, plan: typeof raw.plan === "string" ? raw.plan : undefined, limits, fetchedAt: raw.fetchedAt };
	if (raw.layout === USAGE_LAYOUT_ACCOUNTS) usage.layout = USAGE_LAYOUT_ACCOUNTS;
	if (typeof raw.heading === "string") usage.heading = raw.heading;
	if (typeof raw.stale === "boolean") usage.stale = raw.stale;
	if (unavailable) usage.unavailable = unavailable;
	return usage;
}

export function windowLabel(seconds: number): string {
	if (seconds === WEEK) return "week";
	if (seconds >= DAY && seconds % DAY === 0) return `${seconds / DAY}d`;
	if (seconds >= HOUR && seconds % HOUR === 0) return `${seconds / HOUR}h`;
	return `${Math.round(seconds / MINUTE)}m`;
}

export function formatReset(resetAt: number | null, now: number): string {
	if (resetAt === null) return "";
	const seconds = Math.floor((resetAt - now) / 1000);
	if (seconds <= 0) return "resets now";
	if (seconds < HOUR) return `resets in ${Math.max(1, Math.round(seconds / MINUTE))}m`;
	if (seconds < DAY) return `resets in ${Math.floor(seconds / HOUR)}h ${Math.floor((seconds % HOUR) / MINUTE)}m`;
	return `resets in ${Math.floor(seconds / DAY)}d ${Math.floor((seconds % DAY) / HOUR)}h`;
}

function parseWindow(raw: RawWindow | null | undefined, now: number): UsageWindow | undefined {
	if (!raw || !isFiniteNumber(raw.used_percent) || !isFiniteNumber(raw.limit_window_seconds) || raw.limit_window_seconds <= 0) return undefined;
	const resetAt =
		typeof raw.reset_at === "number" ? raw.reset_at * 1000 : typeof raw.reset_after_seconds === "number" ? now + raw.reset_after_seconds * 1000 : null;
	return { label: windowLabel(raw.limit_window_seconds), usedPercent: raw.used_percent, windowSeconds: raw.limit_window_seconds, resetAt };
}

function parseRateLimit(name: string, raw: RawRateLimit | null | undefined, now: number): UsageLimit | undefined {
	if (!raw) return undefined;
	const windows = [parseWindow(raw.primary_window, now), parseWindow(raw.secondary_window, now)].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	return { name, windows, limitReached: raw.limit_reached === true };
}

export function parseCodexUsage(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawCodexUsage;
	const limits: UsageLimit[] = [];
	const main = parseRateLimit(CODEX_MAIN_LIMIT, raw.rate_limit, now);
	if (main) limits.push({ ...main, scope: "provider" });
	for (const extra of raw.additional_rate_limits ?? []) {
		const limit = parseRateLimit(extra.limit_name ?? "limit", extra.rate_limit, now);
		if (limit) limits.push(limit);
	}
	return { provider: CODEX_PROVIDER, plan: typeof raw.plan_type === "string" ? raw.plan_type : undefined, limits, fetchedAt: now };
}

function headerWindow(headers: Record<string, string>, kind: "primary" | "secondary"): UsageWindow | undefined {
	const used = Number.parseFloat(headers[`${HEADER_PREFIX}${kind}-used-percent`] ?? "");
	if (!Number.isFinite(used)) return undefined;
	// Missing or invalid duration is not a zero-minute quota or an assumed 5h window.
	const seconds = Number(headers[`${HEADER_PREFIX}${kind}-window-minutes`]) * MINUTE;
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	const resetAt = Number.parseInt(headers[`${HEADER_PREFIX}${kind}-reset-at`] ?? "", 10);
	return { label: windowLabel(seconds), usedPercent: used, windowSeconds: seconds, resetAt: Number.isFinite(resetAt) ? resetAt * 1000 : null };
}

export function parseCodexHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows = [headerWindow(headers, "primary"), headerWindow(headers, "secondary")].filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) return undefined;
	const reached = headers[`${HEADER_PREFIX}rate-limit-reached-type`];
	return { provider: CODEX_PROVIDER, plan: undefined, limits: [{ name: CODEX_MAIN_LIMIT, windows, limitReached: Boolean(reached), scope: "provider" }], fetchedAt: now };
}

// Claude Pro/Max sends utilization as a 0..1 fraction per window and reset
// times in Unix seconds on every response; there is no usage endpoint.
export function parseAnthropicHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [key, seconds] of ANTHROPIC_WINDOWS) {
		const fraction = Number.parseFloat(headers[`${ANTHROPIC_PREFIX}${key}-utilization`] ?? "");
		if (!Number.isFinite(fraction)) continue;
		const reset = Number.parseInt(headers[`${ANTHROPIC_PREFIX}${key}-reset`] ?? "", 10);
		windows.push({ label: windowLabel(seconds), usedPercent: fraction * 100, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset * 1000 : null });
	}
	if (windows.length === 0) return undefined;
	const status = headers[`${ANTHROPIC_PREFIX}status`];
	return { provider: ANTHROPIC_PROVIDER, plan: undefined, limits: [{ name: ANTHROPIC_MAIN_LIMIT, windows, limitReached: status === "rejected" }], fetchedAt: now };
}

// The OAuth usage payload reports the same 5-hour and 7-day windows the
// response headers do, as utilization percentages; it lands in the same shape
// so the header path and the fetch path overwrite each other cleanly.
export function parseAnthropicOauthUsage(payload: unknown, now: number): ProviderUsage | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const raw = payload as Record<string, unknown>;
	const windows: UsageWindow[] = [];
	let limitReached = false;
	for (const [key, seconds] of [["five_hour", 18_000], ["seven_day", 604_800]] as const) {
		const entry = raw[key] as Record<string, unknown> | null | undefined;
		if (!entry || typeof entry !== "object" || !isFiniteNumber(entry.utilization)) continue;
		const reset = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : Number.NaN;
		windows.push({ label: windowLabel(seconds), usedPercent: entry.utilization, windowSeconds: seconds, resetAt: Number.isFinite(reset) ? reset : null });
		if (entry.locked_reason) limitReached = true;
	}
	if (windows.length === 0) return undefined;
	return { provider: ANTHROPIC_PROVIDER, plan: undefined, limits: [{ name: ANTHROPIC_MAIN_LIMIT, windows, limitReached }], fetchedAt: now };
}

export function parseUsageHeaders(headers: Record<string, string>, now: number): ProviderUsage | undefined {
	return parseCodexHeaders(headers, now) ?? parseAnthropicHeaders(headers, now);
}

// NaN Cloud reports one allowance per model for the billing period, plus the
// rolling window the model applies on top of it. Percentages follow the
// dashboard exactly: tokens used over the period allowance, and window tokens
// over the full window budget. Every field is optional, because this payload
// lives outside NaN's published contract.
function quotaTimestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value * 1000;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function quotaNumber(value: unknown, positive: boolean): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return positive ? (value > 0 ? value : undefined) : value >= 0 ? value : undefined;
}

function nanRollingWindow(raw: RawNanModel): UsageWindow | undefined {
	const used = quotaNumber(raw.windowTokensUsed, false);
	if (used === undefined) return undefined;
	const budget = quotaNumber(raw.fullWindowTokens, true) ?? quotaNumber(raw.windowTokens, true) ?? NAN_DEFAULT_WINDOW_TOKENS;
	const hours = quotaNumber(raw.windowHours, true) ?? NAN_DEFAULT_WINDOW_HOURS;
	return { label: windowLabel(hours * HOUR), usedPercent: (used / budget) * 100, windowSeconds: hours * HOUR, resetAt: quotaTimestamp(raw.windowResetsAt) };
}

// The allowance the dashboard divides by is the full-period cap, because `cap`
// is the allowance of the period in progress and comes back prorated on a first
// period. A model that reports neither figure reports no allowance at all, which
// is a state the surfaces already know how to draw nothing for.
function nanEffectiveAllowance(raw: RawNanModel): number | undefined {
	return quotaNumber(raw.fullCap, true) ?? quotaNumber(raw.cap, true);
}

// One allowance per metered model, weighted by that model's own cap. The raw
// numbers travel with the period window so the bar and the panel can aggregate
// without ever averaging percentages.
function nanPeriodWindow(tokensUsed: number, cap: number, resetAt: number | null, now: number): UsageWindow {
	return {
		label: NAN_PERIOD_LABEL,
		usedPercent: (tokensUsed / cap) * 100,
		windowSeconds: resetAt === null ? 0 : Math.max(0, Math.round((resetAt - now) / 1000)),
		resetAt,
		used: tokensUsed,
		budget: cap,
	};
}

export function parseNanQuota(payload: unknown, now: number): ProviderUsage {
	const raw = (payload ?? {}) as RawNanQuota;
	const fallbackResetAt = quotaTimestamp(raw.periodEnd);
	const limits: UsageLimit[] = [];
	if (Array.isArray(raw.models)) {
		for (const entry of raw.models) {
			if (!entry || typeof entry !== "object") continue;
			const model = entry as RawNanModel;
			if (typeof model.model !== "string" || model.model.length === 0) continue;
			const allowance = nanEffectiveAllowance(model);
			// A model that reports no allowance is not drift — the dashboard draws
			// nothing for it either, and the live payload carries such entries. A metered
			// allowance whose usage cannot be read is drift: a partial snapshot would
			// understate every aggregate it feeds, so the read fails whole and the last
			// valid snapshot survives instead.
			if (allowance === undefined) continue;
			const tokensUsed = quotaNumber(model.tokensUsed, false);
			if (tokensUsed === undefined) return { provider: NAN_PROVIDER, plan: undefined, limits: [], fetchedAt: now };
			const resetAt = quotaTimestamp(model.periodEnd) ?? fallbackResetAt;
			const windows: UsageWindow[] = [nanPeriodWindow(tokensUsed, allowance, resetAt, now)];
			const rolling = nanRollingWindow(model);
			if (rolling) windows.push(rolling);
			limits.push({ name: model.model, windows, limitReached: tokensUsed >= allowance });
		}
	}
	return { provider: NAN_PROVIDER, plan: undefined, limits, fetchedAt: now };
}

// Aggregation. NaN reports one allowance per metered model and the payload
// order is the server's business, so surfaces pick by meaning, not by position.
function rawAllowance(limit: UsageLimit): UsageWindow | undefined {
	const [first] = limit.windows;
	if (!first || first.used === undefined || first.budget === undefined) return undefined;
	return first.budget > 0 ? first : undefined;
}

// The leading alphabetic run of a model id: glm5.3-flash and glm5.2 are both
// "glm". Derived from the id the payload reports, never from a vendor list.
export function modelFamily(modelId: string): string {
	return (/^[a-z]+/i.exec(modelId)?.[0] ?? modelId).toLowerCase();
}

// Only NaN carries raw allowance numbers, so this one gate is what keeps Codex
// and Anthropic on exactly the rows and the meter they had before. One metered
// model is still a payload that carries them: the gate answers "does this
// provider report allowances", never "are there enough rows to sort", because
// a single allowance read as "no allowances" sent the bar back to whichever
// model the payload listed first.
export function allowanceGroupsSupported(limits: readonly UsageLimit[]): boolean {
	return limits.length > 0 && limits.every((limit) => rawAllowance(limit) !== undefined);
}

function percentOf(limit: UsageLimit): number {
	return limit.windows[0]?.usedPercent ?? 0;
}

const GROUP_SUFFIX = " total";

// A group is an allowance share, never an average of shares: Σused / Σbudget.
// It carries no reset, because its members close their own billing period on
// their own date, and a single reset would be a lie.
function allowanceTotal(name: string, limits: readonly UsageLimit[]): UsageLimit | undefined {
	const windows = limits.map(rawAllowance).filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0 || windows.length !== limits.length) return undefined;
	const used = windows.reduce((total, window) => total + (window.used ?? 0), 0);
	const budget = windows.reduce((total, window) => total + (window.budget ?? 0), 0);
	if (budget <= 0) return undefined;
	return {
		name,
		windows: [{ label: NAN_PERIOD_LABEL, usedPercent: (used / budget) * 100, windowSeconds: 0, resetAt: null }],
		limitReached: limits.some((limit) => limit.limitReached),
	};
}

// What the grouping is for now that the totals are gone: the order. A family
// stays together, families sort by what they consume and the members inside one
// follow the same rule, most used first. The account and family totals are the
// bar's fallback ladder only — they are never rows, because a total nobody can
// act on only costs space. Every row is a limit block, so nothing here
// introduces a shape the other providers do not already use.
export function groupUsageLimits(limits: readonly UsageLimit[]): UsageLimit[] {
	if (!allowanceGroupsSupported(limits)) return [...limits];
	const order: string[] = [];
	const members = new Map<string, UsageLimit[]>();
	for (const limit of limits) {
		const family = modelFamily(limit.name);
		if (!members.has(family)) {
			members.set(family, []);
			order.push(family);
		}
		members.get(family)?.push(limit);
	}
	return order
		.map((family) => {
			const sorted = [...(members.get(family) ?? [])].sort((a, b) => percentOf(b) - percentOf(a));
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, sorted);
			return { percent: total?.windows[0]?.usedPercent ?? percentOf(sorted[0]), sorted };
		})
		.sort((a, b) => b.percent - a.percent)
		.flatMap((family) => family.sorted);
}

// The bar follows the model the session is using: exact allowance, then its
// family, then the account total, then the first limit (which is what every
// provider without raw numbers keeps using, and what a missing model keeps).
export function selectUsageLimit(usage: ProviderUsage, activeModelId?: string): UsageLimit | undefined {
	if (!activeModelId) return usage.limits[0];
	const exact = usage.limits.find((limit) => limit.name === activeModelId);
	if (exact) return exact;
	if (allowanceGroupsSupported(usage.limits)) {
		const family = modelFamily(activeModelId);
		const members = usage.limits.filter((limit) => modelFamily(limit.name) === family);
		// The family rung is about the name of the meter, not about printing a row,
		// so a single member counts: its family is a closer statement of what the
		// session is drawing from than the whole account.
		if (members.length > 0) {
			const total = allowanceTotal(`${family}${GROUP_SUFFIX}`, members);
			if (total) return total;
		}
		const account = allowanceTotal(`${usage.provider}${GROUP_SUFFIX}`, usage.limits);
		if (account) return account;
	}
	return usage.limits[0];
}

export function accountIdFromToken(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = claims[CODEX_ACCOUNT_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id.length > 0 ? auth.chatgpt_account_id : undefined;
	} catch {
		return undefined;
	}
}

function paintMeter(percent: number, cells: number, theme: UsageTheme, paint?: GaugePaint): string {
	return paintGauge(percent, theme, cells, paint);
}

// pi-claude-bridge answers on the owner's Claude subscription, and the response
// headers are filed under the provider that served them, so the store holds a
// "claude-bridge" snapshot (week only) beside the "anthropic" one (5h and week).
// The store and the fallback cooldowns keep both as recorded; every place that
// LISTS usage (rail card, /gentle:usage, the header gauge) goes through these
// helpers so the one Claude account shows once, from the richer snapshot.
const DISPLAY_PROVIDER_ALIASES: Readonly<Record<string, string>> = { [CLAUDE_BRIDGE_PROVIDER]: ANTHROPIC_PROVIDER };

/** The provider a snapshot is shown under: an alias reads as the account it serves. */
export const displayProvider = (provider: string): string => DISPLAY_PROVIDER_ALIASES[provider] ?? provider;

/** Snapshots as listed: one per displayed provider, the provider's own snapshot over an alias's, an alias alone relabelled. */
export function displayUsages(usages: readonly ProviderUsage[]): ProviderUsage[] {
	const shown = new Map<string, ProviderUsage>();
	for (const usage of usages) {
		const key = displayProvider(usage.provider);
		if (usage.provider === key) shown.set(key, usage);
		else if (!shown.has(key) && !usages.some((other) => other.provider === key && other.limits.length > 0)) shown.set(key, { ...usage, provider: key });
	}
	return [...shown.values()];
}

/** The snapshot the header gauge reads for the model's provider: the account's own when held, else the served provider's. */
export function displayUsageFor(store: { get(provider: string): ProviderUsage | undefined }, provider: string): ProviderUsage | undefined {
	const own = displayProvider(provider);
	const account = own === provider ? undefined : store.get(own);
	return account && account.limits.length > 0 ? account : store.get(provider);
}

export function renderUsageBar(usage: ProviderUsage, theme: UsageTheme, activeModelId?: string, paint?: GaugePaint): string | undefined {
	const main = selectUsageLimit(usage, activeModelId);
	const [first, ...rest] = main?.windows ?? [];
	if (!first) return undefined;
	// An unlabeled window prints as the name, the meter and the percentage.
	const head = [theme.fg(ROLE.LABEL, main.name), ...(first.label.length === 0 ? [] : [theme.fg(ROLE.LABEL, first.label)]), paintMeter(first.usedPercent, 8, theme, paint), theme.fg(ROLE.PERCENT, `${Math.round(first.usedPercent)}%`)].join(" ");
	const tail = rest.map((window) => `${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.LABEL, window.label)} ${theme.fg(ROLE.PERCENT, `${Math.round(window.usedPercent)}%`)}`);
	return [head, ...tail].join(" ");
}

function updatedAgo(fetchedAt: number, now: number): string {
	const minutes = Math.floor((now - fetchedAt) / 60_000);
	return minutes < 1 ? "updated just now" : `updated ${minutes}m ago`;
}

// The providers one refresh targets: the session's own provider first, then
// every provider the active profile's subagent routing names, deduplicated in
// first-seen order. A qualified ref ("provider/id") resolves directly; a bare
// model id resolves through the registry callback only when that callback can
// name exactly one provider, so an ambiguous or unknown ref never guesses one
// and is dropped instead.
export function usageScopeProviders(
	mainProvider: string | undefined,
	routingModels: ReadonlyArray<string | undefined> | undefined,
	resolveBareModel?: (modelId: string) => string | undefined,
): string[] {
	const providers = new Set<string>();
	if (mainProvider) providers.add(mainProvider);
	for (const model of routingModels ?? []) {
		const ref = parseModelRef(model);
		if (!ref) continue;
		const provider = ref.provider ?? resolveBareModel?.(ref.id);
		if (provider) providers.add(provider);
	}
	return [...providers];
}

// The current routing scope the panel draws: which providers are targeted, and
// which of them failed their latest settled refresh. A provider recorded
// earlier but no longer targeted is simply absent — it is not current scope.
export interface UsagePanelScope {
	providers: readonly string[];
	// Actual failures only: a refresh that settled without a snapshot. A
	// provider still fetching is never in here, so an in-flight refresh cannot
	// read as failed, and a successful refresh removes the provider again.
	failed: ReadonlySet<string>;
}

// The active provider comes first, marked in plain text, and explains
// itself when it has no data yet. Other providers seen this session follow.
// With a scope, the panel draws exactly the targeted providers in scope order:
// one with no snapshot explains itself (its latest refresh failed, or its
// pending note otherwise), one whose latest refresh failed after a good
// snapshot keeps that snapshot and says so beside it, and a provider recorded
// under a previous profile's routing is never presented as current scope after
// a profile switch.
export function renderUsagePanel(recorded: ProviderUsage[], theme: UsageTheme, width: number, now: number, activeProvider?: ActiveProvider, registry?: UsageSourceRegistry, scope?: UsagePanelScope, paint?: GaugePaint): string[] {
	const usages = displayUsages(recorded);
	const active = activeProvider ? { ...activeProvider, provider: displayProvider(activeProvider.provider) } : undefined;
	if (scope) scope = { providers: [...new Set(scope.providers.map(displayProvider))], failed: new Set([...scope.failed].map(displayProvider)) };
	const activeUsage = active ? usages.find((usage) => usage.provider === active.provider) : undefined;
	const byProvider = new Map(usages.map((usage) => [usage.provider, usage] as const));
	const rows = scope
		? scope.providers.map((provider) => ({ provider, usage: byProvider.get(provider) }))
		: [...(active ? [{ provider: active.provider, usage: activeUsage }] : []), ...usages.filter((usage) => usage !== activeUsage).map((usage) => ({ provider: usage.provider, usage }))];
	if (rows.length === 0) return [truncateToWidth(USAGE_EMPTY_MESSAGE, width, "…")];
	const lines: string[] = [];
	for (const row of rows) {
		const mark = active?.provider === row.provider ? `${theme.fg(ROLE.LIMIT, ACTIVE_MARK)} ` : "";
		if (!row.usage) {
			// A settled refresh that answered nothing is a failure; a provider
			// whose usage arrives with responses (Anthropic) or that has not
			// failed keeps its pending note.
			const note = scope?.failed.has(row.provider) ? USAGE_FETCH_FAILED_NOTE : providerNote(row.provider, registry);
			lines.push(`${mark}${theme.fg(ROLE.PROVIDER, row.provider)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, note)}`);
			continue;
		}
		const usage = row.usage;
		const plan = usage.plan ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		const stale = usage.stale ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, "stale")}` : "";
		lines.push(`${mark}${theme.fg(ROLE.PROVIDER, usage.provider)}${plan} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, updatedAgo(usage.fetchedAt, now))}${stale}`);
		// One row per window: the limit name, its meter, its percentage and the reset
		// that window reports, all on one line. A window without its own label (the
		// model's allowance) is named by its limit alone, and one without a reset ends
		// at its percentage, never on a dangling separator.
		const rows = groupUsageLimits(usage.limits).flatMap((limit) =>
			limit.windows.map((window) => ({ name: [limit.name, window.label].filter((part) => part.length > 0).join(" "), window })),
		);
		const nameWidth = rows.reduce((widest, row) => Math.max(widest, row.name.length), 0);
		for (const row of rows) {
			const percent = `${Math.round(row.window.usedPercent)}%`.padStart(4);
			const reset = formatReset(row.window.resetAt, now);
			const tail = reset.length > 0 ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.RESET, reset)}` : "";
			lines.push(`  ${theme.fg(ROLE.LABEL, row.name.padEnd(nameWidth))} ${paintMeter(row.window.usedPercent, PANEL_METER_CELLS, theme, paint)} ${theme.fg(ROLE.PERCENT, percent)}${tail}`);
		}
		// Use the same sanitized account failure rows as the rail, rather than
		// inventing a zero or exposing a different account label here.
		if (usage.layout === USAGE_LAYOUT_ACCOUNTS) {
			for (const row of compactAccountRows(usage) ?? []) {
				if (row.failure !== undefined) lines.push(`  ${theme.fg(ROLE.LABEL, row.name)} ${theme.fg(ROLE.RESET, `unavailable (${row.failure})`)}`);
			}
		}
		// A failure after a good snapshot never hides either fact: the last good
		// snapshot stays on its rows and the failed refresh says so beside it.
		if (scope?.failed.has(row.provider)) lines.push(`  ${theme.fg(ROLE.RESET, USAGE_FETCH_FAILED_NOTE)}`);
	}
	return lines.map((line) => truncateToWidth(line, width, "…"));
}

// Rail card: every provider with data, whatever model the session uses. Short
// names and short resets keep each window on one row at rail width.
const CARD_PROVIDER_NAMES: Record<string, string> = { [CODEX_PROVIDER]: "codex", [ANTHROPIC_PROVIDER]: "claude", cliproxyapi: "antigravity" };
const CARD_PROVIDER_ORDER = [CODEX_PROVIDER, ANTHROPIC_PROVIDER, "cliproxyapi"];
const CARD_METER_CELLS = 8;
const COMPACT_ACCOUNT_ORDER = ["Pay01", "Pay02", "Free01", "Free02"];
const COMPACT_FAMILIES: ReadonlyArray<[family: UsageFamily, mark: string]> = [["gemini", "G"], ["claude", "C"]];
const FAILURE_MARK = "✕";
const CARD_FOOTER_HINT = "alt+u";
const COMPACT_FOOTER_HINT = "click or alt+u: details";

function shortReset(resetAt: number | null, now: number): string {
	return formatReset(resetAt, now).replace(/^resets in /, "").replace(/^resets now$/, "now");
}

export function usageCardDigest(usages: readonly ProviderUsage[], now: number): string {
	return `${Math.floor(now / 60_000)}|${usages.map((usage) => `${usage.provider}:${usage.fetchedAt}`).join(",")}`;
}

interface CompactWindow {
	window: UsageWindow;
	reached: boolean;
}

// The most constraining window: highest use, then the one that resets first.
function moreConstraining(a: CompactWindow, b: CompactWindow): CompactWindow {
	if (a.window.usedPercent !== b.window.usedPercent) return a.window.usedPercent > b.window.usedPercent ? a : b;
	return (a.window.resetAt ?? Number.POSITIVE_INFINITY) <= (b.window.resetAt ?? Number.POSITIVE_INFINITY) ? a : b;
}

function printable(text: string): string {
	return text.replace(/[^\x20-\x7e]/g, "");
}

// A Limits row before layout. Every row of the card, whatever its provider,
// lands on one column grid: `name | bar | % | reset`.
interface GridRow {
	name: string;
	// Absent on a failure row, which writes its reason across the bar/value columns.
	window?: UsageWindow;
	reached?: boolean;
	failure?: string;
}

// Account rows ordered Pay01..Free02 then the rest as first seen, one row per
// model family the account has data for (the family is a small marker inside
// the name column). An account whose quota could not be read gets a failure
// row instead; a family an account has no data for gets no row rather than 0%.
function compactAccountRows(usage: ProviderUsage): GridRow[] | undefined {
	const accounts = new Map<string, { windows: Map<UsageFamily, CompactWindow[]>; failure?: string }>();
	const entry = (label: string) => {
		let found = accounts.get(label);
		if (!found) accounts.set(label, (found = { windows: new Map() }));
		return found;
	};
	for (const limit of usage.limits) {
		if (!limit.account || !limit.family) continue;
		const family = entry(printable(limit.account)).windows;
		family.set(limit.family, [...(family.get(limit.family) ?? []), ...limit.windows.map((window) => ({ window, reached: limit.limitReached }))]);
	}
	for (const failed of usage.unavailable ?? []) {
		const account = entry(printable(failed.label));
		if (account.windows.size === 0) account.failure = printable(failed.reason);
	}
	if (accounts.size === 0) return undefined;
	const rank = (label: string) => {
		const index = COMPACT_ACCOUNT_ORDER.indexOf(label);
		return index === -1 ? COMPACT_ACCOUNT_ORDER.length : index;
	};
	// Array.sort is stable, so unknown accounts keep their first-seen order.
	const labels = [...accounts.keys()].sort((a, b) => rank(a) - rank(b));
	return labels.flatMap((label): GridRow[] => {
		const account = accounts.get(label)!;
		if (account.windows.size === 0) return [{ name: label, failure: account.failure ?? "unavailable" }];
		return COMPACT_FAMILIES.flatMap(([family, mark]): GridRow[] => {
			const windows = account.windows.get(family);
			if (!windows) return [];
			const best = windows.reduce(moreConstraining);
			return [{ name: `${label} ${mark}`, window: best.window, reached: best.reached }];
		});
	});
}

/**
 * The account failures the Limits card itself paints, as the `<label>
 * unavailable (<reason>)` notes an extension may also publish as a status.
 * The rail's Status card drops exactly these so one fact is not shown twice.
 */
export function limitsFailureNotes(usages: readonly ProviderUsage[]): string[] {
	return usages
		.filter((usage) => usage.limits.length > 0 && usage.layout === USAGE_LAYOUT_ACCOUNTS)
		.flatMap((usage) => (compactAccountRows(usage) ?? []).flatMap((row) => (row.failure === undefined ? [] : [`${row.name} unavailable (${row.failure})`])));
}

// Model tiers that read as noise next to the model name; only the ones with a
// short form are kept when dropping the tier would make two rows identical.
const MODEL_TIERS: Readonly<Record<string, string>> = { flash: "fl", pro: "pro", mini: "mini", lite: "lite", turbo: "turbo", air: "air", nano: "nano" };

function modelTokens(name: string): string[] {
	const tokens = name.split(/[-_]+/).filter((token) => token.length > 0).flatMap((token, index) => {
		const split = index === 0 ? /^([A-Za-z]+)(\d.*)$/.exec(token) : null;
		return split ? [split[1]!, split[2]!] : [token];
	});
	return tokens.map((token) => /^v\d+\.\d+$/i.test(token) ? token.slice(1) : token);
}

/**
 * Readable names for a set of model ids shown together: `mimo-v2.6-flash` ->
 * `mimo 2.6`, `deepseek-v4-flash` -> `deepseek v4`, `glm5.3-flash` -> `glm 5.3 fl`
 * (the tier stays, shortened, only when dropping it would collide with a
 * sibling such as `glm5.3`). A name that is still wider than `max` falls back
 * to plain truncation. Ids without separators or digits are left alone.
 */
export function abbreviateModelNames(names: readonly string[], max: number): string[] {
	const parts = names.map((name) => {
		const tokens = modelTokens(name);
		const last = tokens.at(-1)?.toLowerCase();
		const tier = tokens.length > 1 && last !== undefined && last in MODEL_TIERS ? last : undefined;
		return { name, base: (tier ? tokens.slice(0, -1) : tokens).join(" "), tier, tokens };
	});
	const taken = new Map<string, number>();
	for (const part of parts) taken.set(part.base, (taken.get(part.base) ?? 0) + 1);
	return parts.map((part) => {
		const simple = part.tokens.length === 1 && part.tier === undefined;
		const text = simple ? part.name : part.tier && (taken.get(part.base) ?? 0) > 1 ? `${part.base} ${MODEL_TIERS[part.tier]}` : part.base;
		return clipPlain(text, max);
	});
}

// Plain text clip: pi's truncateToWidth wraps its result in resets, and these
// names are painted by the caller afterwards.
function clipPlain(text: string, max: number): string {
	if (visibleWidth(text) <= max) return text;
	let clipped = "";
	for (const char of text) {
		if (visibleWidth(clipped + char) > max - 1) break;
		clipped += char;
	}
	return `${clipped}…`;
}

function compactTitle(usage: ProviderUsage, name: string, theme: UsageTheme): string {
	const heading = usage.heading ?? name;
	const lead = `${name} · `;
	const base = heading.startsWith(lead)
		? `${theme.fg(ROLE.PROVIDER, name)} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, heading.slice(lead.length))}`
		: theme.fg(ROLE.PROVIDER, heading);
	return usage.stale ? `${base} ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, "stale")}` : base;
}

const GRID_PERCENT_CELLS = 4;
const GRID_NAME_MIN = 4;

/**
 * How the rail card chooses its providers (S5/L24). Without options the card
 * draws exactly the providers that hold drawable snapshots, as it always has.
 * With `providers` it draws every provider the caller names, in that exact
 * order (first-seen, deduplicated), and a provider with no snapshot gets one
 * honest state line instead of silently vanishing: the failed note when its
 * latest refresh failed, else its registered pending note, else the generic
 * no-source note — the same wording and precedence `renderUsagePanel` uses.
 * `failed` is the scope's own set, so the card and the panel never disagree.
 */
export interface UsageCardOptions {
	providers?: readonly string[];
	registry?: UsageSourceRegistry;
	failed?: ReadonlySet<string>;
	/** Header and rows for the rail layout to frame, instead of a card of its own. */
	panel?: boolean;
}

export function renderUsageCard(usages: readonly ProviderUsage[], theme: UsageTheme, width: number, now: number, options?: UsageCardOptions): string[] {
	const rank = (provider: string) => {
		const index = CARD_PROVIDER_ORDER.indexOf(provider);
		return index === -1 ? CARD_PROVIDER_ORDER.length : index;
	};
	const sorted = displayUsages(usages.filter((usage) => usage.limits.length > 0)).sort((a, b) => rank(a.provider) - rank(b.provider));
	// One slot per provider either way: a named list keeps the caller's order, the
	// default keeps the card's fixed order. A provider the store holds without
	// any drawable row is still a slot, so it can explain itself below.
	const planned = options?.providers
		? [...new Set(options.providers.map(displayProvider))].map((provider) => ({ provider, usage: sorted.find((usage) => usage.provider === provider) }))
		: sorted.map((usage) => ({ provider: usage.provider, usage }));
	if (planned.length === 0) return [];
	// The rail draws Limits as a panel section: its header and rows, and the layout frames them.
	const innerWidth = options?.panel ? Math.max(1, Math.floor(width) - PANEL_ROW_INDENT) : cardInnerWidth(width);
	const sections = planned.map((slot) => {
		if (!slot.usage) {
			// A settled refresh that answered nothing is a failure; otherwise the
			// provider says what it is waiting for, exactly as the panel does.
			const note = options?.failed?.has(slot.provider) ? USAGE_FETCH_FAILED_NOTE : providerNote(slot.provider, options?.registry);
			return { title: theme.fg(ROLE.PROVIDER, CARD_PROVIDER_NAMES[slot.provider] ?? slot.provider), rows: [] as GridRow[], compact: false, note };
		}
		const usage = slot.usage;
		const name = CARD_PROVIDER_NAMES[usage.provider] ?? usage.provider;
		const compact = usage.layout === USAGE_LAYOUT_ACCOUNTS ? compactAccountRows(usage) : undefined;
		if (compact) return { title: compactTitle(usage, name, theme), rows: compact, compact: true, note: undefined };
		const plan = usage.plan && usage.plan !== name ? ` ${theme.fg(ROLE.SEPARATOR, "·")} ${theme.fg(ROLE.PLAN, usage.plan)}` : "";
		// A single limit is named by its windows; several limits are named by
		// the limit, plus the window when that limit has more than one.
		const limits = groupUsageLimits(usage.limits);
		const labelled = allowanceGroupsSupported(usage.limits);
		const rows: GridRow[] = limits.flatMap((limit) =>
			limit.windows.map((window) => ({
				name: usage.limits.length === 1 ? window.label || limit.name : [limit.name, limit.windows.length > 1 ? window.label : ""].filter(Boolean).join(" "),
				window,
				reached: limit.limitReached,
			})),
		);
		// Allowance model ids (NaN) read as words, not as clipped ids.
		const readable = labelled ? abbreviateModelNames(rows.map((row) => row.name), innerWidth) : undefined;
		return { title: `${theme.fg(ROLE.PROVIDER, name)}${plan}`, rows: readable ? rows.map((row, index) => ({ ...row, name: readable[index]! })) : rows, compact: false, note: undefined };
	});
	// One grid for every row of every provider: bars start at the same column,
	// percentages end at the same column, resets start at the same column.
	const resetOf = (row: GridRow) => (row.window ? shortReset(row.window.resetAt, now) : "");
	const resetWidth = sections.reduce((widest, section) => section.rows.reduce((inner, row) => Math.max(inner, visibleWidth(resetOf(row))), widest), 0);
	const valueWidth = CARD_METER_CELLS + 1 + GRID_PERCENT_CELLS + (resetWidth > 0 ? 1 + resetWidth : 0);
	const nameRoom = Math.max(GRID_NAME_MIN, innerWidth - 2 - valueWidth);
	const nameWidth = Math.min(nameRoom, Math.max(GRID_NAME_MIN, ...sections.flatMap((section) => section.rows.map((row) => visibleWidth(row.name)))));
	const body = sections.flatMap((section, index) => [
		...(index ? [""] : []),
		section.title,
		// A provider with no snapshot gets exactly one line saying so, never a
		// zero bar or a fabricated row.
		...(section.note === undefined ? [] : [truncateToWidth(` ${theme.fg(ROLE.RESET, section.note)}`, innerWidth, "…")]),
		...section.rows.map((row) => {
			const name = theme.fg(ROLE.LABEL, truncateToWidth(row.name, nameWidth, "…", true));
			if (!row.window) {
				const reason = truncateToWidth(`${FAILURE_MARK} ${row.failure ?? "unavailable"}`, valueWidth, "…");
				return truncateToWidth(` ${name} ${theme.fg("error", reason.slice(0, 1))}${theme.fg(ROLE.RESET, reason.slice(1))}`, innerWidth, "…");
			}
			const percent = `${Math.round(row.window.usedPercent)}%`.padStart(GRID_PERCENT_CELLS);
			const reset = resetOf(row);
			const percentText = row.reached ? theme.fg("error", percent) : theme.fg(ROLE.PERCENT, percent);
			const line = ` ${name} ${paintMeter(row.window.usedPercent, CARD_METER_CELLS, theme)} ${percentText}${resetWidth > 0 ? ` ${theme.fg(ROLE.RESET, reset.padEnd(resetWidth))}` : ""}`;
			return truncateToWidth(line, innerWidth, "…");
		}),
	]);
	const fetched = planned.flatMap((slot) => (slot.usage ? [slot.usage.fetchedAt] : []));
	const hint = sections.some((section) => section.compact) ? COMPACT_FOOTER_HINT : CARD_FOOTER_HINT;
	body.push("", theme.fg(ROLE.RESET, truncateToWidth(fetched.length > 0 ? `${updatedAgo(Math.min(...fetched), now)} · ${hint}` : hint, innerWidth, "…")));
	if (options?.panel) return [renderStaticPanelHeader(theme, width, "Limits"), ...body.map((row) => renderPanelRow(width, row))];
	return renderCard({ title: "Limits", body, tone: "info", rail: true }, theme, width, { expanded: true });
}

export class UsageStore {
	private readonly usages = new Map<string, ProviderUsage>();

	private readonly onRecord: ((usage: ProviderUsage) => void) | undefined;

	/** `onRecord` hears every reading, e.g. the model fallback cooldown. */
	constructor(onRecord?: (usage: ProviderUsage) => void) {
		this.onRecord = onRecord;
	}

	record(usage: ProviderUsage): void {
		this.usages.set(usage.provider, usage);
		try { this.onRecord?.(usage); } catch { /* A listener never breaks the usage panel. */ }
	}

	get(provider: string): ProviderUsage | undefined {
		return this.usages.get(provider);
	}

	all(): ProviderUsage[] {
		return [...this.usages.values()];
	}
}
