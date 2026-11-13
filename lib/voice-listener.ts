import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	encodeListenerFrame,
	CAPTURE_ERRORS,
	LISTENER_MAX_CLIENTS,
	LISTENER_MAX_FRAMES_PER_SECOND,
	LISTENER_MAX_LINE,
	parseListenerRequestLine,
	type CaptureErrorCode,
	type CaptureMode,
	type ListenerConnectionRole,
	type ListenerEndpoint,
	type ListenerErrorCode,
	type ListenerFrame,
	type ListenerLanguage,
	type ListenerRequest,
	type ListenerState,
	type ReadingOutcome,
	type ReadingReleaseReason,
	READING_OUTCOMES,
} from "./voice-listener-protocol.ts";
import type { CueName, CuePlayer, CueResult } from "./voice-cues.ts";
import { KWS_MODEL_MANIFEST, KWS_SPOTTER_FILES, parseVoiceKeywords, VOICE_KEYWORD_ASSET, type VoiceKeywordCommand, type VoiceKeywordSet, type VoiceModelFile } from "./voice-artifacts.ts";
import { resolveVoiceKeywordSpotterPaths, type VoiceKeywordSpotterPaths } from "./voice-install.ts";
import { createLevelMeter, type LevelMeter, type VoiceOverlay, type VoiceOverlaySnapshot } from "./voice-overlay.ts";
import { VoiceSessionError, type VoiceKeywordOption, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";
import type { KeywordRejection } from "./voice-warm.ts";

// One voice listener for every Pi session (S6, odd/notes/voice-listener-design.md).
// It owns the process, the microphone and the shared turn: a single instance per
// voice home (an exclusive lock file plus the unix socket it binds), the
// JSON-lines registry every session joins, the state edges, focus resolution
// through herdr, the rule that a transcript reaches the focused session only,
// the one reading turn every session asks for, and, from slice C, the capture
// itself: the warm dictation worker records and transcribes here, and the
// session that asked only receives its transcript. The levels a display draws
// are published here too: one `level` frame per 50 ms of audio, from the same
// worker RMS the detector judges, smoothed for the meter and never for the
// detector. The keyword spotter reads the microphone while asleep (S7) and
// between captures while awake (S14): a spoken "Gentle Voice off" reaches the
// same path a session's voice off does. Spot-only audio is never transcribed.
// The window itself lives outside this file, behind the overlay port.

export const LISTENER_LOCK_FILE = "listener.lock";
export const LISTENER_SOCKET_FILE = "listener.sock";
export const LISTENER_LOCK_SCHEMA = "gentle-pi.voice-listener-lock/v1";
// The daemon renews its lock body this often; a client treats a live pid with an
// older heartbeat as a locker that stopped renewing and takes over.
export const LISTENER_HEARTBEAT_MS = 2_000;
export const LISTENER_STALE_MS = 6_000;
// No client at all: nothing can receive a transcript, so the mic owner leaves.
export const LISTENER_IDLE_MS = 60_000;
// Asleep with no session that has voice on: L10 asks for ten minutes, then off.
export const LISTENER_ASLEEP_IDLE_MS = 600_000;
// A reading is renewed while it speaks; a session that stopped renewing (killed,
// or stuck) loses the turn instead of muting voice everywhere.
export const READING_LEASE_MS = 15_000;
// A released reading keeps the state for the tail still audible in the speaker
// (design §2.4), so the next reading never starts over the last word.
export const READING_TAIL_MS = 250;
// The ceiling on published levels: one per 50 ms of audio, twenty a second.
export const LEVEL_MIN_INTERVAL_MS = 50;

export interface ListenerPaths {
	readonly dir: string;
	readonly lock: string;
	readonly socket: string;
}

export interface ListenerLock {
	readonly schema: string;
	readonly pid: number;
	readonly socket: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly version: 1;
}

export const listenerPaths = (dir: string): ListenerPaths => Object.freeze({ dir, lock: join(dir, LISTENER_LOCK_FILE), socket: join(dir, LISTENER_SOCKET_FILE) });

const ensureDir = (dir: string) => {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		/* the exclusive create below reports a real failure */
	}
};

const parseLock = (raw: string): ListenerLock | undefined => {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (record.schema !== LISTENER_LOCK_SCHEMA || record.version !== 1) return undefined;
		if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 || typeof record.socket !== "string") return undefined;
		if (!Number.isSafeInteger(record.startedAt) || !Number.isSafeInteger(record.heartbeatAt)) return undefined;
		return {
			schema: LISTENER_LOCK_SCHEMA,
			pid: record.pid as number,
			socket: record.socket,
			startedAt: record.startedAt as number,
			heartbeatAt: record.heartbeatAt as number,
			version: 1,
		};
	} catch {
		return undefined;
	}
};

export function readListenerLock(paths: ListenerPaths): ListenerLock | undefined {
	try {
		return parseLock(readFileSync(paths.lock, "utf8"));
	} catch {
		return undefined;
	}
}

// The exclusive create is the primitive: whoever creates the lock owns the
// listener. It is rewritten only through a rename, so a client never reads half
// a body.
export function takeListenerLock(paths: ListenerPaths, options: { pid?: number; now?: number; socket?: string } = {}): ListenerLock | undefined {
	const now = options.now ?? Date.now();
	const lock: ListenerLock = {
		schema: LISTENER_LOCK_SCHEMA,
		pid: options.pid ?? process.pid,
		socket: options.socket ?? paths.socket,
		startedAt: now,
		heartbeatAt: now,
		version: 1,
	};
	ensureDir(paths.dir);
	try {
		writeFileSync(paths.lock, `${JSON.stringify(lock)}\n`, { flag: "wx", mode: 0o600 });
		return lock;
	} catch {
		return undefined;
	}
}

