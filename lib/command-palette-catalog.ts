import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";

// The command set for the command palette: an OpenCode-style grouped menu.
// It lists every user-facing command the shell registers, grouped by what
// the user is doing, so `≡ commands` never hides a shipped command; only
// command + label live here, and the live description and any shortcut hint
// are attached at build time by buildCommandPaletteGroups, from the actual
// registration and the shell's configured shortcuts. The few deliberate
// omissions live in COMMAND_PALETTE_EXCLUSIONS, and the completeness test in
// tests/command-palette.test.ts fails when a registration is in neither.

export interface CommandPaletteCatalogItem {
	command: string;
	label: string;
}

export interface CommandPaletteCatalogGroup {
	title: string;
	items: readonly CommandPaletteCatalogItem[];
}

/**
 * Registered user-facing commands the palette deliberately leaves out, with
 * the reason. The catalog completeness test (`tests/command-palette.test.ts`)
 * fails on any registration that is neither in the catalog nor here, so a new
 * command cannot silently go missing from `≡ commands`.
 */
export const COMMAND_PALETTE_EXCLUSIONS: Readonly<Record<string, string>> = {
	"gentle:commands": "it opens this palette",
	"gentle:banner": "#1664: banner settings live under Customization > Banner",
	"gentle:banner-color": "#1664: banner settings live under Customization > Banner",
	"gentle:toggle-rose": "#1664: banner settings live under Customization > Banner",
	"gentle:toggle-text-logo": "#1664: banner settings live under Customization > Banner",
	"gentle:desktop": "machine RPC entry point for Gentle Desktop, not a user action",
};

export const COMMAND_PALETTE_CATALOG: readonly CommandPaletteCatalogGroup[] = [
	{
		title: "Configuration",
		items: [
			{ command: "gentle:profiles", label: "Models and profiles" },
			{ command: "gentle:persona", label: "Switch persona" },
			{ command: "gentle:rdd", label: "RDD · receipt-driven development selector" },
			{ command: "gentle:review-mode", label: "Review mode (receipt-driven development)" },
			{ command: "gentle:background-subagents", label: "Background subagents" },
			{ command: "gentle:double-esc-cancel", label: "Require double Esc to cancel" },
			{ command: "gentle:customize", label: "Customization · appearance + audio notifications" },
			{ command: "gentle:animations", label: "Animation mode" },
			{ command: "gentle:vim", label: "Vim opt-in · Pi slash commands" },
			{ command: "gentle:telemetry", label: "Telemetry" },
			{ command: "gentle:dev-binary", label: "Gentle AI dev binary" },
			{ command: "gentle:install-delegation", label: "Repair delegation assets" },
			{ command: "gentle:install-review", label: "Repair review assets" },
		],
	},
	{
		title: "Session",
		items: [
			{ command: "gentle:guide", label: "Guided tour of Gentle Shell" },
			{ command: "gentle:yolo", label: "🚀 YOLO 🔥 session permission" },
			{ command: "gentle:mode", label: "Permissions · normal, auto, yolo" },
			{ command: "gentle:changes", label: "Browse changes" },
			{ command: "gentle:agents", label: "Subagents" },
			{ command: "gentle:jobs", label: "Background jobs" },
			{ command: "gentle:panel", label: "Sidebar panel sheet" },
			{ command: "gentle:usage", label: "Subscription usage" },
			{ command: "gentle:stats", label: "Usage stats · heatmap, tokens, cost" },
			{ command: "gentle:review-session-permission", label: "Review session permission" },
			{ command: "gentle:voice", label: "Voice dictation · local Parakeet" },
			{ command: "gentle:design", label: "Design · HTML artboards" },
		],
	},
	{
		title: "Tools",
		items: [
			{ command: "gentle:tower", label: "Gentle Tower · all sessions in the browser" },
			{ command: "gentle:images", label: "Pasted image paths" },
			{ command: "gentle:scratch", label: "Session scratch · list, clean" },
			{ command: "history", label: "Prompt history" },
			{ command: "gentle-wellness", label: "Reset wellness reminders" },
			{ command: "gentle:music", label: "Music · gentle-stream" },
		],
	},
	{
		title: "Diagnostics",
		items: [
			{ command: "gentle:status", label: "Gentle AI status" },
			{ command: "gentle:status-timing", label: "Status timing · enable, disable, show" },
			{ command: "gentle:doctor", label: "Doctor" },
			{ command: "gentle:config-snapshot", label: "Preferences snapshot · status, create" },
		],
	},
	{
		title: "Skills",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry" }],
	},
];

/**
 * Build the palette's groups for one session: keep only catalog entries
 * whose command is actually registered (so a missing extension never shows
 * a dead row), attach that registration's live description and an optional
 * shortcut hint, and drop any group left with no items. Catalog order is
 * preserved throughout.
 */
export function buildCommandPaletteGroups(registered: readonly { name: string; description?: string }[], shortcuts: Readonly<Record<string, string | undefined>>): CommandPaletteGroup[] {
	const byName = new Map(registered.map((command) => [command.name, command]));
	const groups: CommandPaletteGroup[] = [];
	for (const group of COMMAND_PALETTE_CATALOG) {
		const items: CommandPaletteItem[] = [];
		for (const entry of group.items) {
			const found = byName.get(entry.command);
			if (!found) continue;
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command] });
		}
		if (items.length > 0) groups.push({ title: group.title, items });
	}
	return groups;
}
