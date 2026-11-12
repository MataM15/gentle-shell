// The wire protocol between Pi sessions and the one voice listener (S6,
// odd/notes/voice-listener-design.md §2): `gentle.voice-listener/v1`, one JSON
// object per line, bounded, and strict about unknown fields. Frames carry the
// schema and a `type`; requests may carry an `id` the answer echoes. Nothing
// here opens a socket, a process or an audio device.

export const VOICE_LISTENER_SCHEMA = "gentle.voice-listener/v1";
export const LISTENER_PROTO = 1;
// Same frame bound as the dictation worker protocol (lib/voice-session.ts).
export const LISTENER_MAX_LINE = 64 * 1024;
export const LISTENER_MAX_TEXT = 16 * 1024;
export const LISTENER_MAX_CLIENTS = 64;
export const LISTENER_MAX_FRAMES_PER_SECOND = 200;

export const LISTENER_STATES = ["asleep", "listening", "transcribing", "reading"] as const;
export type ListenerState = (typeof LISTENER_STATES)[number];
// "off" is the absence of a listener process, never a state a listener reports.
export const LISTENER_COMMANDS = ["voice-off", "voice-on"] as const;
export type ListenerCommand = (typeof LISTENER_COMMANDS)[number];
export const LISTENER_ERRORS = ["bad-frame", "bad-hello", "too-many-clients", "rate-limit", "unknown-request", "internal"] as const;
export type ListenerErrorCode = (typeof LISTENER_ERRORS)[number];
export const LISTENER_BYE_REASONS = ["idle", "shutdown", "error"] as const;
export type ListenerByeReason = (typeof LISTENER_BYE_REASONS)[number];

export interface HelloRequest {
	type: "hello";
	id?: string;
	proto: 1;
	sessionId: string;
	paneId?: string;
	voiceOn: boolean;
	label?: string;
}

export type ListenerRequest =
	| HelloRequest
	| { type: "set-voice"; id?: string; voiceOn: boolean }
	| { type: "wake"; id?: string }
	| { type: "sleep"; id?: string }
	| { type: "status"; id?: string };

export interface WelcomeFrame {
	type: "welcome";
	id?: string;
	listenerPid: number;
	proto: 1;
	state: ListenerState;
}

export type ListenerFrame =
	| WelcomeFrame
	| { type: "ok"; request: string; id?: string; state?: ListenerState }
	| { type: "snapshot"; id?: string; state: ListenerState; listenerPid: number; clients: number; sessions: string[] }
	| { type: "state"; state: ListenerState; at: number }
	| { type: "command"; command: ListenerCommand }
	| { type: "transcript"; text: string }
	| { type: "error"; code: ListenerErrorCode; id?: string }
	| { type: "bye"; reason: ListenerByeReason };

type Kind = "text" | "string" | "boolean" | "number" | "proto" | "pid" | "counter" | "session" | "sessions" | "state" | "command" | "error" | "reason";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_FIELD = 256;
const KINDS: Record<Kind, (value: unknown) => boolean> = {
	text: (value) => typeof value === "string" && value.length <= LISTENER_MAX_TEXT,
	string: (value) => typeof value === "string" && value.length <= MAX_FIELD,
	boolean: (value) => typeof value === "boolean",
	number: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
	proto: (value) => value === LISTENER_PROTO,
	pid: (value) => Number.isSafeInteger(value) && (value as number) > 0,
	counter: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
	session: (value) => typeof value === "string" && SESSION_ID.test(value),
	sessions: (value) => Array.isArray(value) && value.length <= LISTENER_MAX_CLIENTS && value.every((id) => typeof id === "string" && SESSION_ID.test(id)),
	state: (value) => LISTENER_STATES.includes(value as ListenerState),
	command: (value) => LISTENER_COMMANDS.includes(value as ListenerCommand),
	error: (value) => LISTENER_ERRORS.includes(value as ListenerErrorCode),
	reason: (value) => LISTENER_BYE_REASONS.includes(value as ListenerByeReason),
};

interface Spec {
	required: Record<string, Kind>;
	optional?: Record<string, Kind>;
}

const ID: Record<string, Kind> = { id: "string" };

const REQUEST_SPECS: Record<string, Spec> = {
	hello: { required: { proto: "proto", sessionId: "session", voiceOn: "boolean" }, optional: { paneId: "string", label: "string", ...ID } },
	"set-voice": { required: { voiceOn: "boolean" }, optional: { ...ID } },
	wake: { required: {}, optional: { ...ID } },
	sleep: { required: {}, optional: { ...ID } },
	status: { required: {}, optional: { ...ID } },
};

const FRAME_SPECS: Record<string, Spec> = {
	welcome: { required: { listenerPid: "pid", proto: "proto", state: "state" }, optional: { ...ID } },
	ok: { required: { request: "string" }, optional: { state: "state", ...ID } },
	snapshot: { required: { state: "state", listenerPid: "pid", clients: "counter", sessions: "sessions" }, optional: { ...ID } },
	state: { required: { state: "state", at: "number" } },
	command: { required: { command: "command" } },
	transcript: { required: { text: "text" } },
	error: { required: { code: "error" }, optional: { ...ID } },
	bye: { required: { reason: "reason" } },
};

// Exact keys: every field present must be declared and typed, and every
// required field must be there. The schema is checked and then dropped so a
// parsed frame is the frame object itself.
function decode(line: string, specs: Record<string, Spec>): Record<string, unknown> | undefined {
	if (typeof line !== "string" || line.length > LISTENER_MAX_LINE) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.schema !== VOICE_LISTENER_SCHEMA || typeof record.type !== "string") return undefined;
	// Own properties only: "toString" or "constructor" would otherwise reach
	// Object.prototype and throw out of the caller's socket data handler.
	if (!Object.hasOwn(specs, record.type)) return undefined;
	const spec = specs[record.type];
	const declared: Record<string, Kind> = { ...spec.required, ...spec.optional };
	for (const key of Object.keys(record)) {
		if (key === "schema" || key === "type") continue;
		const kind = Object.hasOwn(declared, key) ? declared[key] : undefined;
		if (!kind || !KINDS[kind](record[key])) return undefined;
	}
	for (const key of Object.keys(spec.required)) if (!Object.hasOwn(record, key)) return undefined;
	delete record.schema;
	return record;
}

export const parseListenerRequestLine = (line: string): ListenerRequest | undefined => decode(line, REQUEST_SPECS) as ListenerRequest | undefined;

export const parseListenerFrameLine = (line: string): ListenerFrame | undefined => decode(line, FRAME_SPECS) as ListenerFrame | undefined;

export const encodeListenerFrame = (frame: ListenerRequest | ListenerFrame): string => `${JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, ...frame })}\n`;
