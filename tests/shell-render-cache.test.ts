import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildShellBarModel, createFooterStatusMemo, type ShellFooterData } from "../extensions/gentle-shell.ts";
import { CHANGE_STATUS } from "../lib/shell-changes.ts";
import type { RunningJobDisplay } from "../lib/jobs-sidebar-state.ts";
import type { ReviewSidebarSnapshot } from "../lib/review-sidebar-state.ts";
import type { ProviderUsage } from "../lib/shell-usage.ts";
import { createQuietToolRenderer } from "../extensions/quiet-tools.ts";
import { cachedCard, CARD_STYLE, CARD_TONE, CardFrameCache, cardStyle, renderCard, setCardStyle, type Card, type CardTheme } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

initTheme("dark");
const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;
const footer = { getGitBranch: () => "main", getExtensionStatuses: () => new Map() } as unknown as ShellFooterData;

function sessionFixture() {
	let reads = 0;
	let projections = 0;
	let sessionId = "session-1";
	let leaf = "leaf-1";
	const entries = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
	const ctx = {
		model: { id: "model", contextWindow: 1000 },
		getContextUsage() { projections++; return { percent: 10, contextWindow: this.model.contextWindow }; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries() { reads++; return [...entries]; },
			getEntryCount: () => entries.length,
			getSessionId: () => sessionId,
			getLeafId: () => leaf,
			getCwd: () => "/repo",
			getSessionName: () => "session",
		},
	};
	return {
		ctx, entries,
		build: () => buildShellBarModel(pi, ctx as unknown as ExtensionContext, footer),
		counts: () => [reads, projections],
		branch: () => { leaf = "other-leaf"; },
		switchSession: () => { sessionId = "session-2"; },
	};
}

test("settled shell chrome scans stats once while presentation stays live", () => {
	const fixture = sessionFixture();
	assert.equal(fixture.build().costTotal, 1);
	for (let frame = 0; frame < 20; frame++) fixture.build();
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.ctx.sessionManager.getSessionName = () => "renamed";
	assert.equal(fixture.build().sessionName, "renamed");
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.entries.push(fixture.entries[0]!);
	assert.equal(fixture.build().costTotal, 2);
	fixture.branch(); fixture.build();
	fixture.switchSession(); fixture.build();
	fixture.ctx.model = { ...fixture.ctx.model, id: "new-model" }; fixture.build();
	fixture.ctx.model.contextWindow = 2000;
	assert.equal(fixture.build().contextWindow, 2000);
	assert.deepEqual(fixture.counts(), [6, 6]);
	const other = sessionFixture(); other.build();
	assert.deepEqual(other.counts(), [1, 1], "manager identities do not share statistics");
});

test("leaf-based stats work on read-only hosts without an entry-count method", () => {
	const fixture = sessionFixture();
	Reflect.deleteProperty(fixture.ctx.sessionManager, "getEntryCount");
	fixture.build(); fixture.build();
	assert.deepEqual(fixture.counts(), [1, 1]);
	fixture.branch(); fixture.build();
	assert.deepEqual(fixture.counts(), [2, 2]);
});

function countingTheme() {
	let calls = 0;
	let prefix = "";
	return {
		theme: {
			fg: (_color: string, text: string) => { calls++; return prefix + text; },
			bg: (_color: string, text: string) => { calls++; return `\x1b[48;5;235m${text}\x1b[49m`; },
			bold: (text: string) => text,
		},
		calls: () => calls,
		change: () => { prefix += "!"; },
	};
}

for (const expanded of [false, true]) test(`settled tool cards cache complete rows (expanded=${expanded})`, () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls, change } = countingTheme();
		const renderer = createQuietToolRenderer("read");
		const context = { args: { path: "src/example.ts" }, state: {}, isPartial: false, executionStarted: true };
		const result = { content: [{ type: "text" as const, text: "first line\nsecond line" }], details: {} };
		const cards = [renderer.renderCall!(context.args, theme as never, context as never),
			renderer.renderResult!(result, { expanded, isPartial: false }, theme as never, context as never)];
		for (const card of cards) {
			const rows = card.render(80);
			const warm = calls();
			for (let frame = 0; frame < 20; frame++) assert.deepEqual(card.render(80), rows);
			assert.equal(calls(), warm, "warm frames do not rebuild decorated lines");
			assert.notDeepEqual(card.render(40), rows, "width invalidates layout");
			setCardStyle(CARD_STYLE.FLOAT);
			assert.notDeepEqual(card.render(80), rows, "style changes apply without host invalidation");
			setCardStyle(CARD_STYLE.NEON);
			card.render(80);
			change(); card.invalidate();
			assert.notDeepEqual(card.render(80), rows, "theme invalidation rebuilds colored content");
		}
	} finally { setCardStyle(previous); }
});

