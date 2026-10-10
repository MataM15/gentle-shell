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
