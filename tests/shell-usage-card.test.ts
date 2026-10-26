import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseAnthropicOauthUsage, renderUsageCard, usageCardDigest, UsageSourceRegistry, type ProviderUsage } from "../lib/shell-usage.ts";

const plain = { fg: (_color: string, text: string) => text };
const NOW = Date.parse("2026-09-29T10:00:00Z");

test("parses Claude OAuth usage into 5h and week windows", () => {
	const usage = parseAnthropicOauthUsage({
		five_hour: { utilization: 53, resets_at: "2026-09-29T14:50:00.146717+00:00", locked_reason: null },
		seven_day: { utilization: 66, resets_at: "2026-10-01T12:00:00+00:00", locked_reason: null },
		seven_day_opus: null,
	}, NOW);
	assert.equal(usage?.provider, "anthropic");
	assert.deepEqual(usage?.limits[0]?.windows.map((window) => [window.label, window.usedPercent]), [["5h", 53], ["week", 66]]);
	assert.equal(usage?.limits[0]?.windows[0]?.resetAt, Date.parse("2026-09-29T14:50:00.146Z"));
	assert.equal(usage?.limits[0]?.limitReached, false);
});

test("rejects Claude OAuth payloads without usable windows", () => {
	assert.equal(parseAnthropicOauthUsage(null, NOW), undefined);
	assert.equal(parseAnthropicOauthUsage({ five_hour: { utilization: "53" } }, NOW), undefined);
	assert.equal(parseAnthropicOauthUsage({ five_hour: { utilization: 100, locked_reason: "limit" } }, NOW)?.limits[0]?.limitReached, true);
});

test("renders every provider in a fixed order within the rail width", () => {
	const usages: ProviderUsage[] = [
		{ provider: "cliproxyapi", plan: "antigravity", fetchedAt: NOW, limits: [
			{ name: "gemini", limitReached: false, windows: [{ label: "week", usedPercent: 34, windowSeconds: 604_800, resetAt: NOW + 6 * 86_400_000 }] },
			{ name: "claude/gpt", limitReached: false, windows: [{ label: "week", usedPercent: 6, windowSeconds: 604_800, resetAt: null }] },
		] },
		{ provider: "openai-codex", plan: "plus", fetchedAt: NOW - 120_000, limits: [
			{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 23, windowSeconds: 18_000, resetAt: NOW + 7_800_000 }] },
		] },
	];
	const lines = renderUsageCard(usages, plain, 44, NOW);
	const text = lines.join("\n");
	assert.ok(text.includes("Limits"));
	assert.match(lines[0]!, /^╭─ Limits ─+╮$/, "a rail card title: no glyph");
	assert.ok(text.indexOf("codex") < text.indexOf("antigravity"));
	assert.ok(text.includes("5h"));
	assert.ok(text.includes("23%"));
	assert.ok(text.includes("2h 10m"));
	assert.ok(text.includes("gemini"));
	assert.ok(text.includes("updated 2m ago"));
	assert.ok(!text.includes("antigravity · antigravity"));
	for (const line of lines) assert.ok(visibleWidth(line) <= 44, line);
});

test("renders nothing without usage and digests by minute and fetch", () => {
	assert.deepEqual(renderUsageCard([], plain, 44, NOW), []);
	const usage: ProviderUsage = { provider: "anthropic", plan: undefined, fetchedAt: NOW, limits: [] };
	assert.equal(usageCardDigest([usage], NOW), usageCardDigest([usage], NOW + 1_000));
	assert.notEqual(usageCardDigest([usage], NOW), usageCardDigest([usage], NOW + 60_000));
});

test("source registry lists registered providers", () => {
	const registry = new UsageSourceRegistry();
	registry.register({ schema: "gentle-pi.usage-source/v1", provider: "cliproxyapi", fetch: async () => undefined });
	assert.deepEqual(registry.providers(), ["cliproxyapi"]);
});

// Compact Antigravity section (gentle-pi:usage-source/v1 optional layout hint).
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ERROR_MARK = "\x1b[31m✕\x1b[39m";
const marked = { fg: (color: string, text: string) => (color === "error" ? `\x1b[31m${text}\x1b[39m` : text) };
const win = (label: string, usedPercent: number, windowSeconds: number, resetAt: number | null) => ({ label, usedPercent, windowSeconds, resetAt });
const account = (label: string, family: "gemini" | "claude", windows: ReturnType<typeof win>[], limitReached = false) => ({
	name: `${label} ${family === "gemini" ? "G" : "C"}${windows[0]!.windowSeconds === 18_000 ? "5h" : "7d"}`,
	account: label,
	family,
	windows,
	limitReached,
});
function antigravity(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
	const week = win("", 0, 604_800, NOW + 6 * DAY_MS + 23 * HOUR_MS);
	const fiveHour = win("", 0, 18_000, NOW + 4 * HOUR_MS + 59 * 60_000);
	return {
		provider: "cliproxyapi",
		plan: "antigravity · used · Pay02 unavailable (HTTP 403)",
		heading: "antigravity · used",
		layout: "accounts",
		fetchedAt: NOW,
		unavailable: [{ label: "Pay02", reason: "HTTP 403" }],
		limits: [
			account("Free02", "gemini", [week]), account("Free02", "claude", [week]),
			account("Pay01", "gemini", [week]), account("Pay01", "gemini", [fiveHour]),
			account("Pay01", "claude", [week]), account("Pay01", "claude", [fiveHour]),
			account("Free01", "gemini", [week]), account("Free01", "claude", [week]),
		],
		...overrides,
	} as ProviderUsage;
}
const rows = (lines: string[]) => lines.map((line) => line.replace(/^│ ?| ?│$/g, "").trimEnd());

