import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// Whether the user folded the right rail away (`» hide panel` / `« panel` /
// alt+h). Remembered across sessions in the Gentle config home, written the
// same atomic way as vim.json; a missing, malformed or foreign file reads as
// expanded, so the rail never disappears by accident.

export const RAIL_SCHEMA = "gentle-pi.rail/v1";
interface RailOptions { gentlePiConfigHome?: string }

function railFile(options: RailOptions): string {
	return join(options.gentlePiConfigHome ?? gentlePiConfigHome(), "rail.json");
}

export function readRailCollapsed(options: RailOptions = {}): boolean {
	try {
		const value: unknown = JSON.parse(readFileSync(railFile(options), "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== RAIL_SCHEMA || !("collapsed" in value)) return false;
		return value.collapsed === true;
	} catch {
		return false;
	}
}

export function writeRailCollapsed(collapsed: boolean, options: RailOptions = {}): string {
	const home = options.gentlePiConfigHome ?? gentlePiConfigHome();
	const path = join(home, "rail.json");
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: RAIL_SCHEMA, collapsed })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}

/**
 * Shortcut that folds and unfolds the rail. Reads GENTLE_PI_PANEL_KEY: unset
 * defaults to "alt+h" (free in Pi and Gentle); empty or "off" disables it;
 * anything else is used as-is (trimmed). Same shape as commandsKey.
 */
export function railPanelKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_PANEL_KEY?.trim();
	if (value === undefined) return "alt+h";
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}
