import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCard, type CardTheme } from "./shell-card.ts";
import type { WellnessState } from "./wellness-state.ts";

export const REMINDERS = ["water", "break", "stretch", "dinner"] as const;
export type Reminder = typeof REMINDERS[number];
export const WELLNESS_LABELS: Record<Reminder, string> = { water: "Water", break: "Break", stretch: "Stretch", dinner: "Dinner" };
export const WELLNESS_LABELS_ES: Record<Reminder, string> = { water: "Agua", break: "Descanso", stretch: "Estirar", dinner: "Cena" };
export const WELLNESS_NOTICES_ES: Record<Reminder, string> = { water: "Hora de tomar agua.", break: "Hora de descansar.", stretch: "Hora de estirar.", dinner: "Hora de cenar." };
const DIGITS: Record<string, string[]> = {
	"0": ["┌─┐", "│ │", "└─┘"], "1": [" ╷ ", " │ ", " ╵ "],
	"2": ["╶─┐", "┌─┘", "└─╴"], "3": ["╶─┐", " ─┤", "╶─┘"],
	"4": ["╷ ╷", "└─┤", "  ╵"], "5": ["┌─╴", "└─┐", "╶─┘"],
	"6": ["┌─╴", "├─┐", "└─┘"], "7": ["╶─┐", "  │", "  ╵"],
	"8": ["┌─┐", "├─┤", "└─┘"], "9": ["┌─┐", "└─┤", "╶─┘"],
	":": [" ", "·", "·"],
};

/** How long dinner stays due before it rolls over to the next day's time. */
export const DINNER_GRACE_MS = 60 * 60000;

export function wellnessDeadline(config: WellnessConfig, key: Reminder, now: number): number {
	if (key !== "dinner") return now + config[`${key}Minutes`] * 60000;
	const [hours, minutes] = config.dinnerTime.split(":").map(Number);
	const offset = config.utcOffsetMinutes;
	const date = new Date(now + (offset ?? 0) * 60000);
	if (offset === undefined) {
		date.setHours(hours, minutes, 0, 0);
		if (date.getTime() <= now) date.setDate(date.getDate() + 1);
		return date.getTime();
	}
	date.setUTCHours(hours, minutes, 0, 0);
	if (date.getTime() - offset * 60000 <= now) date.setUTCDate(date.getUTCDate() + 1);
	return date.getTime() - offset * 60000;
}