test("S1/S2/S3: compact Antigravity section lists one grid row per account and family in the approved order", () => {
	const lines = renderUsageCard([antigravity()], marked, 48, NOW);
	const body = rows(lines);
	assert.equal(body[1], "antigravity · used");
	assert.match(body[2]!, /^ Pay01 G +\S{8} {3}0% 4h 59m$/, "a family marker lives inside the name column; a 0% tie resolves to the soonest reset");
	assert.match(body[3]!, /^ Pay01 C +\S{8} {3}0% 4h 59m$/);
	assert.match(body[4]!, /^ Pay02 +\x1b\[31m✕\x1b\[39m HTTP 403$/, "a failure writes its reason across the bar/value columns");
	assert.equal(body[4]!.replace(/\x1b\[[0-9;]*m/g, "").indexOf("✕"), body[3]!.search(/[▰▱]/), "the reason starts where the bars start");
	assert.match(body[5]!, /^ Free01 G +\S{8} {3}0% 6d 23h$/);
	assert.match(body[7]!, /^ Free02 G +\S{8} {3}0% 6d 23h$/);
	assert.equal(body.at(-2), "updated just now · click or alt+u: details");
	assert.ok(!lines.join("\n").includes("Pay01 G7d"), "no per-window rows in the compact section");
	for (const line of lines) assert.ok(visibleWidth(line) <= 48, line);
});

test("S1: each family shows its most used window and the reset of that window", () => {
	const usage = antigravity({
		unavailable: [],
		limits: [
			account("Pay01", "gemini", [win("", 40, 604_800, NOW + 3 * DAY_MS)]),
			account("Pay01", "gemini", [win("", 12, 18_000, NOW + 2 * HOUR_MS)]),
			account("Pay01", "claude", [win("", 5, 604_800, NOW + 3 * DAY_MS)]),
			account("Pay01", "claude", [win("", 77, 18_000, NOW + 2 * HOUR_MS)]),
		],
	});
	const [, , gemini, claude] = rows(renderUsageCard([usage], marked, 48, NOW));
	assert.match(gemini!, /^ Pay01 G +\S{8} {2}40% 3d 0h$/, "G: weekly 40 beats 5h 12 and brings its own reset");
	assert.match(claude!, /^ Pay01 C +\S{8} {2}77% 2h 0m$/, "C: 5h 77 beats weekly 5 and brings its own reset");
});

test("S1: a family without data gets no row instead of 0%, and unknown accounts sort last", () => {
	const usage = antigravity({
		unavailable: [],
		limits: [
			account("Zed", "claude", [win("", 9, 604_800, NOW + DAY_MS)]),
			account("Free01", "gemini", [win("", 3, 604_800, NOW + 2 * DAY_MS)]),
			account("Pay01", "gemini", [win("", 1, 604_800, NOW + 2 * DAY_MS)]),
		],
	});
	const body = rows(renderUsageCard([usage], marked, 48, NOW));
	assert.deepEqual(body.slice(2, 5).map((line) => line.slice(0, 9).trim()), ["Pay01 G", "Free01 G", "Zed C"]);
	assert.equal(body.slice(2, 5).filter((line) => /\bC\b/.test(line.slice(0, 9))).length, 1, "no Claude row for an account that has none");
	assert.match(body[4]!, /^ Zed C +\S{8} {3}9% 1d 0h$/);
});

test("S2: stale data keeps a visible marker in the section title and the title never carries failures", () => {
	const body = rows(renderUsageCard([antigravity({ stale: true })], marked, 48, NOW));
	assert.equal(body[1], "antigravity · used · stale");
	assert.ok(!body[1]!.includes("unavailable"));
});

test("S2: an account row's failure mark uses the reached-limit color", () => {
	const text = renderUsageCard([antigravity()], marked, 48, NOW).join("\n");
	assert.ok(text.includes(`${ERROR_MARK} HTTP 403`));
});

test("S5: codex and claude sections render exactly as before", () => {
	const usages: ProviderUsage[] = [
		{ provider: "anthropic", plan: undefined, fetchedAt: NOW - 60_000, limits: [{ name: "claude", limitReached: false, windows: [win("5h", 11, 18_000, NOW + 3 * HOUR_MS + 54 * 60_000), win("week", 58, 604_800, NOW + 2 * DAY_MS + 15 * HOUR_MS)] }] },
		{ provider: "openai-codex", plan: "prolite", fetchedAt: NOW, limits: [{ name: "codex", limitReached: false, windows: [win("week", 27, 604_800, NOW + 5 * DAY_MS)] }] },
	];
	assert.deepEqual(renderUsageCard(usages, plain, 48, NOW), [
		"╭─ Limits ─────────────────────────────────────╮",
		"│ codex · prolite                              │",
		"│  week ▰▰▱▱▱▱▱▱  27% 5d 0h                    │",
		"│                                              │",
		"│ claude                                       │",
		"│  5h   ▰▱▱▱▱▱▱▱  11% 3h 54m                   │",
		"│  week ▰▰▰▰▰▱▱▱  58% 2d 15h                   │",
		"│                                              │",
		"│ updated 1m ago · alt+u                       │",
		"╰──────────────────────────────────────────────╯",
	]);
});

test("S5: a provider without the layout hint renders as before even beside a compact one", () => {
	const legacy: ProviderUsage = { provider: "cliproxyapi", plan: "antigravity", fetchedAt: NOW, limits: [{ name: "gemini", limitReached: false, windows: [win("week", 34, 604_800, null)] }] };
	const text = renderUsageCard([legacy], plain, 48, NOW).join("\n");
	assert.ok(text.includes("week") && text.includes("34%"));
	assert.ok(text.includes("updated just now · alt+u"));
	assert.ok(!text.includes("click or alt+u"), "the footer hint changes only when a compact section is drawn");
});
