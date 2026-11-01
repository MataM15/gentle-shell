import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

// The voice event log (docs/voice.md, "Diagnostics"): one JSON line per voice
// event in `voice-events.log` in the voice directory, so a reading that cut
// short or a microphone that did not reopen can be explained afterwards. It
// records event names, outcomes, reasons and sizes, never reply or transcript
// text. Past maxBytes the log moves to `.1` and starts again. Logging never
// throws.

export const VOICE_LOG_FILE = "voice-events.log";

export type VoiceLog = (event: string, fields?: Record<string, unknown>) => void;

const DROPPED = new Set(["text", "transcript", "message", "markdown"]);

export function createVoiceLog(options: { dir: string; maxBytes?: number; pid?: number; now?: () => Date }): VoiceLog {
	const path = join(options.dir, VOICE_LOG_FILE);
	const maxBytes = options.maxBytes ?? 512 * 1024;
	return (event, fields = {}) => {
		try {
			const entry: Record<string, unknown> = { at: (options.now ?? (() => new Date()))().toISOString(), pid: options.pid ?? process.pid, event };
			for (const [key, value] of Object.entries(fields)) if (!DROPPED.has(key)) entry[key] = value;
			mkdirSync(options.dir, { recursive: true, mode: 0o700 });
			try {
				if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
			} catch {
				/* no log yet */
			}
			appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			/* diagnostics are best effort */
		}
	};
}