// The heartbeat is rewritten through a temporary file and renamed into place, so
// a client never reads half a lock body.
export function refreshListenerLock(paths: ListenerPaths, options: { pid?: number; now?: number } = {}): boolean {
	const current = readListenerLock(paths);
	if (!current || current.pid !== (options.pid ?? process.pid)) return false;
	const temporary = `${paths.lock}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ ...current, heartbeatAt: options.now ?? Date.now() })}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, paths.lock);
		return true;
	} catch {
		try {
			unlinkSync(temporary);
		} catch {
			/* nothing to clean */
		}
		return false;
	}
}

// Only the owner releases: a second listener must never remove the lock of the
// one that is holding the microphone.
export function releaseListenerLock(paths: ListenerPaths, options: { pid?: number } = {}): boolean {
	const current = readListenerLock(paths);
	if (!current || current.pid !== (options.pid ?? process.pid)) return false;
	try {
		unlinkSync(paths.lock);
		return true;
	} catch {
		return false;
	}
}

// Removes a lock nobody is renewing. An unreadable lock body counts as stale: a
// truncated write must cost one retry, never a stuck voice.
export function clearStaleListenerLock(paths: ListenerPaths, options: { now?: number; isAlive?: (pid: number) => boolean; staleMs?: number } = {}): boolean {
	const current = readListenerLock(paths);
	if (current && !listenerLockStale(current, options)) return false;
	try {
		unlinkSync(paths.lock);
		return true;
	} catch (error) {
		// No lock at all is already clear; any other failure leaves it to the caller.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

const processAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export function listenerLockStale(lock: ListenerLock, options: { now?: number; isAlive?: (pid: number) => boolean; staleMs?: number } = {}): boolean {
	if (!(options.isAlive ?? processAlive)(lock.pid)) return true;
	return (options.now ?? Date.now()) - lock.heartbeatAt > (options.staleMs ?? LISTENER_STALE_MS);
}

// Whether something accepts on this path right now. A leftover socket from a
// killed listener refuses the connection, which is exactly what makes it stale.
export function probeListenerSocket(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const done = (value: boolean) => {
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => done(false), 2_000);
		timer.unref?.();
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

const sameUser = (stat: { uid: number }) => typeof process.getuid !== "function" || stat.uid === process.getuid();

// A path that is not a socket of this user is never unlinked: that is someone
// else's file (lib/agents-session-transport.ts applies the same rule).
export function clearStaleListenerSocket(path: string): void {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		return;
	}
	if (stat.isSymbolicLink() || !stat.isSocket() || !sameUser(stat)) throw new Error("unsafe_path");
	unlinkSync(path);
}

export type ListenerLog = (event: string, fields?: Record<string, unknown>) => void;

// A focus lookup has three outcomes: a pane, nobody focused, and a failed lookup
// (never "nobody focused": it fails closed).
export type ListenerFocusResult = { readonly focused: string | undefined } | { readonly failed: true };

export interface ListenerFocus {
	focusedPaneId(): Promise<ListenerFocusResult>;
}

interface Client {
	readonly socket: Socket;
	// A replacement may be registered for voice accounting before its welcome,
	// but it must not receive broadcasts until the handshake has been sent.
	welcomed: boolean;
	sessionId?: string;
	paneId?: string;
	voiceOn: boolean;
	label?: string;
	// Which of the session's connections this is: its own long-lived one, or the
	// one a reply is read on. Only a connection of the same role replaces another,
	// so a reading is not evicted by the session that is reading it (S6).
	role: ListenerConnectionRole;
	// This session asked for the level frames of the capture it can see.
	levels: boolean;
	buffered: string;
	window: number;
	windowStart: number;
}

// The one reading turn (slice B): the listener arbitrates it, the session that
// holds it speaks. `ended` stays true through the tail, while the turn is still
// not available to anyone else.
interface ActiveReading {
	readonly readingId: string;
	readonly session: string;
	readonly socket: Socket;
	readonly chars: number;
	readonly returnsTo: ListenerState;
	lease?: ReturnType<typeof setTimeout>;
	tail?: ReturnType<typeof setTimeout>;
	ended: boolean;
	// The loudness of the chunk the player began (T13), queued here and drawn one
	// value per frame of audio. A new chunk replaces it; the end clears it.
	levels?: { readonly values: readonly number[]; at: number };
	levelTimer?: ReturnType<typeof setTimeout>;
}

export interface VoiceListenerOptions {
	// The voice home shared by every Pi process of this user.
	dir: string;
	pid?: number;
	now?: () => number;
	log?: ListenerLog;
	// Focus comes from herdr; a failed or malformed lookup is not "nobody
	// focused", so the transcript is dropped instead of guessed.
	focus?: ListenerFocus;
	// The capture the listener owns (slice C): the warm dictation worker in
	// production, a fake in the tests. Without one, dictate is refused and the
	// session records itself, exactly as before.
	dictation?: ListenerDictationFactory;
	// The keyword option every capture carries (S7): absent when the spotter is
	// not installed or the keyword file does not parse, and then the listener
	// behaves exactly as it did before the spotter existed.
	keyword?: VoiceKeywordOption;
	// Spot-only capture, asleep and while awake between captures (S7, S14), on
	// the same warm worker in production and a fake in the tests.
	spot?: ListenerSpotFactory;
	// The microphone cues are played here, where the microphone is.
	cues?: CuePlayer;
	// The display (T4): a port the listener drives with state snapshots and
	// levels. Absent here in production until the window exists; a port that
	// throws or rejects is logged once and dropped, never allowed to break a
	// capture, a transcript, a cue or a reading.
	overlay?: VoiceOverlay;
	// The language shown and listened in, carried on every state frame.
	language?: ListenerLanguage;
	idleMs?: number;
	asleepIdleMs?: number;
	heartbeatMs?: number;
	readLeaseMs?: number;
	readTailMs?: number;
}

// One capture, as the listener drives it: the worker's own edges in, the
// transcript out. The listener never reads a state back, it only reports the
// edges the worker gives it, so this is the session's VoiceDictation without it.
export interface ListenerDictation {
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

export interface ListenerDictationRequest {
	mode: CaptureMode;
	endpoint?: ListenerEndpoint;
	onStateChange(state: VoiceSessionState): void;
	// True when a display needs the microphone level: an overlay is here, or a
	// session subscribed. False means the worker publishes exactly what it always
	// did, and the listener never asks it for more.
	levels: boolean;
	// The microphone RMS while recording, 0..1, at most 20 a second.
	onLevel(rms: number): void;
	// What the capture hears for its keyword spotter (S7): the worker reports a
	// spoken command instead of words, so no transcript ever carries one.
	kws?: VoiceKeywordOption;
	onKeywordRejected(hit: KeywordRejection): void;
}

export type ListenerDictationFactory = (request: ListenerDictationRequest) => ListenerDictation;

// A spot-only capture (S7): the microphone open for the keyword spotter alone,
// no transcript and no end of its own. The warm worker gives exactly this.
export interface ListenerSpotting {
	start(): Promise<void>;
	// The command that was heard, or undefined when the capture was stopped.
	heard(): Promise<string | undefined>;
	stop(): Promise<void>;
	cancel(): Promise<void>;
}

export type ListenerSpotFactory = (onKeywordRejected: (hit: KeywordRejection) => void) => ListenerSpotting;

// The tuning measured in odd/notes/voice-kws.md §5: one global score and
// threshold for every line, and the decoding window the spotter uses.
export const VOICE_KEYWORD_TUNING = { boost: 2, threshold: 0.25, maxActivePaths: 16, trailingBlanks: 2 } as const;

export type VoiceKeywordOptionSource = { option: VoiceKeywordOption } | { reason: "not-installed" | "keywords-invalid" };

const pinnedFile = (file: VoiceModelFile) => ({ name: file.name, size: file.size, sha256: file.sha256 });

// The option a worker takes, or why there is none (S7). Nothing throws: a spotter
// that is not installed, half extracted or paired with a keyword file that does
// not parse leaves the listener with no keyword at all, which is the behaviour it
// had before the spotter existed. The digests come from the pinned manifest, so
// the worker verifies the same files the installer verified.
export async function buildVoiceKeywordOption(options: {
	voiceHome: string;
	resolvePaths?: (options: { voiceHome: string }) => Promise<VoiceKeywordSpotterPaths | undefined>;
	readKeywords?: () => Promise<string>;
}): Promise<VoiceKeywordOptionSource> {
	const readKeywords = options.readKeywords ?? (() => readFile(fileURLToPath(new URL(`../${VOICE_KEYWORD_ASSET}`, import.meta.url)), "utf8"));
	let paths: VoiceKeywordSpotterPaths | undefined;
	try {
		paths = await (options.resolvePaths ?? resolveVoiceKeywordSpotterPaths)({ voiceHome: options.voiceHome });
	} catch {
		return { reason: "not-installed" };
	}
	if (!paths) return { reason: "not-installed" };
	// The option must name the files it points at: a resolved path that is not the
	// pinned name under one root would hand the worker a model it cannot load.
	const root = dirname(paths.encoder);
	const pinned = new Map(KWS_MODEL_MANIFEST.files.map((file) => [file.name, file]));
	const pin = (role: keyof VoiceKeywordSpotterPaths) => {
		const file = pinned.get(KWS_SPOTTER_FILES[role]);
		if (!file || dirname(paths[role]) !== root || !paths[role].endsWith(file.name)) return undefined;
		return pinnedFile(file);
	};
	const encoder = pin("encoder");
	const decoder = pin("decoder");
	const joiner = pin("joiner");
	const tokens = pin("tokens");
	if (!encoder || !decoder || !joiner || !tokens) return { reason: "not-installed" };
	let keywords: VoiceKeywordSet;
	try {
		keywords = parseVoiceKeywords(await readKeywords());
	} catch {
		return { reason: "keywords-invalid" };
	}
	const lines = keywords.lines.flatMap((tokens) => {
		const command: VoiceKeywordCommand | undefined = keywords.commands.get(tokens);
		return command === undefined ? [] : [{ tokens, command }];
	});
	if (lines.length === 0) return { reason: "keywords-invalid" };
	return { option: { model: { root, files: { encoder, decoder, joiner, tokens } }, keywords: lines, ...VOICE_KEYWORD_TUNING } };
}

// The capture in progress: who asked, how it records, and what it already told
// its requester. A capture the listener no longer holds reports nothing.
interface PendingCapture {
	readonly client: Client;
	readonly sessionId: string;
	readonly mode: CaptureMode;
	cancelled: boolean;
}

interface ActiveCapture {
	readonly client: Client;
	readonly sessionId: string;
	readonly mode: CaptureMode;
	readonly dictation: ListenerDictation;
	// A command from this capture may have come from the reading's audible tail,
	// even if the worker reports it only after that tail is gone.
	readonly overlapsReading: boolean;
	collecting: boolean;
	// Stop requests that arrived while the outcome was being collected: answered
	// once it is known, so a requester has its transcript when its stop returns.
	readonly afterCollect: Array<() => void>;
	cue: "none" | "open" | "closed";
}

const noFocus: ListenerFocus = { focusedPaneId: async () => ({ focused: undefined }) };

// A capture that failed reports the worker's own code, or a fixed one: no
// native error text ever reaches a session.
const captureErrorCode = (error: unknown): CaptureErrorCode =>
	error instanceof VoiceSessionError && (CAPTURE_ERRORS as readonly string[]).includes(error.code) ? (error.code as CaptureErrorCode) : "internal";

const withId = <T extends object>(frame: T, id?: string): T => (id === undefined ? frame : ({ ...frame, id } as T));

// The display identity of the session that owns the microphone or the reading,
// with only the fields it really has: a frame never carries an empty one.
const displayOf = (client: { paneId?: string; label?: string }): { paneId?: string; label?: string } => {
	const display: { paneId?: string; label?: string } = {};
	if (client.paneId !== undefined) display.paneId = client.paneId;
	if (client.label !== undefined) display.label = client.label;
	return display;
};

export class VoiceListener {
	readonly paths: ListenerPaths;
	private readonly options: VoiceListenerOptions;
	private readonly pid: number;
	private readonly now: () => number;
	private readonly log: ListenerLog;
	private readonly idleMs: number;
	private readonly asleepIdleMs: number;
	private readonly heartbeatMs: number;
	private readonly readLeaseMs: number;
	private readonly readTailMs: number;
	private readonly language: ListenerLanguage;
	// The overlay port, dropped for good the first time it fails.
	private overlay: VoiceOverlay | undefined;
	// True while the overlay is still answering the previous call: a window that
	// hangs is never handed a second one, and never called again after a failure.
	private overlayBusy = false;
	// The last call a busy overlay could not take: a window that is a moment
	// slow still ends up showing the newest state, never an older one.
	private overlayPending: ((overlay: VoiceOverlay) => void | Promise<void>) | undefined;
	private readonly levelMeter: LevelMeter = createLevelMeter();
	// The time of the last published level, for the 20 Hz ceiling.
	private levelAt: number | undefined;
	private reading: ActiveReading | undefined;
	private capture: ActiveCapture | undefined;
	// Reserve the microphone while a requested capture waits for an earlier one.
	private capturePending: PendingCapture | undefined;
	private captureClosing: Promise<void> | undefined;
	private waking = false;
	// The spot-only capture, and the release of the one just stopped: the
	// microphone is handed over only once it is free.
	private spotting: ListenerSpotting | undefined;
	// A spotter that failed once is never asked again: voice carries on without it.
	private spotDisabled = false;
	private spottingStop: Promise<void> | undefined;
	// True only while the capture really records, from the worker's own report to
	// the moment the recording ends (S10). Levels never change it.
	private recording = false;
	private server: Server | undefined;
	private readonly clients = new Map<Socket, Client>();
	private currentState: ListenerState = "asleep";
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;
	private fenced = false;
	private boundInode: number | undefined;
	private closed: Promise<void> | undefined;

	constructor(options: VoiceListenerOptions) {
		this.options = options;
		this.paths = listenerPaths(options.dir);
		this.pid = options.pid ?? process.pid;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.idleMs = options.idleMs ?? LISTENER_IDLE_MS;
		this.asleepIdleMs = options.asleepIdleMs ?? LISTENER_ASLEEP_IDLE_MS;
		this.heartbeatMs = options.heartbeatMs ?? LISTENER_HEARTBEAT_MS;
		this.readLeaseMs = options.readLeaseMs ?? READING_LEASE_MS;
		this.readTailMs = options.readTailMs ?? READING_TAIL_MS;
		this.language = options.language ?? "es";
		this.overlay = options.overlay;
	}

	get state(): ListenerState {
		return this.currentState;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	// The session speaking right now, if any: one reading at a time, everywhere.
	get readingSession(): string | undefined {
		return this.reading && !this.reading.ended ? this.reading.session : undefined;
	}

	// The sessions whose voice is on, as the registry knows them: L10 reads this
	// when voice off has to reach everyone, and when a keyword wakes one session.
	get voiceSessions(): readonly string[] {
		// One session holds two connections at once (S6), and it keeps the listener
		// awake once: every connection joins with the flag, and the session counts
		// while any of them has voice on.
		const awake = new Set<string>();
		for (const client of this.clients.values()) if (client.sessionId && client.voiceOn) awake.add(client.sessionId);
		return [...awake];
	}

	// The sessions connected now, named once each whatever role their
	// connections play.
	get sessionIds(): readonly string[] {
		const ids = new Set<string>();
		for (const client of this.clients.values()) if (client.sessionId) ids.add(client.sessionId);
		return [...ids];
	}

	// Binds the socket. Exactly one process can do this per voice home: the lock
	// alone is not enough because a starting session writes one too, so the
	// second listener fails here and stops before it owns anything.
	async listen(): Promise<void> {
		ensureDir(this.paths.dir);
		this.takeLock();
		clearStaleListenerSocket(this.paths.socket);
		// Bind a private name and publish the shared one as a second link to the same
		// socket: the runtime unlinks the path it bound at close, which after a
		// takeover holds the replacement's socket.
		const bound = join(this.paths.dir, `.bind-${this.pid}`);
		clearStaleListenerSocket(bound);
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(bound, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(bound, 0o600);
		try {
			linkSync(bound, this.paths.socket);
		} finally {
			unlinkSync(bound);
		}
		this.boundInode = lstatSync(this.paths.socket).ino;
		const heartbeat = setInterval(() => {
			if (refreshListenerLock(this.paths, { pid: this.pid })) return;
			// Only a lock body naming another owner fences; a failed write retries.
			if (readListenerLock(this.paths)?.pid !== this.pid) this.fence();
		}, this.heartbeatMs);
		heartbeat.unref?.();
		this.heartbeat = heartbeat;
		this.log("listener.listen", { pid: this.pid });
		// A listener that starts while nobody has voice is asleep, and asleep listens
		// for the keyword: the microphone opens here, not on a later edge.
		if (this.currentState === "asleep") this.startSpotting();
		this.armIdle();
	}

	async close(reason: "idle" | "shutdown" | "error" = "shutdown"): Promise<void> {
		if (this.closed) return this.closed;
		this.closing = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
		this.endReading("shutdown");
		if (this.reading?.tail) clearTimeout(this.reading.tail);
		this.reading = undefined;
		// The window goes with the listener it drew, once. A port that already
		// failed is never called again.
		const overlay = this.overlay;
		this.overlay = undefined;
		this.overlayPending = undefined;
		if (overlay) {
			try {
				void Promise.resolve(overlay.dispose()).catch(() => {});
			} catch {
				/* a window that cannot close changes nothing here */
			}
		}
		// A capture ends with the listener: its worker is a child of this process.
		const capture = this.capture;
		this.capture = undefined;
		// The spotter holds the microphone too, and it goes with the listener.
		void this.stopSpotting();
		// The window is being disposed below, but the flag never outlives the recording.
		this.recording = false;
		if (capture) void capture.dictation.cancel().catch(() => {});
		for (const client of [...this.clients.values()]) {
			// end() flushes the bye before the FIN; a client that never closes is
			// dropped shortly after so shutdown cannot hang on it.
			client.socket.end(encodeListenerFrame({ type: "bye", reason }));
			const timer = setTimeout(() => client.socket.destroy(), 100);
			client.socket.once("close", () => clearTimeout(timer));
		}
		this.clients.clear();
		this.closed = new Promise<void>((resolve) => {
			if (!this.server) {
				resolve();
				return;
			}
			this.server.close(() => resolve());
		});
		await this.closed;
		// Ownership-aware: after a takeover the socket file belongs to the replacement.
		try {
			if (this.ownsSocket()) unlinkSync(this.paths.socket);
		} catch {
			/* already gone */
		}
		if (!this.fenced) releaseListenerLock(this.paths, { pid: this.pid });
		this.log("listener.exit", { reason });
	}

	// True while the socket path still resolves to the inode this listener published.
	private ownsSocket(): boolean {
		try {
			return lstatSync(this.paths.socket).ino === this.boundInode;
		} catch {
			return false;
		}
	}

	// Lost ownership is not ownership: bye, close the server, leave the files alone.
	private fence(): void {
		if (this.fenced || this.closing) return;
		this.fenced = true;
		this.log("listener.fenced", { pid: this.pid });
		void this.close("error");
	}

	// A transcript belongs to the session whose pane is focused when the
	// recording ends. It is never broadcast, buffered or retried, and the session
	// that asked always learns the outcome through its own request. `cancelled` is
	// the capture's token, re-checked after the focus was read.
	async deliverTranscript(text: string, truncated = false, cancelled?: () => boolean): Promise<string | undefined> {
		const clients = [...this.clients.values()].filter((client) => client.sessionId);
		if (clients.length === 0) {
			this.log("transcript.undelivered", { clients: 0 });
			return undefined;
		}
		const withPane = clients.filter((client) => client.paneId);
		const lookup = await (this.options.focus ?? noFocus).focusedPaneId();
		if (cancelled?.()) {
			// Cancelled while the focus was read: the cancel already reported it.
			this.log("transcript.undelivered", { clients: clients.length, capture: "cancelled" });
			return undefined;
		}
		if ("failed" in lookup) {
			// A failed lookup is not an unfocused one: the fallback would be a guess.
			this.log("transcript.undelivered", { clients: clients.length, focus: "unknown" });
			return undefined;
		}
		const focused = lookup.focused;
		// A known focused pane decides alone; with nobody focused the single
		// registered session still counts (design §2.2, §2.3), and anything else is
		// dropped rather than broadcast.
		let target = focused === undefined ? undefined : withPane.find((client) => client.paneId === focused);
		if (!target && focused === undefined && clients.length === 1) target = clients[0];
		if (!target) {
			this.log("transcript.undelivered", { clients: clients.length });
			return undefined;
		}
		this.say(target, truncated ? { type: "transcript", text, truncated: true } : { type: "transcript", text });
		this.log("transcript.delivered", { sessionId: target.sessionId });
		return target.sessionId;
	}

	private takeLock(): void {
		if (takeListenerLock(this.paths, { pid: this.pid, now: this.now() })) return;
		// A stale lock left by a killed listener is cleared once; a live one means
		// another listener is being started or is already running.
		if (!clearStaleListenerLock(this.paths, { now: this.now() })) throw new Error("voice_listener_busy");
		if (!takeListenerLock(this.paths, { pid: this.pid, now: this.now() })) throw new Error("voice_listener_busy");
	}

	private accept(socket: Socket): void {
		if (this.closing || this.clients.size >= LISTENER_MAX_CLIENTS) {
			try {
				socket.write(encodeListenerFrame({ type: "error", code: "too-many-clients" }));
			} catch {
				/* the socket is already gone */
			}
			socket.destroy();
			return;
		}
		const client: Client = { socket, welcomed: false, voiceOn: false, levels: false, buffered: "", window: 0, windowStart: this.now(), role: "session" };
		this.clients.set(socket, client);
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.receive(client, chunk));
		socket.on("error", () => this.forget(client));
		socket.on("close", () => this.forget(client));
		this.armIdle();
	}

	private receive(client: Client, chunk: string): void {
		client.buffered += chunk;
		let newline: number;
		while ((newline = client.buffered.indexOf("\n")) !== -1) {
			const line = client.buffered.slice(0, newline);
			client.buffered = client.buffered.slice(newline + 1);
			if (!this.clients.has(client.socket)) return;
			this.handle(client, line);
		}
		if (client.buffered.length > LISTENER_MAX_LINE) this.reject(client, "bad-frame");
	}

	private handle(client: Client, line: string): void {
		if (!this.countFrame(client)) return;
		const request = parseListenerRequestLine(line);
		if (!client.sessionId) {
			// The first frame of a connection is the hello that registers it.
			if (!request || request.type !== "hello") {
				this.reject(client, "bad-hello");
				return;
			}
			this.register(client, request);
			return;
		}
		if (!request || request.type === "hello") {
			this.reject(client, "bad-frame");
			return;
		}
		this.apply(client, request);
	}

	private countFrame(client: Client): boolean {
		const now = this.now();
		if (now - client.windowStart >= 1_000) {
			client.windowStart = now;
			client.window = 0;
		}
		client.window += 1;
		if (client.window > LISTENER_MAX_FRAMES_PER_SECOND) {
			this.reject(client, "rate-limit");
			return false;
		}
		return true;
	}

	private register(client: Client, hello: Extract<ListenerRequest, { type: "hello" }>): void {
		// A hello written before the role existed is the session's own connection.
		const role = hello.role ?? "session";
		// Publish the replacement before retiring its old socket, so an unchanged
		// voice-on reload never briefly looks like the last session went away.
		client.sessionId = hello.sessionId;
		client.paneId = hello.paneId;
		client.voiceOn = hello.voiceOn;
		client.label = hello.label;
		client.role = role;
		for (const other of [...this.clients.values()]) {
			// One session, one live socket per role: a reloaded session replaces its
			// stale one, while the connection its reading is held on survives, and a
			// session keeps talking to the listener that is reading for it.
			if (other === client || other.sessionId !== hello.sessionId || other.role !== role) continue;
			// Told and flushed before the socket goes: a connection replaced without
			// hearing why reconnects, and the two evict each other for ever.
			this.forget(other, (socket) => {
				socket.end(encodeListenerFrame({ type: "bye", reason: "replaced" }));
				const timer = setTimeout(() => socket.destroy(), 100);
				socket.once("close", () => clearTimeout(timer));
			});
		}
		this.say(client, withId({ type: "welcome", listenerPid: this.pid, proto: 1, state: this.currentState }, hello.id));
		client.welcomed = true;
		this.log("listener.hello", { sessionId: hello.sessionId, role, voiceOn: hello.voiceOn, clients: this.clients.size });
		if (hello.voiceOn && this.currentState === "asleep") this.setState("listening");
		else this.refreshSpotting();
		this.armIdle();
	}

	private apply(client: Client, request: Exclude<ListenerRequest, { type: "hello" }>): void {
		switch (request.type) {
			case "session-voice": {
				// One session may have a separate reading connection: its flag must not
				// keep that same session awake after the session turns voice off.
				for (const other of this.clients.values()) if (other.sessionId === client.sessionId) other.voiceOn = request.voiceOn;
				this.log("listener.voice", { sessionId: client.sessionId, voiceOn: request.voiceOn });
				if (request.voiceOn && this.currentState === "asleep") this.setState("listening");
				else if (!request.voiceOn && this.voiceSessions.length === 0) this.sleepWithoutVoice();
				else this.refreshSpotting();
				this.armIdle();
				return;
			}
			case "set-voice": {
				client.voiceOn = request.voiceOn;
				this.log("listener.voice", { sessionId: client.sessionId, voiceOn: request.voiceOn });
				this.say(client, withId({ type: "ok", request: "set-voice" }, request.id));
				if (request.voiceOn) {
					this.turnVoiceOn(client);
					if (this.currentState === "asleep") this.setState("listening");
					else this.refreshSpotting();
				} else {
					// L10: voice off from any session turns voice off everywhere, and the
					// listener is asleep from here.
					this.voiceOffEverywhere();
					this.setState("asleep");
				}
				this.armIdle();
				return;
			}
			case "wake":
				this.setState("listening");
				this.say(client, withId({ type: "ok", request: "wake", state: this.currentState }, request.id));
				return;
			case "sleep":
				this.setState("asleep");
				this.say(client, withId({ type: "ok", request: "sleep", state: this.currentState }, request.id));
				return;
			case "status":
				this.say(
					client,
					withId(
						{
							type: "snapshot",
							state: this.currentState,
							listenerPid: this.pid,
							clients: this.clients.size,
							sessions: [...this.sessionIds],
						},
						request.id,
					),
				);
				return;
			case "read-begin":
				this.beginReading(client, request);
				return;
			case "read-heartbeat": {
				const reading = this.reading;
				if (!reading || reading.ended || reading.session !== client.sessionId || reading.readingId !== request.readingId) {
					this.say(client, withId({ type: "busy", reason: "reading", ...(reading && !reading.ended ? { holder: reading.session } : {}) }, request.id));
					return;
				}
				this.armReadLease(reading);
				this.say(client, withId({ type: "ok", request: "read-heartbeat", state: this.currentState }, request.id));
				return;
			}
			case "read-end": {
				const reading = this.reading;
				if (!reading || reading.ended || reading.session !== client.sessionId || reading.readingId !== request.readingId) {
					this.say(client, withId({ type: "busy", reason: "reading", ...(reading && !reading.ended ? { holder: reading.session } : {}) }, request.id));
					return;
				}
				this.say(client, withId({ type: "ok", request: "read-end", state: this.currentState }, request.id));
				this.endReading(request.outcome);
				return;
			}
			case "read-cut": {
				const reading = this.reading;
				if (!reading || reading.ended) {
					// Nothing to cut: the caller learns nobody was speaking.
					this.say(client, withId({ type: "busy", reason: "reading" }, request.id));
					return;
				}
				// A cut that names a reading cuts only that one: a late cut for a reading
				// that already ended never cuts the one that replaced it.
				if (request.readingId !== undefined && request.readingId !== reading.readingId) {
					this.say(client, withId({ type: "busy", reason: "reading", holder: reading.session }, request.id));
					return;
				}
				this.endReading("cut");
				this.say(client, withId({ type: "ok", request: "read-cut", state: this.currentState }, request.id));
				return;
			}
			case "read-levels":
				this.readingLevels(client, request.id, request);
				return;
			case "levels":
				client.levels = request.on;
				this.say(client, withId({ type: "ok", request: "levels", state: this.currentState }, request.id));
				this.log("listener.levels", { sessionId: client.sessionId, on: request.on });
				return;
			case "dictate":
				void this.beginCapture(client, request);
				return;
			case "stop":
				this.endCapture(client, request.id);
				return;
			case "cancel":
				this.discardCapture(client, request.id);
				return;
		}
	}

	// --- the microphone (slice C) --------------------------------------------------

	// One capture at a time, owned by the session that asked. The listener records
	// and transcribes; the requester only learns where its transcript went. A
	// worker that cannot record answers the same request with a failed capture
	// carrying the worker's own code, so the session reports it as it always did.
	private async beginCapture(client: Client, request: { id?: string; mode: CaptureMode; endpoint?: ListenerEndpoint }): Promise<void> {
		const sessionId = client.sessionId;
		if (!sessionId) return;
		if (this.capture || this.capturePending) {
			this.say(client, withId({ type: "busy", reason: "capture", holder: this.capture?.sessionId ?? this.capturePending?.sessionId }, request.id));
			return;
		}
		// A reading shuts the microphone: it must not record what it is saying.
		if (this.reading && !this.reading.ended) {
			this.say(client, withId({ type: "busy", reason: "reading", holder: this.reading.session }, request.id));
			return;
		}
		const factory = this.options.dictation;
		if (!factory) {
			// No worker here: the session records itself instead of waiting forever.
			this.say(client, withId({ type: "error", code: "unknown-request" }, request.id));
			return;
		}
		// Reserve the microphone across asynchronous stops: no other request or
		// spotter can open it before the old stream has actually settled.
		const pending: PendingCapture = { client, sessionId, mode: request.mode, cancelled: false };
		this.capturePending = pending;
		if (this.spotting || this.spottingStop) await this.stopSpotting();
		if (this.captureClosing) await this.captureClosing;
		if (pending.cancelled || !this.clients.has(client.socket) || this.closing) {
			this.capturePending = undefined;
			if (pending.cancelled && this.clients.has(client.socket) && !this.closing) this.answer(client, "dictate", request.id);
			this.refreshSpotting();
			return;
		}
		this.options.cues?.warm();
		// Levels are asked for only when something draws them: the worker then
		// publishes one message per 50 ms of audio, and nothing at all otherwise.
		const levels = this.needsLevels();
		const dictation = factory({
			mode: request.mode,
			endpoint: request.endpoint,
			levels,
			onStateChange: (state) => this.captureState(client, state),
			onLevel: (rms) => this.publishLevel(rms),
			kws: this.options.keyword,
			onKeywordRejected: (hit) => this.logKeywordRejection(hit),
		});
		const capture: ActiveCapture = { client, sessionId, mode: request.mode, dictation, overlapsReading: this.reading !== undefined, collecting: false, afterCollect: [], cue: "none" };
		this.capture = capture;
		this.capturePending = undefined;
		// The meter of a new capture starts empty.
		this.levelMeter.reset();
		this.levelAt = undefined;
		this.setState("listening");
		this.log("capture.begin", { sessionId, mode: request.mode, clients: this.clients.size });
		void dictation.start().then(
			() => this.answer(client, "dictate", request.id),
			(error: unknown) => {
				this.failCapture(capture, error);
				this.answer(client, "dictate", request.id);
			},
		);
	}

	// The worker's own edges, in the order it reports them: the open cue and the
	// recording frame when it really records, the close cue and the transcribing
	// frame when it stops. A capture the listener no longer holds reports nothing.
	private captureState(client: Client, state: VoiceSessionState): void {
		const capture = this.capture;
		if (!capture || capture.client !== client) return;
		if (state === "recording") {
			if (capture.cue !== "none") return;
			capture.cue = "open";
			this.playCue("open", capture);
			// The microphone really records from here: the window is told so, and a
			// recording edge alone draws a new snapshot even when the state repeats.
			this.setRecording(true);
			this.setState("listening");
			this.say(client, { type: "capture", phase: "recording" });
			return;
		}
		if (capture.cue !== "open") return;
		capture.cue = "closed";
		// The worker stopped recording: the microphone is closed before the state
		// says what happens to the audio, so no snapshot ever pairs them.
		this.setRecording(false);
		if (state === "transcribing") {
			this.setState("transcribing");
			this.say(client, { type: "capture", phase: "transcribing" });
		}
		this.playCue("close", capture);
		// The worker ended the recording by itself: it heard the end of speech,
		// reached its limit, or failed. Nobody asked to stop, so nobody else will
		// ever collect the outcome: without this the listener waits for a stop
		// while the session waits for a transcript.
		this.collectCapture(capture);
	}

	// The recording ends. The transcript is handed to whoever has the focus at
	// this moment, never to whoever had it when the recording started.
	private endCapture(client: Client, id?: string): void {
		const capture = this.refuseUnlessOwner(client, id, this.capture);
		if (!capture) return;
		// The requester always learns the outcome, then the request is answered: a
		// client waiting on stop already has its transcript when it returns. That
		// holds as well for a stop that finds the outcome already being collected.
		capture.afterCollect.push(() => this.answer(client, "stop", id));
		if (capture.collecting) return;
		this.collectCapture(capture, () => this.captureState(client, "transcribing"));
	}

	// Collects the outcome of a recording once, whoever ended it: the session
	// that asked to stop, or the worker itself. The transcript goes to whoever
	// has the focus now; a command or a failure is settled in its own way.
	private collectCapture(capture: ActiveCapture, beforeStop?: () => void): void {
		if (capture.collecting) return;
		capture.collecting = true;
		beforeStop?.();
		void (async () => {
			let transcript: VoiceTranscript;
			try {
				transcript = await capture.dictation.stop();
			} catch (error) {
				this.failCapture(capture, error);
				return;
			}
			// What was said was a command, not speech (S4): nothing is delivered, and
			// the requester gets the same frames a capture with no speech gives it.
			if (transcript.command !== undefined) {
				this.captureCommand(capture, transcript.command);
				return;
			}
			const target = await this.deliverTranscript(transcript.text, transcript.truncated === true, () => this.capture !== capture);
			// A cancel inside that lookup released the capture and already answered.
			if (this.capture === capture) {
				const phase = target === undefined ? "dropped" : target === capture.sessionId ? "delivered" : "elsewhere";
				this.log("capture.end", { sessionId: capture.sessionId, mode: capture.mode, phase, target });
				this.say(capture.client, phase === "elsewhere" && target ? { type: "capture", phase, target } : { type: "capture", phase });
				this.releaseCapture(capture);
			}
		})()
			.catch(() => {})
			.finally(() => {
				for (const answer of capture.afterCollect.splice(0)) answer();
			});
	}

	private failCapture(capture: ActiveCapture, error: unknown): void {
		if (this.capture !== capture) return;
		this.captureState(capture.client, "finished");
		const code = captureErrorCode(error);
		this.log("capture.failed", { sessionId: capture.sessionId, mode: capture.mode, code });
		this.say(capture.client, { type: "capture", phase: "failed", code });
		this.releaseCapture(capture);
	}

	// A capture that heard a command ends here instead of being transcribed: no
	// text is delivered, and the command has exactly the effect it has when a
	// session asks for it. "Gentle Voice off" is the only one that does anything
	// (L10); anything else leaves voice as it was, as if nothing had been said.
	private captureCommand(capture: ActiveCapture, command: string): void {
		if (this.capture !== capture) {
			this.log("kws.hit", { command, reason: "ignored:stale" });
			return;
		}
		// The event name and the command id only: the audio is never kept.
		this.log("capture.command", { sessionId: capture.sessionId, mode: capture.mode, command });
		const reason = capture.overlapsReading || this.reading ? "ignored:reading" : command === "voice-off" ? "whole-utterance" : command === "voice-on" ? "ignored:awake-voice-on" : "ignored:unsupported";
		this.log("kws.hit", { command, reason });
		if (reason === "whole-utterance") this.voiceOffEverywhere();
		// The same outcome as a recording that heard nothing: the close cue, the
		// failed frame with `no-speech`, and the microphone handed back.
		this.failCapture(capture, new VoiceSessionError("no-speech"));
	}

	// Voice on for one session, through the broadcast a session's own voice on
	// sends: the flag armIdle and the overlay read, and the frame every session
	// already receives when voice turns on. A wake says so on the frame of the
	// session it woke, and on no other: the others only learn that voice is on.
	private turnVoiceOn(client: Client, wake = false): void {
		client.voiceOn = true;
		if (!wake) {
			this.broadcast({ type: "command", command: "voice-on" });
			return;
		}
		for (const other of this.clients.values()) if (other !== client) this.say(other, { type: "command", command: "voice-on" });
		this.say(client, { type: "command", command: "voice-on", wake: true });
	}

	// L10: voice off from any source reaches every session, and a reading that is
	// speaking is cut with it, because nothing is on to hear it. The state is the
	// caller's: a voice off from a capture leaves it to the release.
	private voiceOffEverywhere(): void {
		for (const other of this.clients.values()) other.voiceOn = false;
		this.broadcast({ type: "command", command: "voice-off" });
		this.endReading("cut");
	}

	// A cancelled capture keeps nothing: no stop, no transcript, no delivery.
	private discardCapture(client: Client, id?: string): void {
		const pending = this.capturePending;
		if (pending?.client === client) {
			if (!pending.cancelled) {
				pending.cancelled = true;
				this.say(client, { type: "capture", phase: "cancelled" });
				this.log("capture.cancelled", { sessionId: pending.sessionId, mode: pending.mode });
			}
			this.answer(client, "cancel", id);
			return;
		}
		const capture = this.refuseUnlessOwner(client, id, this.capture);
		if (!capture) return;
		this.releaseCapture(capture, true);
		this.say(client, { type: "capture", phase: "cancelled" });
		this.log("capture.cancelled", { sessionId: capture.sessionId, mode: capture.mode });
		this.answer(client, "cancel", id);
	}

	// Only the session that asked may end its capture; every other session learns
	// that the microphone is taken instead of moving it.
	private refuseUnlessOwner(client: Client, id: string | undefined, capture: ActiveCapture | undefined): ActiveCapture | undefined {
		if (capture && capture.client === client) return capture;
		this.say(client, withId(capture ? { type: "busy", reason: "capture", holder: capture.sessionId } : { type: "busy", reason: "capture" }, id));
		return undefined;
	}

	private releaseCapture(capture: ActiveCapture, cancel = false): void {
		if (this.capture !== capture) return;
		this.capture = undefined;
		if (cancel) {
			let closing: Promise<void>;
			try { closing = Promise.resolve(capture.dictation.cancel()).catch(() => {}); } catch { closing = Promise.resolve(); }
			this.captureClosing = closing;
			void closing.then(() => {
				if (this.captureClosing === closing) this.captureClosing = undefined;
				this.refreshSpotting();
			});
		}
		// Whatever ended the capture (a stop, a cancel, a failure, a worker or a
		// session that left), the microphone is closed from this moment.
		this.setRecording(false);
		// The meter of a recording ends with it: the next one starts empty.
		this.levelMeter.reset();
		this.levelAt = undefined;
		// The microphone closed without a stop: the close cue still marks it.
		if (capture.cue === "open") {
			capture.cue = "closed";
			this.playCue("close", capture);
		}
		// The microphone is free again, and the listener is awake as long as a
		// session that has voice is still here.
		this.setState(this.voiceSessions.length > 0 ? "listening" : "asleep");
	}

	// --- the keyword spotter (S7) --------------------------------------------------

	// Asleep keeps the S7 wake listener; when awake it listens only while at least
	// one session wants voice and no real capture is open. It publishes no state.
	private shouldSpot(): boolean {
		return !this.capture && !this.capturePending && !this.captureClosing && !this.waking &&
			(this.currentState === "asleep" || ((this.currentState === "listening" || this.currentState === "reading") && this.voiceSessions.length > 0));
	}

	private refreshSpotting(): void {
		if (this.shouldSpot()) this.startSpotting();
		else void this.stopSpotting();
	}

	// Once the last voiced session leaves, retire the awake spotter before
	// opening an asleep one. startSpotting waits for the same teardown promise.
	private sleepWithoutVoice(): void {
		if (this.voiceSessions.length > 0 || this.currentState === "asleep") {
			this.refreshSpotting();
			return;
		}
		void this.stopSpotting();
		this.setState("asleep");
	}

	private logKeywordRejection(hit: KeywordRejection): void {
		this.log("kws.hit", { command: hit.command, reason: hit.reason === "cancelled" ? "ignored:cancelled" : `rejected:${hit.reason}` });
	}

	private startSpotting(): void {
		const factory = this.options.spot;
		if (!this.options.keyword || !factory || this.spotDisabled || this.closing) return;
		if (this.spotting || !this.shouldSpot()) return;
		// A capture that is still closing holds the microphone: the next one waits.
		const stopping = this.spottingStop;
		if (stopping) {
			void stopping.then(() => this.startSpotting());
			return;
		}
		let capture: ListenerSpotting;
		try {
			capture = factory((hit) => this.logKeywordRejection(hit));
		} catch {
			this.failSpotting();
			return;
		}
		this.spotting = capture;
		void capture.start().then(
			() => this.awaitSpotting(capture),
			() => {
				if (this.spotting !== capture) return;
				this.spotting = undefined;
				this.failSpotting();
			},
		);
	}

	// The command the open spotter heard, or nothing when it was stopped here.
	private awaitSpotting(capture: ListenerSpotting): void {
		void capture.heard().then(
			(command) => this.spottingHeard(capture, command),
			() => {
				if (this.spotting !== capture) return;
				this.spotting = undefined;
				this.failSpotting();
			},
		);
	}

	private spottingHeard(capture: ListenerSpotting, command: string | undefined): void {
		if (this.spotting !== capture) {
			if (command !== undefined) this.log("kws.hit", { command, reason: "ignored:stale" });
			return;
		}
		this.spotting = undefined;
		if (command === undefined) return;
		// Reading text is not carried by the protocol. Fail closed for the whole
		// reading and its audible tail, rather than reacting to its own speech.
		if (this.reading) {
			this.log("kws.hit", { command, reason: "ignored:reading" });
			this.refreshSpotting();
			return;
		}
		if (this.currentState === "asleep") {
			this.log("kws.hit", { command, reason: command === "voice-on" ? "whole-utterance" : "ignored:asleep" });
			if (command !== "voice-on") return this.refreshSpotting();
			this.waking = true;
			void this.wakeByVoice().finally(() => { this.waking = false; this.refreshSpotting(); });
			return;
		}
		const reason = command === "voice-off" && this.voiceSessions.length > 0 ? "whole-utterance" : command === "voice-on" ? "ignored:awake-voice-on" : "ignored:unsupported";
		this.log("kws.hit", { command, reason });
		if (reason === "whole-utterance") {
			this.voiceOffEverywhere();
			this.setState("asleep");
		} else this.refreshSpotting();
	}

	// A keyword heard while asleep wakes the session the owner is looking at, and
	// only that one (S10, L10): asleep with nobody focused stays asleep, listening.
	private async wakeByVoice(): Promise<void> {
		if (this.currentState !== "asleep") return;
		const lookup = await (this.options.focus ?? noFocus).focusedPaneId();
		// The owner may have opened a capture, or started a reading, while the focus
		// was read: a wake never fights another path into the microphone.
		if (this.currentState !== "asleep" || this.spotting || this.capture || this.reading || this.closing) return;
		const paneId = "focused" in lookup ? lookup.focused : undefined;
		const target =
			paneId === undefined
				? undefined
				: [...this.clients.values()].find((client) => client.role === "session" && client.sessionId && client.paneId === paneId);
		if (!target) {
			// Nobody to wake: nothing turns on and the listener keeps listening.
			this.startSpotting();
			return;
		}
		this.log("kws.wake", { sessionId: target.sessionId });
		this.turnVoiceOn(target, true);
		this.setState("listening");
		// No cue here: the capture the woken session starts plays the one open cue,
		// and only once the microphone is really recording.
	}

	// A spotter that cannot open the microphone is dropped for the rest of the
	// listener's life: voice keeps working, asleep and without spotting.
	private failSpotting(): void {
		if (this.spotDisabled) return;
		this.spotDisabled = true;
		this.log("kws.failed");
	}

	// Releasing the microphone is asynchronous: a capture that must start waits on
	// this promise instead of opening a second one.
	private stopSpotting(): Promise<void> {
		const capture = this.spotting;
		if (!capture) return this.spottingStop ?? Promise.resolve();
		this.spotting = undefined;
		let stopping: Promise<void>;
		try {
			stopping = capture.stop().catch(() => {});
		} catch {
			stopping = Promise.resolve();
		}
		this.spottingStop = stopping;
		void stopping.then(() => {
			if (this.spottingStop === stopping) this.spottingStop = undefined;
		});
		return stopping;
	}

	// True when a display needs the levels: an overlay to draw them, or a session
	// that subscribed. Evaluated once per capture, so the worker is never asked
	// for a stream nobody reads.
	private needsLevels(): boolean {
		if (this.overlay) return true;
		for (const client of this.clients.values()) if (client.sessionId && client.levels) return true;
		return false;
	}

	// One published level: the meter sees every value, the subscribers see at
	// most one per 50 ms of audio, and a capture that already stopped sees none.
	// The value is a number only: never logged, never stored.
	private publishLevel(rms: number): void {
		const capture = this.capture;
		if (!capture || capture.cue !== "open") return;
		const at = this.now();
		if (this.levelAt !== undefined && at - this.levelAt < LEVEL_MIN_INTERVAL_MS) return;
		this.levelAt = at;
		const level = this.levelMeter.push(rms);
		this.drawOverlay((overlay) => overlay.level(level));
		for (const client of this.clients.values()) if (client.sessionId && client.levels) this.say(client, { type: "level", rms, at });
	}

	// The overlay port, driven but never trusted: one call at a time, and the
	// first throw or rejection drops it for the rest of the listener's life.
	private drawOverlay(call: (overlay: VoiceOverlay) => void | Promise<void>): void {
		const overlay = this.overlay;
		if (!overlay) return;
		// One call at a time: what arrives while the window is still answering
		// waits, and only the newest of those is ever called.
		if (this.overlayBusy) {
			this.overlayPending = call;
			return;
		}
		let result: void | Promise<void>;
		try {
			result = call(overlay);
		} catch {
			this.dropOverlay(overlay);
			return;
		}
		if (!(result instanceof Promise)) return;
		this.overlayBusy = true;
		void result.then(
			() => this.overlayIdle(),
			() => {
				// The overlay is dropped before a queued call is released: a window that
				// failed is never handed another one, and `overlay.failed` is logged once.
				this.dropOverlay(overlay);
				if (this.overlayBusy) this.overlayIdle();
			},
		);
	}

	private overlayIdle(): void {
		this.overlayBusy = false;
		const pending = this.overlayPending;
		this.overlayPending = undefined;
		if (pending) this.drawOverlay(pending);
	}

	private dropOverlay(overlay: VoiceOverlay): void {
		if (this.overlay !== overlay) return;
		this.overlay = undefined;
		this.overlayBusy = false;
		this.overlayPending = undefined;
		// The event name only: never a level value, never a transcript.
		this.log("overlay.failed");
	}

	private answer(client: Client, request: string, id?: string): void {
		this.say(client, withId({ type: "ok", request, state: this.currentState }, id));
	}

	// The cues belong to the microphone, so they are played here, and a player
	// that throws or answers with nothing never breaks the capture. A wake plays
	// the open cue for the session it woke, with no capture to log it against.
	private playCue(name: CueName, owner: { sessionId?: string; mode?: CaptureMode }): void {
		const cues = this.options.cues;
		if (!cues) return;
		let playing: Promise<CueResult | undefined>;
		try {
			playing = Promise.resolve(cues.play(name));
		} catch {
			return;
		}
		void playing
			.then((result) => {
				if (!result) return;
				this.log("cue", { sessionId: owner.sessionId, name: result.name, outcome: result.outcome, ms: result.ms, ...(owner.mode === undefined ? {} : { mode: owner.mode }) });
			})
			.catch(() => {});
	}

	// A reading is granted to one session at a time, and only where voice is on:
	// asleep with no session that has voice means there is nothing to read over.
	private beginReading(client: Client, request: { id?: string; readingId: string; chars: number }): void {
		if (this.reading) {
			this.say(client, withId({ type: "busy", reason: "reading", holder: this.reading.session }, request.id));
			return;
		}
		// A capture holds the microphone: the reading waits instead of recording
		// what it says, and the requester is told who has it.
		if (this.capture || this.capturePending) {
			this.say(client, withId({ type: "busy", reason: "capture", holder: this.capture?.sessionId ?? this.capturePending?.sessionId }, request.id));
			return;
		}
		if (this.currentState === "asleep" && this.voiceSessions.length === 0) {
			this.say(client, withId({ type: "busy", reason: "asleep" }, request.id));
			return;
		}
		const session = client.sessionId;
		if (!session) return;
		const reading: ActiveReading = { readingId: request.readingId, session, socket: client.socket, chars: request.chars, returnsTo: this.currentState, ended: false };
		this.reading = reading;
		this.armReadLease(reading);
		this.setState("reading");
		this.broadcast({ type: "reading", change: "granted", readingId: reading.readingId, session });
		this.say(client, withId({ type: "granted", readingId: reading.readingId, state: "reading" }, request.id));
		this.log("reading.begin", { readingId: reading.readingId, sessionId: session, chars: reading.chars });
	}

	// The reading's own loudness (T13, S5): the session that holds the turn sends
	// the output level of each chunk its player began, and the overlay draws it.
	// Only the holder with that reading id is accepted, so no other session can
	// paint a wave over a reading it does not speak, and a refused frame changes
	// nothing. The values are raw output loudness, paced here in audio time: the
	// window normalizes and smooths them, as it does for the microphone.
	private readingLevels(client: Client, id: string | undefined, request: { readingId: string; frameMs: number; levels: readonly number[] }): void {
		const reading = this.reading;
		if (!reading || reading.ended || reading.session !== client.sessionId || reading.readingId !== request.readingId) {
			this.say(client, withId({ type: "busy", reason: "reading", ...(reading && !reading.ended ? { holder: reading.session } : {}) }, id));
			return;
		}
		this.scheduleLevels(reading, request.frameMs, request.levels);
		this.say(client, withId({ type: "ok", request: "read-levels", state: this.currentState }, id));
	}

	// One value per frame of audio, never faster than the published-level ceiling,
	// so a chunk that arrives late or early still draws at the speed it is heard.
	// With no overlay there is nothing to draw, so no timer is armed at all.
	private scheduleLevels(reading: ActiveReading, frameMs: number, levels: readonly number[]): void {
		this.stopLevels(reading);
		if (!this.overlay || levels.length === 0) return;
		reading.levels = { values: [...levels], at: 0 };
		const step = Math.max(frameMs, LEVEL_MIN_INTERVAL_MS);
		const tick = () => {
			reading.levelTimer = undefined;
			const scheduled = reading.levels;
			// The reading ended, or another one holds the listener now: nothing more
			// is drawn, in either case.
			if (!scheduled || this.reading !== reading || reading.ended || this.currentState !== "reading") return;
			const value = scheduled.values[scheduled.at];
			scheduled.at += 1;
			if (value !== undefined) this.drawOverlay((overlay) => overlay.level(value));
			if (scheduled.at >= scheduled.values.length) {
				this.stopLevels(reading);
				return;
			}
			const timer = setTimeout(tick, step);
			timer.unref?.();
			reading.levelTimer = timer;
		};
		const timer = setTimeout(tick, step);
		timer.unref?.();
		reading.levelTimer = timer;
	}

	private stopLevels(reading: ActiveReading): void {
		if (reading.levelTimer) clearTimeout(reading.levelTimer);
		reading.levelTimer = undefined;
		reading.levels = undefined;
	}

	private armReadLease(reading: ActiveReading): void {
		if (reading.lease) clearTimeout(reading.lease);
		const lease = setTimeout(() => {
			if (this.reading !== reading || reading.ended) return;
			this.log("reading.lease-expired", { readingId: reading.readingId, sessionId: reading.session });
			this.endReading("lease");
		}, this.readLeaseMs);
		lease.unref?.();
		reading.lease = lease;
	}

	// Ending a reading is idempotent and keeps the turn for the tail: the speaker
	// is still finishing the sentence, so nothing new may start before it does.
	private endReading(reason: ReadingReleaseReason): void {
		const reading = this.reading;
		if (!reading || reading.ended) return;
		reading.ended = true;
		if (reading.lease) clearTimeout(reading.lease);
		reading.lease = undefined;
		// The wave goes with the reading: no value is drawn after it ends.
		this.stopLevels(reading);
		this.broadcast({ type: "reading", change: "released", readingId: reading.readingId, session: reading.session, reason });
		this.log("reading.release", {
			readingId: reading.readingId,
			sessionId: reading.session,
			reason,
			...(READING_OUTCOMES.includes(reason as ReadingOutcome) ? { outcome: reason } : {}),
		});
		const tail = setTimeout(() => {
			if (this.reading !== reading) return;
			// A whole-utterance hit can be reported after the audible tail. Retire
			// this spot capture before accepting commands again, so a delayed echo
			// from the reading cannot become a command in the next turn.
			this.reading = undefined;
			void this.stopSpotting();
			if (this.currentState === "reading") this.setState(reading.returnsTo);
			else this.refreshSpotting();
		}, this.readTailMs);
		tail.unref?.();
		reading.tail = tail;
	}

	private setState(next: ListenerState): void {
		if (next === this.currentState) {
			this.refreshSpotting();
			this.armIdle();
			return;
		}
		this.currentState = next;
		this.log("listener.state", { state: next });
		// The frame and the snapshot name the same owning session, so a window and
		// a session label the microphone identically (design §2.2).
		const owner = this.stateOwner();
		this.broadcast({ type: "state", state: next, language: this.language, ...owner, at: this.now() });
		this.drawSnapshot();
		this.refreshSpotting();
		this.armIdle();
	}

	// The recording edge is a display change of its own (S10): a session that is
	// awake with the microphone closed looks different from one that is recording,
	// and the state alone cannot tell them apart.
	private setRecording(value: boolean): void {
		if (this.recording === value) return;
		this.recording = value;
		this.drawSnapshot();
	}

	// The snapshot is the state frame's owner plus the one thing the frame never
	// carries, and it is drawn on a state change or on a recording change only.
	private drawSnapshot(): void {
		const snapshot: VoiceOverlaySnapshot = { state: this.currentState, language: this.language, recording: this.recording, ...this.stateOwner() };
		this.drawOverlay((overlay) => overlay.show(snapshot));
	}

	// Who owns what the listener is showing: the session that asked for the
	// capture, or the one holding the reading. Nobody when it is only listening.
	private stateOwner(): { paneId?: string; label?: string } {
		const capture = this.capture;
		if (capture) return displayOf(capture.client);
		const session = this.reading && !this.reading.ended ? this.reading.session : undefined;
		if (session === undefined) return {};
		for (const client of this.clients.values()) if (client.sessionId === session) return displayOf(client);
		return {};
	}

	private broadcast(frame: ListenerFrame): void {
		for (const client of [...this.clients.values()]) if (client.sessionId && client.welcomed) this.say(client, frame);
	}

	private say(client: Client, frame: ListenerFrame): void {
		try {
			client.socket.write(encodeListenerFrame(frame));
		} catch {
			this.forget(client);
		}
	}

	// One error frame and the connection closes, with the frame flushed first.
	private reject(client: Client, code: ListenerErrorCode): void {
		if (!this.clients.has(client.socket)) return;
		this.forget(client, (socket) => socket.end(encodeListenerFrame({ type: "error", code })));
		this.log("listener.rejected", { code, sessionId: client.sessionId });
	}

	private forget(client: Client, close: (socket: Socket) => void = (socket) => socket.destroy()): void {
		if (!this.clients.delete(client.socket)) return;
		if (this.reading && !this.reading.ended && this.reading.socket === client.socket) this.endReading("closed");
		// The session that was recording is gone: the microphone goes with it.
		const capture = this.capture;
		if (capture && capture.client === client) {
			this.releaseCapture(capture, true);
			this.log("capture.closed", { sessionId: capture.sessionId, mode: capture.mode });
		}
		if (this.capturePending?.client === client) this.capturePending.cancelled = true;
		close(client.socket);
		this.log("listener.client-closed", { sessionId: client.sessionId, clients: this.clients.size });
		if (client.voiceOn && this.voiceSessions.length === 0) this.sleepWithoutVoice();
		else this.refreshSpotting();
		this.armIdle();
	}

	// Two windows, both from the design: nobody connected for a minute, or asleep
	// with no session that has voice on for the ten minutes L10 chose. A listener
	// that owns no client can deliver a transcript to nobody, so it leaves.
	private armIdle(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = undefined;
		}
		if (!this.server || this.closing) return;
		const wantsVoice = this.voiceSessions.length > 0;
		let delay: number | undefined;
		if (this.clients.size === 0) delay = this.idleMs;
		else if (this.currentState === "asleep" && !wantsVoice) delay = this.asleepIdleMs;
		if (delay === undefined) return;
		const timer = setTimeout(() => {
			this.idleTimer = undefined;
			void this.close("idle");
		}, delay);
		timer.unref?.();
		this.idleTimer = timer;
	}
}

export interface HerdrAgent {
	paneId: string;
	focused: boolean;
	status?: string;
}

// `herdr agent list` returns every agent's full record; only the pane, the focus
// flag and the status are kept.
export function parseHerdrAgents(raw: string): HerdrAgent[] | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		const agents = (value as { result?: { agents?: unknown } } | null)?.result?.agents;
		if (!Array.isArray(agents)) return undefined;
		const parsed: HerdrAgent[] = [];
		for (const agent of agents) {
			if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return undefined;
			const record = agent as Record<string, unknown>;
			if (typeof record.pane_id !== "string" || record.pane_id.length === 0 || record.pane_id.length > 256) return undefined;
			parsed.push({ paneId: record.pane_id, focused: record.focused === true, status: typeof record.agent_status === "string" ? record.agent_status : undefined });
		}
		return parsed;
	} catch {
		return undefined;
	}
}

export type FocusRunner = (command: string, args: string[]) => Promise<string>;

const runHerdr: FocusRunner = (command, args) =>
	new Promise((resolve, reject) => {
		execFile(command, args, { timeout: 2_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
	});

export const FOCUS_CACHE_MS = 300;

// One call per decision for every session, instead of one `herdr pane get` per
// reopen. Nothing is cached across a failure: a wrong answer here would open a
// microphone in the wrong pane.
export function createHerdrFocus(options: { env?: NodeJS.ProcessEnv; run?: FocusRunner; ttlMs?: number; now?: () => number } = {}): ListenerFocus & { agents(): Promise<HerdrAgent[]> } {
	const env = options.env ?? process.env;
	const ttlMs = options.ttlMs ?? FOCUS_CACHE_MS;
	const now = options.now ?? Date.now;
	let cached: { at: number; agents: HerdrAgent[] } | undefined;
	// Undefined means the lookup failed; an empty list would mean nobody focused.
	const read = async (): Promise<HerdrAgent[] | undefined> => {
		if (cached && now() - cached.at < ttlMs) return cached.agents;
		cached = undefined;
		try {
			const agents = parseHerdrAgents(await (options.run ?? runHerdr)(env.HERDR_BIN_PATH?.trim() || "herdr", ["agent", "list"]));
			if (!agents) return undefined;
			cached = { at: now(), agents };
			return agents;
		} catch {
			return undefined;
		}
	};
	return {
		agents: async () => (await read()) ?? [],
		focusedPaneId: async () => {
			const agents = await read();
			return agents ? { focused: agents.find((agent) => agent.focused)?.paneId } : { failed: true };
		},
	};
}