/** Rendering never consumes a notification; shared revisions reset local latches. */
export class WellnessSession {
	private config: WellnessConfig;
	private deadlines = new Map<Reminder, number>();
	private revisions = new Map<Reminder, string>();
	private localRevision = 0;
	private notified = new Set<Reminder>();
	private resetHits: Array<{ target: Exclude<Reminder, "dinner">; x: number; y: number }> = [];
	constructor(config: WellnessConfig, now: number) {
		this.config = config;
		this.reset("all", now);
	}
	reset(target: string, now: number): boolean {
		if (target !== "all" && !REMINDERS.includes(target as Reminder)) return false;
		for (const key of REMINDERS.filter((key) => target === "all" || target === key)) {
			this.deadlines.set(key, wellnessDeadline(this.config, key, now));
			this.revisions.set(key, `local-${++this.localRevision}`);
			this.notified.delete(key);
		}
		return true;
	}
	applySharedState(state: WellnessState): boolean {
		let changed = false;
		for (const key of REMINDERS) {
			const incoming = state.reminders[key];
			if (this.revisions.get(key) === incoming.revision && this.deadlines.get(key) === incoming.deadline) continue;
			this.deadlines.set(key, incoming.deadline);
			this.revisions.set(key, incoming.revision);
			this.notified.delete(key);
			changed = true;
		}
		return changed;
	}
	revision(key: Reminder): string { return this.revisions.get(key) ?? ""; }
	/** Dinner has no manual reset, so a deadline past its grace window is stale. */
	dinnerExpired(now: number): boolean { return now >= this.deadlines.get("dinner")! + DINNER_GRACE_MS; }
	resetTargetAt(x: number, y: number): Exclude<Reminder, "dinner"> | undefined {
		return this.resetHits.find((hit) => hit.x === x && hit.y === y)?.target;
	}
	tick(now: number): Reminder[] {
		return REMINDERS.filter((key) => {
			if (now < this.deadlines.get(key)! || this.notified.has(key)) return false;
			this.notified.add(key);
			return true;
		});
	}
	render(now: number, width: number, theme: CardTheme): string[] {
		const offset = this.config.utcOffsetMinutes;
		const date = new Date(now + (offset ?? 0) * 60000);
		const parts = offset === undefined ? [date.getHours(), date.getMinutes()] : [date.getUTCHours(), date.getUTCMinutes()];
		const time = parts.map((n) => String(n).padStart(2, "0")).join(":");
		const spanish = this.config.language === "es";
		const day = date.toLocaleDateString(spanish ? "es-AR" : "en-GB", {
			weekday: "short", day: "2-digit", month: "short", year: "numeric",
			...(offset === undefined ? {} : { timeZone: "UTC" }),
		});
		const innerWidth = Math.max(1, width - 4);
		const reminderWidth = width >= 44 ? Math.max(1, innerWidth - 17) : innerWidth;
		const reminders = REMINDERS.map((key) => {
			const minutes = Math.ceil((this.deadlines.get(key)! - now) / 60000);
			const remaining = minutes <= 0 ? (spanish ? "Ahora" : "Due") : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
			const text = `${(spanish ? WELLNESS_LABELS_ES : WELLNESS_LABELS)[key].padEnd(spanish ? 9 : 8)}${remaining}`;
			return key === "dinner" || text.length + 2 > reminderWidth ? text : `${text.padEnd(reminderWidth - 2)}↻ `;
		});
		const title = spanish ? "Bienestar" : "Wellness";
		// A due reminder must be noticed from the rail alone: the transcript notice scrolls away.
		const dueWord = spanish ? "Ahora" : "Due";
		const tone = REMINDERS.some((key) => this.deadlines.get(key)! <= now) ? "warning" : "info";
		// Styled after layout, so padding and slicing still measure plain text.
		const mark = (row: string) => row.replaceAll(dueWord, theme.fg("warning", theme.bold ? theme.bold(dueWord) : dueWord));
		if (width < 44) {
			// Narrow terminals (phones) get a compact card: the time moves into the
			// title and the reminders pack into as few rows as fit, without reset glyphs.
			this.resetHits = [];
			const compact = REMINDERS.map((key) => {
				const minutes = Math.ceil((this.deadlines.get(key)! - now) / 60000);
				const remaining = minutes <= 0 ? (spanish ? "Ahora" : "Due") : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
				return `${(spanish ? WELLNESS_LABELS_ES : WELLNESS_LABELS)[key]} ${remaining}`;
			});
			const rows: string[] = [];
			for (const item of compact) {
				const last = rows.length - 1;
				if (last >= 0 && rows[last]!.length + 3 + item.length <= innerWidth) rows[last] += ` · ${item}`;
				else rows.push(item);
			}
			return renderCard({ title, subtitle: time, tone, body: rows.map(mark), rail: true }, theme, width, { expanded: true });
		}
		const clock = [0, 1, 2].map((row) => [...time].map((digit) => DIGITS[digit][row]).join(" "));
		const right = [...clock, day];
		const body = reminders.map((line, row) => mark(line.slice(0, innerWidth - 17).padEnd(innerWidth - 17)) + right[row].padStart(17));
		const output = renderCard({ title, tone, body, rail: true }, theme, width, { expanded: true });
		this.resetHits = [];
		for (const key of REMINDERS) {
			if (key === "dinner") continue;
			const label = (spanish ? WELLNESS_LABELS_ES : WELLNESS_LABELS)[key];
			const y = output.findIndex((line) => line.includes(label) && line.includes("↻"));
			if (y < 0) continue;
			const glyph = output[y]!.indexOf("↻");
			this.resetHits.push({ target: key, x: visibleWidth(output[y]!.slice(0, glyph)), y });
		}
		return output;
	}
}

export interface WellnessConfig {
	enabled: true;
	notifications: boolean;
	waterMinutes: number;
	breakMinutes: number;
	stretchMinutes: number;
	dinnerTime: string;
	utcOffsetMinutes?: number;
	language?: "es" | "en";
}

/** Invalid or absent configuration never opts a user in. */
export function parseWellnessConfig(value: unknown): WellnessConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	if (input.enabled !== true) return undefined;
	const config = { notifications: true, waterMinutes: 30, breakMinutes: 60, stretchMinutes: 90, dinnerTime: "21:00", ...input };
	if (typeof config.notifications !== "boolean" || typeof config.dinnerTime !== "string" ||
		!/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dinnerTime)) return undefined;
	for (const minutes of [config.waterMinutes, config.breakMinutes, config.stretchMinutes]) {
		if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return undefined;
	}
	if (input.language !== undefined && input.language !== "es" && input.language !== "en") return undefined;
	const offset = input.utcOffsetMinutes;
	if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < -840 || offset > 840)) return undefined;
	return config as WellnessConfig;
}