test("cached call chrome observes a result mark on its shared row state", () => {
	const { theme } = countingTheme();
	const renderer = createQuietToolRenderer("read");
	const context = { args: { path: "file.ts" }, state: {}, isPartial: true, executionStarted: true };
	const call = renderer.renderCall!(context.args, theme as never, context as never);
	const running = call.render(80);
	assert.ok(running.join("\n").includes("running"));
	renderer.renderResult!({ content: [], details: {} }, { expanded: false, isPartial: false }, theme as never, context as never);
	assert.ok(!call.render(80).join("\n").includes("running"), "result arrival removes the call's running/closing rows");
});

test("image renderers keep their live geometry instead of caching opaque components", () => {
	const { theme } = countingTheme();
	let renders = 0;
	const renderer = createQuietToolRenderer("read", undefined, undefined, () => ({
		render: () => [`image geometry ${++renders}`], invalidate() {},
	}));
	const card = renderer.renderResult!({ content: [{ type: "image", data: "", mimeType: "image/png" }], details: {} },
		{ expanded: true, isPartial: false }, theme as never, {} as never);
	assert.notDeepEqual(card.render(80), card.render(80));
});

function footerMemoFixture() {
	let reads = 0;
	let projections = 0;
	let leaf = "leaf-1";
	const entries = [{ type: "message", message: { role: "assistant", usage: { cost: { total: 1 } } } }];
	// One stable model object, replaced only by setModelId: real hosts keep the
	// model identity stable, and sessionStatsKey compares it by identity.
	let model: { id: string; contextWindow: number } = { id: "model", contextWindow: 1000 };
	const ctx = {
		get model() { return model; },
		getContextUsage() { projections++; return { percent: 10, contextWindow: 1000 }; },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getEntries() { reads++; return [...entries]; },
			getEntryCount: () => entries.length,
			getSessionId: () => "session-1",
			getLeafId: () => leaf,
			getCwd: () => "/repo",
			getSessionName: () => "session",
		},
	};
	let branch: string | null = "main";
	let statuses = new Map<string, string>();
	let usage: ProviderUsage | undefined;
	let added = 0;
	let deleted = 0;
	let unbornRoots = 0;
	let review: ReviewSidebarSnapshot | undefined;
	let jobs: RunningJobDisplay[] | undefined;
	let settings: unknown = { statusPlacement: "auto" };
	let style: unknown = "comfortable";
	const footerData = { getGitBranch: () => branch, getExtensionStatuses: () => statuses } as unknown as ShellFooterData;
	let profile: string | undefined = "team";
	let profileTier: "standard" | "fast" | undefined;
	const memo = createFooterStatusMemo({
		pi, ctx: ctx as unknown as ExtensionContext, footerData,
		usage: () => usage,
		profile: () => profile,
		profileTier: () => profileTier,
		jobs: () => jobs,
		review: () => review,
		tracker: () => ({ model: { files: [{ path: "a.ts", status: CHANGE_STATUS.MODIFIED, added, deleted }], added, deleted }, unbornRoots: Array.from({ length: unbornRoots }, () => "root") }),
		visualSettings: () => settings,
		cardStyle: () => style,
	});
	return {
		ctx: ctx as unknown as ExtensionContext & { sessionManager: { getLeafId?: () => string } },
		memo,
		counts: () => [reads, projections],
		setLeaf: (value: string) => { leaf = value; },
		spend: () => { entries[0]!.message.usage.cost.total += 1; },
		setModelId: (value: string) => { model = { ...model, id: value }; },
		setProfile: (value: string | undefined) => { profile = value; },
		setProfileTier: (value: "standard" | "fast") => { profileTier = value; },
		setBranch: (value: string | null) => { branch = value; },
		setStatuses: (value: Map<string, string>) => { statuses = value; },
		setUsage: (value: ProviderUsage | undefined) => { usage = value; },
		setChangeCounts: (nextAdded: number, nextDeleted: number) => { added = nextAdded; deleted = nextDeleted; },
		setUnbornRoots: (value: number) => { unbornRoots = value; },
		setReview: (value: ReviewSidebarSnapshot | undefined) => { review = value; },
		setJobs: (value: RunningJobDisplay[] | undefined) => { jobs = value; },
		setSettings: (value: unknown) => { settings = value; },
		setStyle: (value: unknown) => { style = value; },
	};
}

