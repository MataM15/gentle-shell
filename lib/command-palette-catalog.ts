import type { CommandPaletteGroup, CommandPaletteItem } from "./command-palette.ts";

// The curated command set for the command palette: an OpenCode-style
// grouped menu, not a raw listing of every registered extension command.
// Only command + label live here; the live description and any shortcut
// hint are attached at build time by buildCommandPaletteGroups, from the
// actual registration and the shell's configured shortcuts.

// Icons are one terminal cell everywhere (pi-tui width 1, East Asian Width
// "N", no emoji presentation), so they never shift labels or click columns.
export interface CommandPaletteCatalogItem {
	command: string;
	label: string;
	icon?: string;
}

export interface CommandPaletteCatalogGroup {
	title: string;
	icon?: string;
	items: readonly CommandPaletteCatalogItem[];
}

export const COMMAND_PALETTE_CATALOG: readonly CommandPaletteCatalogGroup[] = [
	{
		title: "Configuration",
		icon: "⬢",
		items: [
			{ command: "gentle:profiles", label: "Models and profiles", icon: "◫" },
			{ command: "gentle:persona", label: "Switch persona", icon: "◉" },
			{ command: "gentle:review-mode", label: "Review mode (receipt-driven development)", icon: "⊛" },
			{ command: "gentle:background-subagents", label: "Background subagents", icon: "⧉" },
			{ command: "gentle:double-esc-cancel", label: "Require double Esc to cancel", icon: "⏎" },
			{ command: "gentle:customize", label: "Customization · appearance + audio notifications", icon: "❖" },
			{ command: "gentle:animations", label: "Animation mode", icon: "↻" },
			{ command: "gentle:vim", label: "Vim opt-in · Pi slash commands", icon: "❯" },
			{ command: "gentle:telemetry", label: "Telemetry", icon: "⌁" },
			{ command: "gentle:dev-binary", label: "Gentle AI dev binary", icon: "⎔" },
		],
	},
	{
		title: "Session",
		icon: "◷",
		items: [
			{ command: "gentle:yolo", label: "🚀 YOLO 🔥 session permission", icon: "↯" },
			{ command: "gentle:changes", label: "Browse changes", icon: "⇅" },
			{ command: "gentle:agents", label: "Subagents", icon: "⬡" },
			{ command: "gentle:jobs", label: "Background jobs", icon: "⧗" },
			{ command: "gentle:usage", label: "Subscription usage", icon: "◔" },
			{ command: "gentle:panel", label: "Toggle side panel", icon: "◨" },
			{ command: "gentle:review-session-permission", label: "Review session permission", icon: "✓" },
			{ command: "gentle:voice", label: "Voice dictation · local Parakeet", icon: "◉" },
			{ command: "gentle:design", label: "Design · HTML artboards", icon: "◇" },
		],
	},
	{
		title: "Diagnostics",
		icon: "✚",
		items: [
			{ command: "gentle:status", label: "Gentle AI status", icon: "⦿" },
			{ command: "gentle:doctor", label: "Doctor", icon: "⨁" },
		],
	},
	{
		title: "Skills",
		icon: "✦",
		items: [{ command: "skill-registry:refresh", label: "Refresh skill registry", icon: "⟳" }],
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
			items.push({ command: entry.command, label: entry.label, description: found.description, shortcut: shortcuts[entry.command], icon: entry.icon });
		}
		if (items.length > 0) groups.push({ title: group.title, icon: group.icon, items });
	}
	return groups;
}
