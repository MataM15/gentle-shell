import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellEnabled } from "../lib/shell-bar.ts";
import { isPhoneWidth, sidebarPart, sidebarState } from "../lib/shell-sidebar.ts";
import { invalidateSidebar } from "../lib/shell-sidebar-layout.ts";
import { parseWellnessConfig, WellnessSession, WELLNESS_LABELS, WELLNESS_LABELS_ES, WELLNESS_NOTICES_ES, type Reminder, type WellnessConfig } from "../lib/shell-wellness.ts";
import { WellnessStateStore, type WellnessState } from "../lib/wellness-state.ts";

const WIDGET = "gentle-wellness";
const USAGE = "Usage: /gentle-wellness reset water|break|stretch|dinner|all";
export interface WellnessStore {
	loadOrInitialize(now: number): Promise<WellnessState | undefined>;
	load(): Promise<WellnessState | undefined>;
	reset(target: string, now: number): Promise<WellnessState | undefined>;
	claimDue(key: Reminder, revision: string, now: number): Promise<boolean>;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_CODING_AGENT_DIR || getAgentDir();
}

export default function gentleWellness(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
	readConfig = () => readFileSync(join(resolveAgentDir(env), "gentle-wellness.json"), "utf8"),
	createStore: (config: WellnessConfig) => WellnessStore = (config) => new WellnessStateStore(resolveAgentDir(env), config),
) {
	let spanish = false;
	let dispose: (() => void) | undefined;
	let session: WellnessSession | undefined;
	let activeStore: WellnessStore | undefined;
	let refresh: (() => void) | undefined;
	let generation = 0;
	const stop = () => {
		generation++;
		dispose?.();
		dispose = undefined;
		session = undefined;
		activeStore = undefined;
		refresh = undefined;
	};
	pi.on("session_start", async (_event, ctx) => {
		stop();
		const current = generation;
		const isCurrent = () => generation === current;
		spanish = false;
		if (!shellEnabled(env) || ctx.mode !== "tui" || !ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET, undefined);
		let config;
		try {
			const input = JSON.parse(readConfig());
			spanish = input?.language === "es";
			config = parseWellnessConfig(input);
		} catch { return; }
		if (!config) return;
		const store = createStore(config);
		const initial = await store.loadOrInitialize(Date.now());
		if (!initial || !isCurrent()) return;
		const model = new WellnessSession(config, Date.now());
		model.applySharedState(initial);
		ctx.ui.setWidget(WIDGET, (tui, theme) => {
			if (!tui.terminal || !isCurrent()) return { render: () => [], invalidate() {} };
			session = model;
			activeStore = store;
			let paintEpoch = 0;
			const repaint = () => { paintEpoch++; invalidateSidebar(tui); tui.requestRender(); };
			const currentTheme = theme ?? ctx.ui.theme;
			// The folded band owns the card in its glyph format; the rail keeps the plain one.
			const resetGlyphs = () => sidebarState(tui).foldedBand?.() === true;
			const paint = (width: number) => isPhoneWidth(tui) ? [] : model.render(Date.now(), width, currentTheme, { resetGlyphs: resetGlyphs() });
			// Every Pi render re-lays out the whole transcript, so the poll repaints only when
			// the last painted card would change (clock minute, countdowns, visibility).
			let painted: { width: number; text: string } | undefined;
			// Explicit resets are rare; compare their visible output before invalidating.
			const refreshVisible = () => {
				if (painted) {
					const next = paint(painted.width).join("\n");
					if (next === painted.text) return;
					painted = { width: painted.width, text: next };
				}
				repaint();
			};
			refresh = refreshVisible;
			let polling = false;
			let disposed = false;
			const poll = async () => {
				if (polling || disposed) return;
				polling = true;
				try {
					const now = Date.now();
					const shared = await store.load();
					if (!shared || !isCurrent()) return;
					model.applySharedState(shared);
					// Rolled over before tick so a stale dinner never raises a late notice.
					if (model.dinnerExpired(now)) {
						const rolled = await store.reset("dinner", now);
						if (!isCurrent()) return;
						if (rolled) model.applySharedState(rolled);
					}
					for (const key of model.tick(now)) {
						const claimed = await store.claimDue(key, model.revision(key), now);
						if (!isCurrent()) return;
						if (claimed && config.notifications) ctx.ui.notify(spanish ? WELLNESS_NOTICES_ES[key] : `${WELLNESS_LABELS[key]} is due.`, "info");
					}
					const next = isCurrent() && painted ? paint(painted.width).join("\n") : undefined;
					// Recorded before the rail repaints, so a skipped paint never re-requests every second.
					if (painted && next !== undefined && next !== painted.text) {
						painted = { width: painted.width, text: next };
						repaint();
					}
				} catch { /* Persistence failures must not reject the polling timer. */ }
				finally { polling = false; }
			};
			const timer = setInterval(poll, 1000);
			timer.unref();
			const part = sidebarPart(tui, "wellness", {
				// Polls and explicit visible changes advance the epoch; reads are O(1).
				// The format flag rides it so lines cached for the rail never serve the band, or the reverse.
				digest: () => `${paintEpoch}|${resetGlyphs()}`,
				// Hidden only in paint: polling, notices, resets and persistence keep running.
				render: (width: number) => {
					const lines = paint(width);
					painted = { width, text: lines.join("\n") };
					return lines;
				},
				invalidate: () => invalidateSidebar(tui),
				handleMouse(event) {
					// Hit targets from a wider paint are stale while hidden.
					if (event.type !== "click" || event.button !== "left" || isPhoneWidth(tui)) return undefined;
					const target = model.resetTargetAt(event.x, event.y);
					if (!target) return undefined;
					void store.reset(target, Date.now()).then((state) => {
						if (!state || !isCurrent() || session !== model) return;
						model.applySharedState(state);
						refreshVisible();
					}).catch(() => {});
					return { handled: true, render: true };
				},
				dispose() {
					if (disposed) return;
					disposed = true;
					clearInterval(timer);
					if (isCurrent()) {
						generation++;
						session = undefined; activeStore = undefined; refresh = undefined; dispose = undefined;
						repaint();
					}
				},
			});
			dispose = () => part.dispose();
			repaint();
			return part;
		}, { placement: "belowEditor" });
	});
	pi.on("session_shutdown", stop);
	pi.registerCommand("gentle-wellness", {
		description: "Reset shared wellness reminders",
		handler: async (args, ctx) => {
			if (!shellEnabled(env) || ctx.mode !== "tui" || !ctx.hasUI) return;
			const [action, target, extra] = args.trim().split(/\s+/);
			if (action !== "reset" || !target || extra || !/^(water|break|stretch|dinner|all)$/.test(target)) {
				ctx.ui.notify(spanish ? USAGE.replace("Usage:", "Uso:") : USAGE, "info");
			} else if (!session) ctx.ui.notify(spanish ? "Bienestar está desactivado. Consultá docs/wellness.md para activarlo." : "Wellness is disabled. See docs/wellness.md to opt in.", "info");
			else {
				const current = generation, model = session, store = activeStore;
				const state = await store?.reset(target, Date.now());
				if (generation !== current || session !== model || activeStore !== store) return;
				if (!state) return ctx.ui.notify(spanish ? "No se pudo actualizar el estado compartido de bienestar." : "Unable to update shared wellness state.", "info");
				model.applySharedState(state);
				refresh?.();
				ctx.ui.notify(spanish ? (target === "all" ? "Recordatorios reiniciados." : `Recordatorio reiniciado: ${WELLNESS_LABELS_ES[target as keyof typeof WELLNESS_LABELS_ES]}.`) : `Wellness reset: ${target}.`, "info");
			}
		},
	});
}
