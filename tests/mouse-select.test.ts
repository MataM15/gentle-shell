import assert from "node:assert/strict";
import test from "node:test";
import { selectWithMouse, setFullscreenProbe } from "../lib/mouse-select.ts";

// S13 (odd/tasks/palette-button.md): sub-menus opened from the command
// palette answer the mouse in the fullscreen TUI like the palette does, and
// keep the native `ctx.ui.select` path everywhere else.

type MouseResult = { handled?: boolean; render?: boolean; focus?: boolean } | undefined;
type Component = { render(width: number): string[]; handleInput(data: string): void; handleMouse?: (event: Record<string, unknown>) => MouseResult };
type Factory = (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component;

const OPTIONS = ["gentleman", "neutral", "status"] as const;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };

// Drives the real component the helper builds: `drive` gets it rendered at
// 80 columns and returns whatever the component completed with.
function tuiContext(drive: (component: Component, lines: string[], done: () => unknown) => void) {
	const selects: unknown[][] = [];
	return {
		selects,
		ctx: {
			mode: "tui",
			ui: {
				select: async (...args: unknown[]) => {
					selects.push(args);
					return undefined;
				},
				custom: async (factory: Factory) => {
					let completed: unknown;
					let calls = 0;
					const component = factory({ requestRender() {} }, theme, {}, (value) => {
						calls++;
						completed = value;
					});
					const lines = component.render(80);
					drive(component, lines, () => completed);
					assert.ok(calls <= 1, "the select completes at most once");
					return completed;
				},
			},
		},
	};
}

function event(type: string, button: string, y: number, height: number, wheelDelta?: number) {
	return { type, button, x: 3, y, screenX: 3, screenY: y, width: 80, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

const rowOf = (lines: string[], label: string) => lines.findIndex((line) => line.includes(label));

// Gentle Shell publishes whether its TUI is fullscreen; these tests stand in for it.
test.beforeEach(() => setFullscreenProbe(() => true));
test.afterEach(() => setFullscreenProbe(undefined));

test("a click on an option resolves it, like enter", async () => {
	const { ctx, selects } = tuiContext((component, lines) => {
		component.handleMouse?.(event("click", "left", rowOf(lines, "neutral"), lines.length));
	});
	assert.equal(await selectWithMouse(ctx as never, "el Gentleman persona (current: gentleman)", OPTIONS), "neutral");
	assert.deepEqual(selects, [], "the fullscreen TUI never falls back to the native select");
});

test("the title and hint rows, presses, drags, releases and right clicks never resolve", async () => {
	const { ctx } = tuiContext((component, lines, completed) => {
		const height = lines.length;
		for (const y of [0, rowOf(lines, "Persona title"), rowOf(lines, "Esc cancel"), height - 1]) component.handleMouse?.(event("click", "left", y, height));
		const neutral = rowOf(lines, "neutral");
		for (const type of ["press", "drag", "release", "move"]) component.handleMouse?.(event(type, "left", neutral, height));
		component.handleMouse?.(event("click", "right", neutral, height));
		assert.equal(completed(), undefined, "nothing answered yet");
		component.handleInput("\r");
	});
	// A left press focuses the row it lands on (like the palette's highlight); enter then answers it.
	assert.equal(await selectWithMouse(ctx as never, "Persona title", OPTIONS), "neutral");
});

test("the wheel moves the highlight and enter resolves the moved option", async () => {
	const { ctx } = tuiContext((component, lines) => {
		const at = rowOf(lines, "gentleman");
		component.handleMouse?.(event("wheel", "none", at, lines.length, 1));
		component.handleMouse?.(event("wheel", "none", at, lines.length, 1));
		component.handleMouse?.(event("wheel", "none", at, lines.length, -1));
		component.handleInput("\r");
	});
	assert.equal(await selectWithMouse(ctx as never, "Persona", OPTIONS), "neutral");
});

test("keyboard keeps working: arrows and enter, and esc cancels with undefined", async () => {
	const arrows = tuiContext((component) => {
		component.handleInput("\x1b[B");
		component.handleInput("\x1b[B");
		component.handleInput("\r");
	});
	assert.equal(await selectWithMouse(arrows.ctx as never, "Persona", OPTIONS), "status");
	const escape = tuiContext((component) => component.handleInput("\x1b"));
	assert.equal(await selectWithMouse(escape.ctx as never, "Persona", OPTIONS), undefined);
});

test("outside the fullscreen TUI it delegates to ctx.ui.select with the same arguments", async () => {
	for (const mode of ["rpc", "print", "json"]) {
		const calls: unknown[][] = [];
		const ctx = { mode, ui: { select: async (...args: unknown[]) => { calls.push(args); return "neutral"; }, custom: async () => { throw new Error("custom must not run"); } } };
		assert.equal(await selectWithMouse(ctx as never, "Persona", OPTIONS), "neutral", mode);
		assert.deepEqual(calls, [["Persona", [...OPTIONS]]], mode);
	}
	const noCustom = { mode: "tui", ui: { select: async (...args: unknown[]) => args[1] && "gentleman" } };
	assert.equal(await selectWithMouse(noCustom as never, "Persona", OPTIONS), "gentleman", "a host without custom UI keeps the native select");
});

test("the regular (non-fullscreen) TUI and a missing or failing probe keep the native select", async () => {
	for (const probe of [() => false, undefined, () => { throw new Error("gone"); }]) {
		setFullscreenProbe(probe);
		const { ctx, selects } = tuiContext(() => { throw new Error("custom must not run"); });
		assert.equal(await selectWithMouse(ctx as never, "Persona", OPTIONS), undefined);
		assert.deepEqual(selects, [["Persona", [...OPTIONS]]]);
	}
});
