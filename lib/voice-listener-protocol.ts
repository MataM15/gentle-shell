// The wire protocol between Pi sessions and the one voice listener (S6,
// odd/notes/voice-listener-design.md §2, §2.4 for the reading turn):
// `gentle.voice-listener/v1`, one JSON object per line, bounded, and strict
// about unknown fields. Frames carry the
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
// The language the overlay speaks and listens in. It travels with the state so a
// window shows the right one without asking; the listener knows it, not the wire.
export const LISTENER_LANGUAGES = ["es", "en"] as const;
export type ListenerLanguage = (typeof LISTENER_LANGUAGES)[number];
// "off" is the absence of a listener process, never a state a listener reports.
export const LISTENER_COMMANDS = ["voice-off", "voice-on"] as const;
export type ListenerCommand = (typeof LISTENER_COMMANDS)[number];
export const LISTENER_ERRORS = ["bad-frame", "bad-hello", "too-many-clients", "rate-limit", "unknown-request", "internal"] as const;
export type ListenerErrorCode = (typeof LISTENER_ERRORS)[number];
export const LISTENER_BYE_REASONS = ["idle", "shutdown", "error"] as const;
export type ListenerByeReason = (typeof LISTENER_BYE_REASONS)[number];
// How a reading ended. The first three are the session's own report; the rest
// are the listener taking the turn back (a stale lease, a cut, a gone session,
// a closing listener).
export const READING_OUTCOMES = ["done", "skipped", "cancelled"] as const;
export type ReadingOutcome = (typeof READING_OUTCOMES)[number];
export const READING_RELEASE_REASONS = [...READING_OUTCOMES, "lease", "cut", "closed", "shutdown"] as const;
export type ReadingReleaseReason = (typeof READING_RELEASE_REASONS)[number];
// Why a request was refused: another session is reading, another session has
// the microphone, or voice is off and nothing is awake.
export const LISTENER_BUSY_REASONS = ["reading", "asleep", "capture"] as const;
export type ListenerBusyReason = (typeof LISTENER_BUSY_REASONS)[number];
// Slice C: the listener records and transcribes, so a session only asks. A
// hands-free recording ends on its own; a dictation ends on the stop.
export const CAPTURE_MODES = ["conversation", "dictation"] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];
export const CAPTURE_PHASES = ["recording", "transcribing", "delivered", "elsewhere", "dropped", "cancelled", "failed"] as const;
export type CapturePhase = (typeof CAPTURE_PHASES)[number];
// The codes a failed capture can carry: the worker's own (lib/voice-session.ts)
// plus the ones the listener answers with. Fixed text only, as there.
export const CAPTURE_ERRORS = [
	"invalid-request",
	"node-version",
	"runtime-invalid",
	"model-invalid",
	"runtime-load",
	"model-load",
	"no-input-device",
	"unsupported-input",
	"capture",
	"empty-audio",
	"decode",
	"internal",
	"invalid-state",
	"unsupported",
	"not-installed",
	"no-speech",
	"timeout",
	"protocol",
	"worker-exited",
	"cancelled",
] as const;
export type CaptureErrorCode = (typeof CAPTURE_ERRORS)[number];

// The endpoint a hands-free or a dictation recording ends on.
export interface ListenerEndpoint {
	endOfSpeechMs: number;
	noSpeechMs: number;
}

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
	| { type: "status"; id?: string }
	// The reading turn (slice B): one reply is spoken at a time, by a session.
	| { type: "read-begin"; id?: string; readingId: string; chars: number }
	| { type: "read-heartbeat"; id?: string; readingId: string }
	| { type: "read-end"; id?: string; readingId: string; outcome: ReadingOutcome }
	| { type: "read-cut"; id?: string; readingId?: string }
	// The microphone (slice C): ask for one capture, end it, or throw it away.
	| { type: "dictate"; id?: string; mode: CaptureMode; endpoint?: ListenerEndpoint }
	| { type: "stop"; id?: string }
	| { type: "cancel"; id?: string }
	// The display levels (slice D): one frame per 50 ms while a capture records,
	// sent only to the sessions that ask for them.
	| { type: "levels"; id?: string; on: boolean };

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
	// A state change, with the language and the session that owns the capture or
	// the reading the listener is showing. Both optional: a frame written before
	// the overlay existed still parses.
	| { type: "state"; state: ListenerState; at: number; language?: ListenerLanguage; paneId?: string; label?: string }
	// One display level: the microphone RMS, 0..1, and when it was measured.
	| { type: "level"; rms: number; at: number }
	| { type: "command"; command: ListenerCommand }
	| { type: "transcript"; text: string; truncated?: boolean }
	// What became of the capture: its phase, why it failed, and where the
	// transcript went when another session had the focus.
	| { type: "capture"; phase: CapturePhase; code?: CaptureErrorCode; target?: string }
	| { type: "error"; code: ListenerErrorCode; id?: string }
	| { type: "bye"; reason: ListenerByeReason }
	| { type: "granted"; id?: string; readingId: string; state: ListenerState }
	| { type: "busy"; id?: string; reason: ListenerBusyReason; holder?: string }
	| { type: "reading"; change: "granted" | "released"; readingId: string; session: string; reason?: ReadingReleaseReason };

