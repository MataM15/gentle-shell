import { sliceByColumn, stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { PromptLayout } from "./shell-prompt.ts";

// The owner's assistant-bubbles extension owns this optional shared registry
// and the selection clamp. Do not create it when that extension is absent.
const SPANS = Symbol.for("assistant-bubbles.copySpans");
const MAX_SPANS = 20_000;
type Span = [number, number];
interface PromptCopyFrame { width: number; rows: Map<string, Span> }

function registry(): Map<string, Span> | undefined {
	const value = (globalThis as Record<symbol, unknown>)[SPANS];
	return value instanceof Map ? value as Map<string, Span> : undefined;
}

function key(row: string): string {
	return stripTerminalSequences(row).trimEnd();
}

function mark(spans: Map<string, Span>, plain: string, span: Span): void {
	spans.delete(plain);
	spans.set(plain, span);
	if (spans.size > MAX_SPANS) {
		let drop = spans.size - MAX_SPANS + 1000;
		for (const old of spans.keys()) {
			if (drop-- <= 0) break;
			spans.delete(old);
		}
	}
}

/** Register the final frame without touching the rendered bytes. */
export function registerPromptCopyRows(
	rows: string[], nativeRows: string[], frameStart: number, frameEnd: number,
	layout: PromptLayout, nativePadding: number, emptyDraft: boolean,
): PromptCopyFrame | undefined {
	const spans = registry();
	if (!spans) return undefined;
	const frame: PromptCopyFrame = { width: layout.width, rows: new Map() };
	const padding = Math.min(nativePadding, Math.max(0, Math.floor((layout.nativeWidth - 1) / 2)));
	for (let index = frameStart; index < rows.length; index++) {
		let span: Span = [0, 0];
		const nativeIndex = index - frameStart;
		if (!emptyDraft && layout.width >= 2 && nativeIndex > 0 && nativeIndex < frameEnd - 1) {
			// Native padding is known geometry. Whitespace before the text remains
			// inside the span; trimEnd only removes indistinguishable right padding,
			// which the TUI itself also trims from copied lines.
			const start = layout.prefixWidth + padding;
			const end = layout.prefixWidth + Math.min(layout.nativeWidth, visibleWidth(key(nativeRows[nativeIndex] ?? "")));
			if (end > start) span = [start, end];
		}
		const plain = key(rows[index] ?? "");
		frame.rows.set(plain, span);
		mark(spans, plain, span);
	}
	return frame;
}

type Columns = { start: number; end: number } | undefined;
type Selection = { start?: { scrollView?: unknown } };
type ColumnFn = (line: string, row: number, selection: Selection, ...limits: number[]) => Columns;
type SelectionHost = { mode?: string; getSelectionColumns?: ColumnFn };
type Bridge = { sources: Set<() => PromptCopyFrame | undefined>; remove(): void };
const bridges = new WeakMap<object, Bridge>();

/**
 * Outside a ScrollView Pi passes the composed screen row to the bubble lookup.
 * Its editor starts at column zero in Gentle's native and rail layouts. On a
 * selection only, identify that known-width editor slice and register the
 * actual composed key (which may also contain the rail). No glyph is stripped.
 */
export function installPromptCopyBridge(tui: TUI, source: () => PromptCopyFrame | undefined): () => void {
	const host = tui as unknown as SelectionHost;
	if (host.mode !== "fullscreen" || typeof host.getSelectionColumns !== "function") return () => {};
	let bridge = bridges.get(host);
	if (!bridge) {
		const descriptor = Object.getOwnPropertyDescriptor(host, "getSelectionColumns");
		const original = host.getSelectionColumns;
		const sources = new Set<() => PromptCopyFrame | undefined>();
		const wrapped: ColumnFn = function (this: SelectionHost, line, row, selection, ...limits) {
			const spans = registry();
			if (spans && !selection?.start?.scrollView) {
				for (const getFrame of sources) {
					const frame = getFrame();
					if (!frame) continue;
					const editorRow = key(sliceByColumn(line, 0, frame.width, true));
					const span = frame.rows.get(editorRow);
					if (span) { mark(spans, key(line), span); break; }
				}
			}
			// Resolve inherited patches at call time: bubbles may load after the editor.
			const next = descriptor ? original : (Object.getPrototypeOf(host) as SelectionHost).getSelectionColumns;
			return next?.call(this, line, row, selection, ...limits);
		};
		host.getSelectionColumns = wrapped;
		bridge = {
			sources,
			remove() {
				if (host.getSelectionColumns === wrapped) {
					if (descriptor) Object.defineProperty(host, "getSelectionColumns", descriptor);
					else delete host.getSelectionColumns;
				}
				bridges.delete(host);
			},
		};
		bridges.set(host, bridge);
	}
	const active = bridge;
	active.sources.add(source);
	let removed = false;
	return () => {
		if (removed) return;
		removed = true;
		active.sources.delete(source);
		if (active.sources.size === 0) active.remove();
	};
}
