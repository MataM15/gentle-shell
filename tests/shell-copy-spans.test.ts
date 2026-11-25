import assert from "node:assert/strict";
import test from "node:test";
import { Container, HStack, ScrollView, sliceByColumn, stripTerminalSequences, TuiAltScreen, visibleWidth, VStack, type Terminal } from "@earendil-works/pi-tui";
import { GentlePromptEditor } from "../extensions/gentle-shell.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";

const SPANS = Symbol.for("assistant-bubbles.copySpans");
const globals = globalThis as Record<symbol, unknown>;
const plain = (_role: string, text: string) => text;
const rowKey = (row: string) => stripTerminalSequences(row).trimEnd();
const bg = (_role: string, text: string) => `\x1b[44m${text}\x1b[49m`;
const theme = { borderColor: (text: string) => text, selectList: {} };
const keys = { matches: () => false };

function editor(tui: unknown, panel = false): GentlePromptEditor {
	return new GentlePromptEditor(tui as never, theme as never, keys as never, {
		fg: plain, bg, bold: (text) => text, requestRender() {}, pending: () => false, now: () => 0,
		doubleEscCancelEnabled: () => false, dispatchQueuedText() {}, panelChrome: () => panel,
	});
}

function isolatedRegistry(run: (spans: Map<string, [number, number]>) => void): void {
	const previous = globals[SPANS];
	const spans = new Map<string, [number, number]>();
	globals[SPANS] = spans;
	try { run(spans); }
	finally { if (previous === undefined) delete globals[SPANS]; else globals[SPANS] = previous; }
}

for (const { name, style, panel, prefix } of [
	{ name: "neon", style: CARD_STYLE.NEON, panel: false, prefix: 1 },
	{ name: "float", style: CARD_STYLE.FLOAT, panel: false, prefix: 3 },
	{ name: "panel", style: CARD_STYLE.NEON, panel: true, prefix: 2 },
] as const) {
	test(`prompt copy spans: ${name} registers exactly the framed draft, not chrome`, () => {
		const previousStyle = cardStyle();
		const old = globals[SPANS];
		setCardStyle(style);
		delete globals[SPANS];
		const prompt = editor({ terminal: { rows: 24, columns: 40 }, requestRender() {} }, panel);
		try {
			prompt.setText("one│▎›\n界 second");
			const baseline = prompt.render(40);
			assert.equal(globals[SPANS], undefined, "no extension registry is created");
			isolatedRegistry((spans) => {
				const rows = prompt.render(40);
				assert.deepEqual(rows, baseline, "registration does not change the painted output");
				assert.equal(rows.length, 4);
				assert.deepEqual(spans.get(rowKey(rows[0]!)), [0, 0]);
				assert.deepEqual(spans.get(rowKey(rows[1]!)), [prefix, prefix + 6]);
				assert.deepEqual(spans.get(rowKey(rows[2]!)), [prefix, prefix + 9]);
				assert.deepEqual(spans.get(rowKey(rows[3]!)), [0, 0]);
				prompt.setText("");
				const empty = prompt.render(40);
				assert.deepEqual(spans.get(rowKey(empty[1]!)), [0, 0], "the idle hint is not draft text");
			});
		} finally {
			prompt.dispose();
			setCardStyle(previousStyle);
			if (old === undefined) delete globals[SPANS]; else globals[SPANS] = old;
		}
	});
}

test("prompt copy spans retain typed leading spaces but exclude native editor padding", () => {
	const previousStyle = cardStyle();
	setCardStyle(CARD_STYLE.NEON);
	try {
		isolatedRegistry((spans) => {
			const prompt = editor({ terminal: { rows: 24, columns: 40 }, requestRender() {} });
			try {
				prompt.setPaddingX(2);
				prompt.setText("  typed");
				const rows = prompt.render(40);
				assert.deepEqual(spans.get(rowKey(rows[1]!)), [3, 10]);
			} finally { prompt.dispose(); }
		});
	} finally { setCardStyle(previousStyle); }
});

