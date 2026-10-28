import assert from "node:assert/strict";
import test from "node:test";
import { renderUsageCard, UsageSourceRegistry, UsageStore, type ProviderUsage } from "../lib/shell-usage.ts";
import { UsageView } from "../lib/shell-usage-view.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const now = 1_788_600_000_000;
const theme = { fg: (_role: string, text: string) => text };
const window = (usedPercent: number, hours: number) => ({ label: "5h", usedPercent, windowSeconds: 18_000, resetAt: now + hours * 3_600_000 });
const usage = (provider: string, percent: number): ProviderUsage => ({ provider, plan: undefined, fetchedAt: now, limits: [{ name: provider, limitReached: false, windows: [window(percent, 2)] }] });

test("detail shows the same cached subscription values as the rail without querying during render", () => {
 const store = new UsageStore();
 for (const item of [usage("openai-codex", 21), usage("anthropic", 32), usage("nan", 43), { ...usage("acme-cloud", 54), limits: [{ name: "Pay01 G5h", account: "Pay01", family: "gemini" as const, limitReached: false, windows: [window(54, 2)] }], layout: "accounts" as const, heading: "Acme", stale: true, unavailable: [{ label: "Pay02", reason: "HTTP 403" }] }]) store.record(item);
 const registry = new UsageSourceRegistry();
 let queries = 0;
 registry.register({ schema: "gentle-pi.usage-source/v1", provider: "acme-cloud", fetch: async () => { queries++; return undefined; } });
 const view = new UsageView(store, { theme, now: () => now, active: () => ({ provider: "openai-codex" }), registry: () => registry, scope: () => ({ providers: ["openai-codex", "anthropic", "nan", "acme-cloud"], failed: new Set() }), onRefresh: async () => { queries++; }, onClose: () => {}, requestRender: () => {} });
 const card = renderUsageCard(store.all(), theme, 80, now).map(stripAnsi).join("\n");
 const first = view.render(100).map(stripAnsi).join("\n");
 assert.equal(view.render(100).map(stripAnsi).join("\n"), first);
 assert.equal(queries, 0);
 for (const value of ["21%", "32%", "43%", "54%"]) { assert.ok(card.includes(value), value); assert.ok(first.includes(value), value); }
 for (const provider of ["openai-codex", "anthropic", "nan", "acme-cloud"]) assert.ok(first.includes(provider), provider);
 assert.match(first, /resets in 2h 0m/);
 assert.match(first, /stale/);
 assert.match(first, /Pay02.*unavailable.*HTTP 403/);
 assert.doesNotMatch(first, /✿/);
 assert.match(first, /active.*openai-codex/);
});

test("title and refreshing title contain no flower", () => {
 const view = new UsageView(new UsageStore(), { theme, now: () => now, active: () => undefined, onRefresh: () => new Promise(() => {}), onClose: () => {}, requestRender: () => {} });
 assert.doesNotMatch(view.render(80).join("\n"), /✿/);
 view.refresh();
 assert.doesNotMatch(view.render(80).join("\n"), /✿/);
});
