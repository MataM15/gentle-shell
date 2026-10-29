import type { Component, TUI } from "@earendil-works/pi-tui";

// Store on the terminal, not a module singleton: extension loaders may isolate
// modules, while Pi keeps this terminal across regular/fullscreen transitions.
const STATE = Symbol.for("gentle-pi.experimental-sidebar.state");
/** In-process notification after a visual preference is persisted. */
export const VISUAL_SETTINGS_CHANGED = "gentle-pi.visual-settings-changed";
/** Phone-width terminals: Wellness and the above-editor Agents/Todos cards stay hidden. */
export const PHONE_COLUMNS = 60;
export function isPhoneWidth(tui: TUI): boolean {
	const columns = tui.terminal?.columns;
	return typeof columns === "number" && columns > 0 && columns <= PHONE_COLUMNS;
}
export interface SidebarState {
	active: boolean;
	visibility?: { todo?: boolean };
	ownsHost?: () => boolean;
	/**
	 * Columns the fullscreen rail reserves at the right edge (rail plus gap)
	 * while `active && ownsHost()`. Overlays read it to stay inside the editor
	 * column (the prompt-history picker's right margin) without importing
	 * gentle-shell.
	 */
	railColumns?: number;
	/** True while Status placement is "hidden": the bottom Status bar paints nothing at any width or mode. */
	statusHidden?: () => boolean;
	/**
	 * True when the user folded the rail away (`» hide panel` / alt+h) but the
	 * layout would show it otherwise: fullscreen, wide enough, and a Status
	 * placement that allows it. The editor offers `« panel` only then.
	 */
	railAvailable?: () => boolean;
	/** True while a painting top header is the only status row of a narrow fullscreen terminal: the bottom Status bar steps aside. */
	headerOwnsStatus?: () => boolean;
	/** Whether the current rail presents the Status section. */
	statusSectionVisible?: () => boolean;
	/** Whether Limits and Status are presented together in the current rail. */
	limitsAlongsideStatus?: () => boolean;
	parts: Map<string, SidebarRail>;
}

/** A rail slot in the fullscreen sidebar. */
export interface SidebarRail extends Component {
	/**
	 * Cheap digest of the live state this rail paints. The fullscreen layout memo
	 * re-renders a part only when its digest changes, so a rail that reads session
	 * data (model, thinking level, context, cost, extension statuses) must declare
	 * one; explicit invalidateSidebar() stays for discrete state changes.
	 */
	digest?(): string;
	/** Optional session-local counts used by the pinned activity summary. */
	activitySummary?(): { active: number; attention: number };
	commandsCount?(): number | undefined;
	waitsCount?(): number | undefined;
}
/** The header slot: one part, painted as the narrow top row or pinned above the wide rail. */
export interface SidebarHeaderRail extends SidebarRail {
	/**
	 * Rail-width rendering and hit testing for the pinned wide header. Its
	 * state is covered by the header's digest. Defaults to the part itself.
	 */
	pinned?: Component;
}
export function sidebarState(tui: TUI): SidebarState {
	const terminal = tui.terminal as unknown as Record<symbol, SidebarState>;
	return terminal[STATE] ??= { active: false, parts: new Map() };
}

/**
 * Keep the original bottom component mounted, suppressing only its paint.
 * A folded rail (`railAvailable`) keeps the Todos card hidden rather than
 * moving it above the prompt.
 */
export function sidebarPart<T extends Component & { dispose?(): void }>(tui: TUI, key: string, bottom: T, rail: SidebarRail = bottom): T {
	// Minimal extension hosts cannot share terminal-owned layout state.
	if (!tui.terminal) return bottom;
	const state = sidebarState(tui);
	state.parts.set(key, rail);
	// Hide only the bottom copies. Rail registrations, tasks and their updates
	// remain live; columns are read on every paint and pointer dispatch.
	const phoneHidden = () => (key === "agents" || key === "todo") && isPhoneWidth(tui);
	return {
		...bottom,
		render: (width: number) => phoneHidden() || (key === "todo" && (state.visibility?.todo === false || state.railAvailable?.() === true)) || (key === "footer" && (state.statusHidden?.() || state.headerOwnsStatus?.())) || (state.active && state.ownsHost?.()) ? [] : bottom.render(width),
		...(bottom.handleMouse ? { handleMouse: (event: Parameters<NonNullable<Component["handleMouse"]>>[0]) => phoneHidden() ? undefined : bottom.handleMouse?.(event) } : {}),
		dispose() {
			if (state.parts.get(key) === rail) state.parts.delete(key);
			bottom.dispose?.();
		},
	};
}

/**
 * Register the fullscreen header: pinned above the wide right rail's
 * scrollable cards, or the top row of a narrow fullscreen terminal. It
 * carries the brand, session identity, and the per-frame counters. There is
 * no regular-mode bottom counterpart — the compact bar already carries this
 * data when the sidebar is inactive — so this only ever writes the "header"
 * slot in sidebarState(tui).parts, and returns its own disposer.
 */
export function sidebarHeader(tui: TUI, rail: SidebarHeaderRail): () => void {
	if (!tui.terminal) return () => {};
	const state = sidebarState(tui);
	state.parts.set("header", rail);
	return () => {
		if (state.parts.get("header") === rail) state.parts.delete("header");
	};
}
