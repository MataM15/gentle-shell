import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import {
	CONFIG_SNAPSHOT_COMMAND,
	CONFIG_SNAPSHOT_USAGE,
	createConfigSnapshot,
	formatSnapshotStatus,
	inspectConfigSnapshot,
	parseSnapshotArgs,
} from "../lib/config-snapshot.ts";

// /gentle:config-snapshot is a human-only backup path for the protected Gentle
// AI config home. It registers no tool, starts no work at load, and refuses
// every non-TUI mode: the model can neither call it nor reach the config home
// through its own tools. The existing guard in lib/auto-permission-runtime.ts
// remains the authority for model access and is not touched here.

export interface ConfigSnapshotDeps {
	env?: NodeJS.ProcessEnv;
	configHome?: () => string;
	/** This package's source root; snapshots inside it are refused. */
	sourceRoot?: () => string;
}

export default function configSnapshotExtension(pi: ExtensionAPI, deps: ConfigSnapshotDeps = {}): void {
	const env = deps.env ?? process.env;
	const configHome = deps.configHome ?? (() => gentlePiConfigHome(env));
	const sourceRoot = deps.sourceRoot ?? (() => resolve(dirname(fileURLToPath(import.meta.url)), ".."));

	const requireHumanTui = (ctx: ExtensionContext): boolean => {
		if (ctx.hasUI && ctx.mode === "tui") return true;
		ctx.ui.notify(`/${CONFIG_SNAPSHOT_COMMAND} is a human-only command and runs only in the interactive TUI. It cannot be executed headless.`, "warning");
		return false;
	};

	pi.registerCommand(CONFIG_SNAPSHOT_COMMAND, {
		description: "Inspect or create a verified, human-confirmed snapshot of fixed noncredential Gentle AI preferences (status|create <absolute-dir>).",
		getArgumentCompletions: (prefix) => ["status", "create", "help"].filter((value) => value.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			if (!requireHumanTui(ctx)) return;
			const parsed = parseSnapshotArgs(args);
			if (parsed.kind === "status") {
				const status = inspectConfigSnapshot({ configHome: configHome() });
				ctx.ui.notify(formatSnapshotStatus(status).join("\n"), status.refusals > 0 ? "warning" : "info");
				return;
			}
			if (parsed.kind === "help" || parsed.kind === "error") {
				ctx.ui.notify(`${parsed.kind === "error" ? `${parsed.message}\n\n` : ""}${CONFIG_SNAPSHOT_USAGE}`, "warning");
				return;
			}
			const destination = resolve(parsed.destination);
			const confirmed = await ctx.ui.confirm(
				"Create Gentle AI config snapshot?",
				[
					`Write verified copies of fixed noncredential preference files to:`,
					destination,
					"",
					"The destination must not exist. Credentials, auth stores, .env files, memory, sessions, logs, and cache are never read.",
					"No restore, import, or apply is included; this is a one-way copy.",
				].join("\n"),
			);
			if (!confirmed) {
				ctx.ui.notify("Config snapshot cancelled; nothing was written.", "info");
				return;
			}
			const result = createConfigSnapshot({
				configHome: configHome(),
				destination,
				projectRoot: ctx.cwd,
				sourceRoot: sourceRoot(),
			});
			ctx.ui.notify(result.lines.join("\n"), result.ok ? "info" : "error");
		},
	});
}
