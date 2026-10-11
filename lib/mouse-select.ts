import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { NativeChoiceList } from "./native-choice-list.ts";
import { createNativeFullscreenInteraction } from "./native-fullscreen-interaction.ts";

// A drop-in for `ctx.ui.select` that also answers the mouse in the fullscreen
// TUI: the sub-menus the command palette opens are clicked into, so their
// options must be clickable too (odd/tasks/palette-button.md S13). It uses the
// same native choice list and fullscreen interaction as ask_user_choice: a
// clean left click on an option answers it like enter, a press highlights it,
// the wheel moves the highlight, and title/hint rows are inert. Everywhere
// else (regular mode, RPC, print, a host without custom UI) the native
// select runs as is.

type SelectContext = Pick<ExtensionContext, "mode"> & {
	ui: Pick<ExtensionContext["ui"], "select"> & Partial<Pick<ExtensionContext["ui"], "custom">>;
};

const HINT = "↑↓ navigate • Enter select • Esc cancel";

// Only the TUI knows whether it is fullscreen, and a command context has no
// TUI. Gentle Shell, which holds it, publishes a probe here; Pi loads each
// extension with its own module copy, so the probe lives in a global slot.
// Without a probe (no Gentle Shell, regular mode) the native select runs.
const FULLSCREEN_PROBE_SLOT = Symbol.for("gentle-pi.fullscreen-probe");
const probeState = globalThis as typeof globalThis & { [FULLSCREEN_PROBE_SLOT]?: () => boolean };

export function setFullscreenProbe(probe: (() => boolean) | undefined): void {
	probeState[FULLSCREEN_PROBE_SLOT] = probe;
}

/** Clears the probe only if it is still the one this owner published. */
export function releaseFullscreenProbe(probe: () => boolean): void {
	if (probeState[FULLSCREEN_PROBE_SLOT] === probe) probeState[FULLSCREEN_PROBE_SLOT] = undefined;
}

function fullscreen(): boolean {
	try {
		return probeState[FULLSCREEN_PROBE_SLOT]?.() === true;
	} catch {
		return false;
	}
}

export async function selectWithMouse(ctx: SelectContext, title: string, options: readonly string[]): Promise<string | undefined> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function" || options.length === 0 || !fullscreen()) return ctx.ui.select(title, [...options]);
	const items = options.map((label, index) => ({ id: `option-${index}`, label }));
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const list = new NativeChoiceList(items, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			hoverBackground: (text) => theme.bg("toolPendingBg", text),
		}, keybindings);
		let completed = false;
		const finish = (value: string | undefined) => {
			if (completed) return;
			completed = true;
			list.setDisabled(true);
			done(value);
		};
		list.onSelect = (item) => finish(options[items.indexOf(item)]);
		list.onCancel = () => finish(undefined);
		const container = createNativeFullscreenInteraction({
			keyboardTarget: list,
			requestRender: () => tui.requestRender(),
			mouseObserver: list.createMouseObserver(() => tui.requestRender()),
		});
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", HINT), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return container;
	});
}