test("the footer status memo reuses one model while live inputs hold still", () => {
	const f = footerMemoFixture();
	const first = f.memo.model();
	assert.equal(first.costTotal, 1);
	assert.deepEqual(first.changes, { files: 1, added: 0, deleted: 0 });
	for (let frame = 0; frame < 10; frame++) assert.equal(f.memo.model(), first, "stable inputs reuse the built model");
	assert.deepEqual(f.counts(), [1, 1], "warm frames never rescan the session");
});

test("the footer status digest key notices every live input the model reads", () => {
	const f = footerMemoFixture();
	const before = f.memo.key();
	assert.equal(f.memo.key(), before, "the key is deterministic while nothing moves");
	const mutations: Array<[string, () => void]> = [
		["branch", () => f.setBranch("feature")],
		["profile", () => f.setProfile("other (local)")],
		["profile tier", () => f.setProfileTier("fast")],
		["statuses", () => f.setStatuses(new Map([["jobs", "1 running"]]))],
		["usage", () => f.setUsage({ provider: "p", plan: undefined, limits: [], fetchedAt: 1 })],
		["change counts", () => f.setChangeCounts(2, 1)],
		["unborn roots", () => f.setUnbornRoots(1)],
		["review", () => f.setReview({ state: "open", scope: undefined } as unknown as ReviewSidebarSnapshot)],
		["jobs", () => f.setJobs([{ id: "j", label: "l", startedAt: 0 }])],
		["visual settings", () => f.setSettings({ statusPlacement: "bottom" })],
		["card style", () => f.setStyle("compact")],
		["model", () => f.setModelId("new-model")],
		["cwd", () => (f.ctx.sessionManager as { getCwd(): string }).getCwd = () => "/other"],
		["session name", () => (f.ctx.sessionManager as { getSessionName(): string }).getSessionName = () => "renamed"],
		["leaf", () => f.setLeaf("leaf-2")],
	];
	let previous = before;
	for (const [name, mutate] of mutations) {
		mutate();
		const current = f.memo.key();
		assert.notEqual(current, previous, `a moved ${name} changes the digest key`);
		previous = current;
	}
	// A branch or profile move rebuilds the model without rescanning statistics:
	// the model object identity stays stable across those rebuilds.
	const settled = f.memo.model();
	assert.equal(settled.profileTier, "fast", "the footer receives the configured tier after cache invalidation");
	const [reads, projections] = f.counts();
	f.setBranch("release");
	assert.notEqual(f.memo.model(), settled);
	assert.deepEqual(f.counts(), [reads, projections]);
});

test("a moved leaf rebuilds the footer model with fresh statistics", () => {
	const f = footerMemoFixture();
	const first = f.memo.model();
	f.setLeaf("leaf-2");
	const second = f.memo.model();
	assert.notEqual(second, first);
	assert.deepEqual(f.counts(), [2, 2]);
	assert.equal(f.memo.model(), second, "the fresh model is memoized again");
});

test("hosts without leaf identity stay honest through the digest key's values", () => {
	const f = footerMemoFixture();
	assert.equal(f.memo.key(), f.memo.key(), "the key stays deterministic on uncached hosts");
	Reflect.deleteProperty(f.ctx.sessionManager, "getLeafId");
	const first = f.memo.model();
	f.spend();
	const second = f.memo.model();
	assert.notEqual(second, first, "a changed cost value rebuilds the model without leaf identity");
	assert.equal(second.costTotal, 2);
});