type Kind =
	| "text"
	| "string"
	| "boolean"
	| "number"
	| "proto"
	| "pid"
	| "counter"
	| "session"
	| "sessions"
	| "state"
	| "command"
	| "error"
	| "reason"
	| "outcome"
	| "release"
	| "change"
	| "language"
	| "rms"
	| "busy"
	| "mode"
	| "phase"
	| "capture-error"
	| "endpoint";

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
	outcome: (value) => READING_OUTCOMES.includes(value as ReadingOutcome),
	release: (value) => READING_RELEASE_REASONS.includes(value as ReadingReleaseReason),
	change: (value) => value === "granted" || value === "released",
	language: (value) => LISTENER_LANGUAGES.includes(value as ListenerLanguage),
	// Not a weight: a level the overlay could not draw is a malformed frame.
	rms: (value) => typeof value === "number" && Number.isFinite(value) && (value as number) >= 0 && (value as number) <= 1,
	busy: (value) => LISTENER_BUSY_REASONS.includes(value as ListenerBusyReason),
	mode: (value) => CAPTURE_MODES.includes(value as CaptureMode),
	phase: (value) => CAPTURE_PHASES.includes(value as CapturePhase),
	"capture-error": (value) => CAPTURE_ERRORS.includes(value as CaptureErrorCode),
	endpoint: (value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const record = value as Record<string, unknown>;
		// Both bounds, never one: a partial endpoint would end a recording at once.
		if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "endOfSpeechMs") || !Object.hasOwn(record, "noSpeechMs")) return false;
		return KINDS.number(record.endOfSpeechMs) && KINDS.number(record.noSpeechMs) && (record.endOfSpeechMs as number) > 0 && (record.noSpeechMs as number) > 0;
	},
};

interface Spec {
	required: Record<string, Kind>;
	optional?: Record<string, Kind>;
	// A rule the field types cannot express, run once they all pass.
	check?: (record: Record<string, unknown>) => boolean;
}

const ID: Record<string, Kind> = { id: "string" };

const REQUEST_SPECS: Record<string, Spec> = {
	hello: { required: { proto: "proto", sessionId: "session", voiceOn: "boolean" }, optional: { paneId: "string", label: "string", ...ID } },
	"set-voice": { required: { voiceOn: "boolean" }, optional: { ...ID } },
	wake: { required: {}, optional: { ...ID } },
	sleep: { required: {}, optional: { ...ID } },
	status: { required: {}, optional: { ...ID } },
	"read-begin": { required: { readingId: "string", chars: "counter" }, optional: { ...ID } },
	"read-heartbeat": { required: { readingId: "string" }, optional: { ...ID } },
	"read-end": { required: { readingId: "string", outcome: "outcome" }, optional: { ...ID } },
	"read-cut": { required: {}, optional: { readingId: "string", ...ID } },
	dictate: { required: { mode: "mode" }, optional: { endpoint: "endpoint", ...ID } },
	stop: { required: {}, optional: { ...ID } },
	cancel: { required: {}, optional: { ...ID } },
	levels: { required: { on: "boolean" }, optional: { ...ID } },
};

const FRAME_SPECS: Record<string, Spec> = {
	welcome: { required: { listenerPid: "pid", proto: "proto", state: "state" }, optional: { ...ID } },
	ok: { required: { request: "string" }, optional: { state: "state", ...ID } },
	snapshot: { required: { state: "state", listenerPid: "pid", clients: "counter", sessions: "sessions" }, optional: { ...ID } },
	state: { required: { state: "state", at: "number" }, optional: { language: "language", paneId: "string", label: "string" } },
	level: { required: { rms: "rms", at: "counter" } },
	command: { required: { command: "command" } },
	transcript: { required: { text: "text" }, optional: { truncated: "boolean" } },
	// A failure always names its code, and only a failure carries one.
	capture: { required: { phase: "phase" }, optional: { code: "capture-error", target: "session" }, check: (record) => (record.phase === "failed") === (record.code !== undefined) },
	error: { required: { code: "error" }, optional: { ...ID } },
	bye: { required: { reason: "reason" } },
	granted: { required: { readingId: "string", state: "state" }, optional: { ...ID } },
	busy: { required: { reason: "busy" }, optional: { holder: "session", ...ID } },
	reading: { required: { change: "change", readingId: "string", session: "session" }, optional: { reason: "release" } },
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
	if (spec.check && !spec.check(record)) return undefined;
	delete record.schema;
	return record;
}

export const parseListenerRequestLine = (line: string): ListenerRequest | undefined => decode(line, REQUEST_SPECS) as ListenerRequest | undefined;

export const parseListenerFrameLine = (line: string): ListenerFrame | undefined => decode(line, FRAME_SPECS) as ListenerFrame | undefined;

export const encodeListenerFrame = (frame: ListenerRequest | ListenerFrame): string => `${JSON.stringify({ schema: VOICE_LISTENER_SCHEMA, ...frame })}\n`;
