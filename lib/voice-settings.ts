import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";

// The persisted push-to-talk toggle (hold Space to dictate). It lives in the
// Gentle AI config home next to the other per-feature preference files, never
// inside the voice directory, so reading it touches no voice install. A
// missing, malformed or foreign file reads as off.

export const VOICE_SETTINGS_SCHEMA = "gentle-pi.voice-settings/v1";
export const VOICE_SETTINGS_FILE = "voice-settings.json";

export interface VoiceSettingsOptions {
	env?: NodeJS.ProcessEnv;
	gentlePiConfigHome?: string;
}

const homeFor = (options: VoiceSettingsOptions) => options.gentlePiConfigHome ?? gentlePiConfigHome(options.env);

export function parseVoiceSettingsFile(raw: string): boolean | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== VOICE_SETTINGS_SCHEMA || !("pushToTalk" in value)) return undefined;
		return typeof value.pushToTalk === "boolean" ? value.pushToTalk : undefined;
	} catch { return undefined; }
}

export function readVoicePushToTalk(options: VoiceSettingsOptions = {}): boolean {
	try {
		return parseVoiceSettingsFile(readFileSync(join(homeFor(options), VOICE_SETTINGS_FILE), "utf8")) ?? false;
	} catch {
		return false;
	}
}

export function writeVoicePushToTalk(enabled: boolean, options: VoiceSettingsOptions = {}): string {
	const home = homeFor(options);
	const path = join(home, VOICE_SETTINGS_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: VOICE_SETTINGS_SCHEMA, pushToTalk: enabled })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}

// The sessions where voice is on (docs/voice.md, "Voice in a session"): replies
// are read aloud there and the dictation shortcut starts a hands-free
// conversation. One shared file lists Pi session ids, newest last, so a
// session keeps its choice across reloads and every Pi process can read it. A
// missing, malformed or foreign file reads as no session.

export const VOICE_SESSIONS_SCHEMA = "gentle-pi.voice-sessions/v1";
export const VOICE_SESSIONS_FILE = "voice-sessions.json";
export const VOICE_SESSIONS_LIMIT = 64;

export function parseVoiceSessionsFile(raw: string): string[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		if (Object.keys(value).length !== 2 || !("schema" in value) || value.schema !== VOICE_SESSIONS_SCHEMA || !("sessions" in value)) return undefined;
		const { sessions } = value;
		return Array.isArray(sessions) && sessions.every((id) => typeof id === "string") ? sessions : undefined;
	} catch { return undefined; }
}

export function readVoiceSessions(options: VoiceSettingsOptions = {}): string[] {
	try {
		return parseVoiceSessionsFile(readFileSync(join(homeFor(options), VOICE_SESSIONS_FILE), "utf8")) ?? [];
	} catch {
		return [];
	}
}

// Keeps the most recent VOICE_SESSIONS_LIMIT distinct, non-blank ids.
export function writeVoiceSessions(sessions: readonly string[], options: VoiceSettingsOptions = {}): string {
	const kept: string[] = [];
	for (const id of [...sessions].reverse()) {
		const trimmed = id.trim();
		if (trimmed && !kept.includes(trimmed)) kept.push(trimmed);
		if (kept.length === VOICE_SESSIONS_LIMIT) break;
	}
	kept.reverse();
	const home = homeFor(options);
	const path = join(home, VOICE_SESSIONS_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema: VOICE_SESSIONS_SCHEMA, sessions: kept })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