// Conversation cards (agent answers, job notices, review preflight, orchestrator
// messages) used to rebuild through renderCard on every frame. The shared cached
// card component in lib/shell-card.ts replays the previous rows instead.

function conversationCard(line: string): Card {
	return { title: "Agent answer", subtitle: "explore · task t1", body: [`${line} one`, `${line} two`, `${line} three`, `${line} four`], tone: CARD_TONE.INFO, glyph: "◆" };
}

test("settled conversation cards replay one frame until a card input moves", () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls, change } = countingTheme();
		let content = "answer";
		let expanded = false;
		let previewRows = 3;
		let hint = "ctrl+o to expand";
		let activeTheme = theme;
		const component = cachedCard({
			card: () => conversationCard(content),
			theme: () => activeTheme as CardTheme,
			options: () => ({ expanded, previewRows, hint }),
		});
		const uncached = (width = 98) => renderCard(conversationCard(content), activeTheme as CardTheme, width, { expanded, previewRows, hint });
		const rows = component.render(98);
		assert.deepEqual(rows, uncached(), "the cache draws the same bytes as the uncached card");
		for (let frame = 0; frame < 20; frame++) assert.equal(component.render(98), rows, "warm frames return the same line-array instance (issue #2860)");
		const warm = calls();
		for (let frame = 0; frame < 20; frame++) component.render(98);
		assert.equal(calls(), warm, "warm frames do not rebuild decorated lines");

		const narrow = component.render(40);
		assert.notEqual(narrow, rows, "width invalidates layout");
		assert.deepEqual(narrow, uncached(40));
		hint = "ctrl+o to collapse";
		const rehinted = component.render(98);
		assert.notEqual(rehinted, narrow, "a changed hint invalidates the heading");
		assert.deepEqual(rehinted, uncached());
		expanded = true;
		const wide = component.render(98);
		assert.notEqual(wide, rehinted, "expanded invalidates the body");
		assert.deepEqual(wide, uncached());
		previewRows = 4;
		const deeper = component.render(98);
		assert.notEqual(deeper, wide, "a changed preview budget invalidates the body");
		assert.deepEqual(deeper, uncached());
		content = "updated";
		const updated = component.render(98);
		assert.notEqual(updated, deeper, "changed content invalidates the card");
		assert.match(stripAnsi(updated.join("\n")), /updated two/, "the new content is what renders");
		// A new theme object with the same behavior keeps the bytes but must still
		// be re-read: a different theme can carry different roles.
		activeTheme = { fg: theme.fg, bg: theme.bg, bold: theme.bold };
		const retheme = component.render(98);
		assert.notEqual(retheme, updated, "a new theme object invalidates the colored rows");
		assert.deepEqual(retheme, uncached(), "an identical theme draws identical bytes");
		setCardStyle(CARD_STYLE.FLOAT);
		const float = component.render(98);
		assert.notDeepEqual(float, retheme, "style changes apply without host invalidation");
		assert.deepEqual(float, uncached());
		setCardStyle(CARD_STYLE.NEON);
		assert.deepEqual(component.render(98), uncached(), "switching back redraws the outlined bytes");
		change();
		const before = calls();
		component.invalidate();
		const rebuilt = component.render(98);
		assert.notEqual(rebuilt, updated, "invalidate drops the cached frame");
		assert.notEqual(calls(), before, "invalidate forces a rebuild");
		assert.deepEqual(rebuilt, uncached());
	} finally { setCardStyle(previous); }
});

test("cached conversation cards match the uncached bytes in every layout", () => {
	const previous = cardStyle();
	try {
		const { theme } = countingTheme();
		const card = conversationCard("answer");
		const options = { expanded: false, previewRows: 3, hint: "ctrl+o to expand" };
		for (const style of [CARD_STYLE.NEON, CARD_STYLE.FLOAT]) {
			setCardStyle(style);
			for (const expanded of [false, true]) {
				for (const width of [98, 180]) {
					const layout = { ...options, expanded };
					const component = cachedCard({ card: () => card, theme: () => theme as CardTheme, options: () => layout });
					const cached = component.render(width);
					assert.deepEqual(cached, renderCard(card, theme as CardTheme, width, layout), `${style} expanded=${expanded} width=${width}`);
					assert.equal(component.render(width), cached, "the warm frame replays the same array");
				}
			}
		}
	} finally { setCardStyle(previous); }
});

