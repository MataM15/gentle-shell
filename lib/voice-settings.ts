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

// Spoken replies and conversation mode, in their own file so the push-to-talk
// file keeps its exact two-key shape. A missing, malformed or foreign file
// reads as both off.

export const VOICE_SPEECH_SETTINGS_SCHEMA = "gentle-pi.voice-speech-settings/v1";
export const VOICE_SPEECH_SETTINGS_FILE = "voice-speech-settings.json";

export interface VoiceSpeechSettings {
	speakReplies: boolean;
	conversation: boolean;
}

const SPEECH_OFF: VoiceSpeechSettings = { speakReplies: false, conversation: false };

export function parseVoiceSpeechSettingsFile(raw: string): VoiceSpeechSettings | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const keys = Object.keys(value);
		if (keys.length !== 3 || !("schema" in value) || value.schema !== VOICE_SPEECH_SETTINGS_SCHEMA) return undefined;
		if (!("speakReplies" in value) || !("conversation" in value)) return undefined;
		if (typeof value.speakReplies !== "boolean" || typeof value.conversation !== "boolean") return undefined;
		return { speakReplies: value.speakReplies, conversation: value.conversation };
	} catch { return undefined; }
}

export function readVoiceSpeechSettings(options: VoiceSettingsOptions = {}): VoiceSpeechSettings {
	try {
		return parseVoiceSpeechSettingsFile(readFileSync(join(homeFor(options), VOICE_SPEECH_SETTINGS_FILE), "utf8")) ?? { ...SPEECH_OFF };
	} catch {
		return { ...SPEECH_OFF };
	}
}

export function writeVoiceSpeechSettings(settings: VoiceSpeechSettings, options: VoiceSettingsOptions = {}): string {
	const home = homeFor(options);
	const path = join(home, VOICE_SPEECH_SETTINGS_FILE);
	const temporary = `${path}.${randomUUID()}.tmp`;
	mkdirSync(home, { recursive: true });
	try {
		const content = { schema: VOICE_SPEECH_SETTINGS_SCHEMA, speakReplies: settings.speakReplies, conversation: settings.conversation };
		writeFileSync(temporary, `${JSON.stringify(content)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
	} finally {
		try { unlinkSync(temporary); } catch { /* Rename consumed the temporary file. */ }
	}
	return path;
}