test("prompt copy span registry is bounded and refreshes existing keys", () => {
	const previousStyle = cardStyle();
	setCardStyle(CARD_STYLE.NEON);
	try { isolatedRegistry((spans) => {
		for (let index = 0; index < 20_000; index++) spans.set(`old-${index}`, [0, 0]);
		const prompt = editor({ terminal: { rows: 24, columns: 40 }, requestRender() {} });
		try {
			prompt.setText("bounded");
			const rows = prompt.render(40);
			assert.ok(spans.size <= 20_000);
			assert.equal(spans.has("old-0"), false);
			const body = rowKey(rows[1]!);
			assert.ok(spans.has(body));
			spans.set(body, [0, 0]);
			prompt.render(40);
			assert.deepEqual(spans.get(body), [1, 8]);
			assert.equal([...spans.keys()].at(-2), body, "re-render refreshes the body key before the closing border");
		} finally { prompt.dispose(); }
	}); } finally { setCardStyle(previousStyle); }
});

// Local reproduction of assistant-bubbles' private copy hook: it looks up the
// full composed row outside a scroll view, and only slices scroll-view rows.
function installBubbleLookup(observed: Array<{ line: string; row: number; start: number; end: number }> = []): () => void {
	const prototype = TuiAltScreen.prototype as any;
	const originalColumns = prototype.getSelectionColumns;
	const originalText = prototype.getActiveSelectionText;
	prototype.getSelectionColumns = function (line: string, ...rest: any[]) {
		const result = originalColumns.call(this, line, ...rest);
		if (!result) return result;
		const [, selection, , maxColumn] = rest;
		let offset = 0;
		let row = line;
		if (rest.length >= 3 && selection?.start?.scrollView) {
			const bounds = this.getSelectionBounds?.();
			if (bounds) offset = Math.max(0, selection.start.col - bounds.start.col);
			row = sliceByColumn(line, offset, Math.max(0, (maxColumn ?? visibleWidth(line)) - offset), true);
		}
		const key = rowKey(row);
		const spans = globals[SPANS] as Map<string, [number, number]> | undefined;
		const raw = spans?.get(key) ?? spans?.get(key.slice(0, -1).trimEnd());
		if (!raw) return result;
		const start = Math.max(result.start, raw[0] + offset);
		const end = Math.max(start, Math.min(result.end, raw[1] + offset));
		observed.push({ line: rowKey(line), row: rest[0], start, end });
		return { start, end };
	};
	prototype.getActiveSelectionText = function () {
		const text = originalText.call(this);
		if (typeof text !== "string") return text;
		const trimmed = text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
		return trimmed.length === 0 ? undefined : trimmed;
	};
	return () => { prototype.getSelectionColumns = originalColumns; prototype.getActiveSelectionText = originalText; };
}

for (const { name, style, panel, prefix, width, withRail } of [
	{ name: "narrow neon", style: CARD_STYLE.NEON, panel: false, prefix: 1, width: 30, withRail: false },
	{ name: "full-width neon", style: CARD_STYLE.NEON, panel: false, prefix: 1, width: 80, withRail: false },
	{ name: "wide neon and rail", style: CARD_STYLE.NEON, panel: false, prefix: 1, width: 107, withRail: true },
	{ name: "wide float and rail", style: CARD_STYLE.FLOAT, panel: false, prefix: 3, width: 107, withRail: true },
	{ name: "wide panel and rail", style: CARD_STYLE.NEON, panel: true, prefix: 2, width: 107, withRail: true },
] as const) {
	test(`fullscreen prompt mouse copy excludes frame and padding: ${name}`, () => {
		const previousStyle = cardStyle();
		setCardStyle(style);
		try {
			isolatedRegistry(() => {
				const observed: Array<{ line: string; row: number; start: number; end: number }> = [];
				const uninstall = installBubbleLookup(observed);
				let input: ((data: string) => void) | undefined;
				const copied: string[] = [];
				const terminal: Terminal = {
					start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, columns: withRail ? 160 : width, rows: 24, kittyProtocolActive: false,
					moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
				};
				const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copySelection: async (text) => { copied.push(text); return true; } });
				const prompt = editor(tui, panel);
				prompt.setText("first│\nsecond▎›");
				const container = new Container();
				container.addChild(prompt);
				const rail = { render: () => Array.from({ length: 24 }, () => "rail content"), invalidate() {} };
				tui.setLayoutRoot(withRail ? new HStack([{ component: container, basis: width }, { component: rail, basis: 50 }], { gap: 3 }) : container);
				tui.start();
				try {
					tui.renderNow(true);
					const screen = tui.getScreenLines().map(rowKey);
					assert.match(screen[1]!, panel ? /^› first│/ : style === CARD_STYLE.FLOAT ? /^ ▎ first│/ : /^│first│/);
					if (withRail) assert.match(screen[1]!, /rail content/);
					input?.("\x1b[<0;1;2M");
					input?.(`\x1b[<32;${width};3M`);
					tui.renderNow(true);
					assert.ok(observed.some((entry) => entry.row === 1 && entry.start === prefix && entry.end === prefix + 6), "highlight clamps the first line");
					assert.ok(observed.some((entry) => entry.row === 2 && entry.start === prefix && entry.end === prefix + 8), "highlight clamps the second line");
					input?.(`\x1b[<0;${width};3m`);
					assert.deepEqual(copied, ["first│\nsecond▎›"]);
				} finally { prompt.dispose(); tui.stop(); uninstall(); }
			});
		} finally { setCardStyle(previousStyle); }
	});
}