test("a presentation variant change re-renders the card without changing its bytes", () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls } = countingTheme();
		let density = "comfortable";
		const component = cachedCard({
			card: () => conversationCard("answer"),
			theme: () => theme as CardTheme,
			options: () => ({ expanded: false, previewRows: 3 }),
			variant: () => density,
		});
		const first = component.render(98);
		assert.equal(component.render(98), first);
		const before = calls();
		density = "compact";
		const after = component.render(98);
		assert.notEqual(after, first, "a moved variant invalidates the frame");
		assert.notEqual(calls(), before, "the variant forces a rebuild");
		const warm = calls();
		assert.equal(component.render(98), after, "the new variant caches");
		assert.equal(calls(), warm, "warm frames decorate nothing");
		assert.deepEqual(after, first, "the variant alone does not change the bytes");
	} finally { setCardStyle(previous); }
});

test("warm conversation-card frames stay bounded while uncached frames rebuild every card", () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls } = countingTheme();
		const cards = Array.from({ length: 200 }, (_, index) => conversationCard(`card ${index}`));
		const options = { expanded: false, previewRows: 4 };
		const components = cards.map((card) => cachedCard({ card: () => card, theme: () => theme as CardTheme, options: () => options }));
		for (const component of components) component.render(98);
		const uncachedFrame = () => { for (const card of cards) renderCard(card, theme as CardTheme, 98, options); };
		uncachedFrame();
		const frames = 20;
		let start = performance.now();
		for (let frame = 0; frame < frames; frame++) uncachedFrame();
		const uncached = (performance.now() - start) / frames;
		for (let frame = 0; frame < frames; frame++) for (const component of components) component.render(98);
		const warm = calls();
		start = performance.now();
		for (let frame = 0; frame < frames; frame++) for (const component of components) component.render(98);
		const cached = (performance.now() - start) / frames;
		assert.equal(calls(), warm, "cached warm frames decorate nothing, whatever the transcript size");
		assert.ok(cached < uncached / 4, `cached frames (${cached.toFixed(3)} ms) stay well under uncached ones (${uncached.toFixed(2)} ms)`);
	} finally { setCardStyle(previous); }
});

test("card frame caches replay the same rows until a declared input moves", () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		let dep: string | undefined = "a";
		const cache = new CardFrameCache();
		const build = (width: number) => [`built for ${dep} at ${width}`];
		const first = cache.render(98, () => [dep], build);
		assert.deepEqual(first, ["built for a at 98"]);
		assert.equal(cache.render(98, () => [dep], build), first, "warm frames return the same line-array instance");
		assert.notEqual(cache.render(40, () => [dep], build), first, "width invalidates the frame");
		dep = "b";
		assert.deepEqual(cache.render(98, () => [dep], build), ["built for b at 98"], "a moved declared input rebuilds");
		dep = undefined;
		assert.deepEqual(cache.render(98, () => [dep], build), ["built for undefined at 98"], "undefined inputs key like any other value");
		const invalidated = cache.render(98, () => [dep], build);
		cache.invalidate();
		assert.notEqual(cache.render(98, () => [dep], build), invalidated, "invalidate drops the cached frame");
	} finally { setCardStyle(previous); }
});

test("a rebuilt conversation card reuses the cache of its identity", () => {
	const previous = cardStyle();
	try {
		setCardStyle(CARD_STYLE.NEON);
		const { theme, calls } = countingTheme();
		const message = { customType: "gentle-agents.result", content: "All done." };
		const build = () => cachedCard({
			identity: message,
			card: () => conversationCard("answer"),
			theme: () => theme as CardTheme,
			options: () => ({ expanded: false, previewRows: 3 }),
		});
		const first = build().render(98);
		assert.equal(build().render(98), first, "a rebuilt component replays the identity's frame (issue #2860)");
		const warm = calls();
		for (let rebuild = 0; rebuild < 5; rebuild++) assert.equal(build().render(98), first);
		assert.equal(calls(), warm, "rebuilt components do not rebuild decorated lines");
	} finally { setCardStyle(previous); }
});