for (const anchorChat of [true, false]) {
	test(`a drag between transcript and prompt anchored in ${anchorChat ? "transcript" : "prompt"} preserves Pi's source behavior`, () => {
		const previousStyle = cardStyle();
		setCardStyle(CARD_STYLE.NEON);
		try {
			isolatedRegistry((spans) => {
				const uninstall = installBubbleLookup();
				let input: ((data: string) => void) | undefined;
				const copied: string[] = [];
				const terminal: Terminal = {
					start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, columns: 80, rows: 24, kittyProtocolActive: false,
					moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
				};
				const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copySelection: async (text) => { copied.push(text); return true; } });
				const chat = ["│ chat one │", "│ chat two │"];
				for (const row of chat) spans.set(row, [2, 10]);
				const scroll = new ScrollView({ render: () => chat, invalidate() {} }, { primary: true, scrollbar: "auto" });
				const prompt = editor(tui);
				prompt.setText("first│\nsecond▎›");
				const container = new Container();
				container.addChild(prompt);
				tui.setLayoutRoot(new VStack([{ component: scroll, basis: 2, shrink: 0 }, { component: container, basis: "auto", shrink: 0 }]));
				tui.start();
				try {
					tui.renderNow(true);
					const screen = tui.getScreenLines().map(rowKey);
					assert.match(screen[0]!, /chat one/);
					assert.match(screen[3]!, /^│first│/);
					if (anchorChat) {
						input?.("\x1b[<0;1;1M");
						input?.("\x1b[<32;80;4M");
						input?.("\x1b[<0;80;4m");
						assert.deepEqual(copied, ["chat one\nchat two"], "a scroll-view anchor cannot leave its viewport");
					} else {
						input?.("\x1b[<0;80;4M");
						input?.("\x1b[<32;1;1M");
						input?.("\x1b[<0;1;1m");
						assert.deepEqual(copied, ["chat one\nchat two\n\nfirst│"], "the empty frame row remains a separating newline");
					}
				} finally { prompt.dispose(); tui.stop(); uninstall(); }
			});
		} finally { setCardStyle(previousStyle); }
	});
}

test("without the bubbles registry fullscreen selection keeps Pi's normal copy behavior", () => {
	const previousStyle = cardStyle();
	const previousRegistry = globals[SPANS];
	setCardStyle(CARD_STYLE.NEON);
	delete globals[SPANS];
	let input: ((data: string) => void) | undefined;
	const copied: string[] = [];
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, columns: 20, rows: 24, kittyProtocolActive: false,
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copySelection: async (text) => { copied.push(text); return true; } });
	const prompt = editor(tui);
	prompt.setText("hello");
	tui.setLayoutRoot(prompt);
	tui.start();
	try {
		tui.renderNow(true);
		input?.("\x1b[<0;1;2M");
		input?.("\x1b[<32;20;2M");
		input?.("\x1b[<0;20;2m");
		assert.deepEqual(copied, [`│hello${" ".repeat(13)}│`]);
		assert.equal(globals[SPANS], undefined);
	} finally {
		prompt.dispose();
		tui.stop();
		if (previousRegistry === undefined) delete globals[SPANS]; else globals[SPANS] = previousRegistry;
		setCardStyle(previousStyle);
	}
});
