import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
	clearStaleListenerLock,
	clearStaleListenerSocket,
	listenerLockStale,
	listenerPaths,
	probeListenerSocket,
	readListenerLock,
	releaseListenerLock,
	takeListenerLock,
	type ListenerPaths,
} from "./voice-listener.ts";
import {
	encodeListenerFrame,
	parseListenerFrameLine,
	LISTENER_MAX_FRAME_MS,
	LISTENER_MAX_LEVELS,
	LISTENER_MAX_LINE,
	TRANSCRIPT_CAPTURE_HELLO_PREFIX,
	type CaptureMode,
	type ListenerCommand,
	type ListenerConnectionRole,
	type ListenerFrame,
	type ListenerRequest,
	type ListenerState,
	type ReadingOutcome,
	type ReadingReleaseReason,
} from "./voice-listener-protocol.ts";
import { VOICE_SPEECH_FRAME_MS, type VoiceSpeechChunk } from "./voice-speech-events.ts";
import { VoiceSessionError, type VoiceEndpoint, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";

// The session side of the one voice listener (S6): join the running listener,
// start it once when it is absent, keep the same session id across a listener
// restart, ask it for the one reading turn (slice B), and, from slice C, ask it
// for the microphone: the listener records and transcribes, and this side hands
// the transcript back to the session that pastes it. Nothing here records audio
// or speaks. A session that cannot reach the listener keeps its own capture,
// unless a shutdown worker may still hold the microphone.

export const LISTENER_START_TIMEOUT_MS = 10_000;
export const LISTENER_REQUEST_TIMEOUT_MS = 5_000;
// A capture start waits for the warm worker to load its model, and a cold start
// takes about 6.3 s: dictate gets a wait of its own, well past that.
export const LISTENER_DICTATE_TIMEOUT_MS = 30_000;
// Two quick retries preserve restart recovery; continued failures settle at two
// attempts a minute. A welcome alone is not proof of a stable connection.
export const LISTENER_BACKOFF_MS = [250, 1_000, 30_000] as const;
// Hello throttling starts at two seconds; stay bounded even if it escalates.
const LISTENER_RATE_LIMIT_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
export const LISTENER_STABLE_MS = 60_000;
const PROBE_INTERVAL_MS = 50;

export interface ListenerSession {
	sessionId: string;
	paneId?: string;
	// What a window calls this session (S5). Display only.
	label?: string;
	voiceOn: boolean;
}

// A display label has to fit a window, not a log line: 48 characters is a title,
// and well inside the protocol's field bound.
export const SESSION_LABEL_MAX = 48;

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

// One line a window can draw: escapes and control characters gone (a title with
// an escape could move a cursor), whitespace collapsed, cut to size.
const cleanLabel = (value: string): string =>
	value
		.replace(ANSI_ESCAPE, "")
		.replace(CONTROL, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SESSION_LABEL_MAX);

// The label a session shows in the overlay: the name Pi keeps for it, or, when
// it has none, the last segment of the directory it runs in. Production never
// set one before, so this is the only place it is chosen.
export function sessionDisplayLabel(session: { name?: string; cwd?: string }): string | undefined {
	const named = typeof session.name === "string" ? cleanLabel(session.name) : "";
	if (named) return named;
	if (typeof session.cwd !== "string") return undefined;
	const segment = session.cwd.split(/[\\/]+/).filter((part) => part.length > 0).at(-1);
	if (segment === undefined) return undefined;
	return cleanLabel(segment) || undefined;
}

export interface VoiceListenerClientOptions {
	dir: string;
	session: ListenerSession | (() => ListenerSession | undefined);
	// Which of the session's connections this is (S6). Omitted, it is the
	// session's own long-lived one, which is what every caller wrote before the
	// role existed; a reading turn declares its own so it is never replaced by it.
	role?: ListenerConnectionRole;
	dial?: (path: string) => Socket;
	backoffMs?: readonly number[];
	// A previously joined session may restart a vanished listener on reconnect.
	// An initial passive connection never starts one.
	restartOnDisconnect?: { start?: () => void | Promise<void>; probe?: (path: string) => Promise<boolean>; waitMs?: number };
	onFrame?: (frame: ListenerFrame) => void;
	// Opt in to display snapshots after each welcome; never wait for them.
	display?: boolean;
}

interface Pending {
	resolve(frame: ListenerFrame): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

// An uncorrelated rate-limit frame during hello is retryable for session joins.
export class ListenerRateLimitError extends Error {
	constructor() {
		super("the voice listener temporarily rate-limited hello");
		this.name = "ListenerRateLimitError";
	}
}

// The listener did not answer in time, and may still be working on the request.
class ListenerTimeoutError extends Error {
	constructor() {
		super("the voice listener did not answer");
		this.name = "ListenerTimeoutError";
	}
}

export class VoiceListenerClient {
	readonly paths: ListenerPaths;
	private readonly options: VoiceListenerClientOptions;
	private socket: Socket | undefined;
	private buffered = "";
	private nextId = 1;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(frame: ListenerFrame) => void>();
	private attempt = 0;
	private rateLimited = false;
	private joined = false;
	private everJoined = false;
	private closed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectOperation: AbortController | undefined;
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	private currentState: ListenerState = "asleep";
	private updatedVoiceOn: boolean | undefined;
	private displayPublished = false;
	private socketRetired = false;
	// The listener replaced this connection with a newer one of its own role. It is
	// closed for good: reconnecting would evict that newer one and the two would
	// take turns for ever, which is what one session's reload used to do (S6).
	private replaced = false;

	constructor(options: VoiceListenerClientOptions) {
		this.options = options;
		this.paths = listenerPaths(options.dir);
		if (options.onFrame) this.listeners.add(options.onFrame);
	}

	// Joined means the hello was answered: a socket that is still dialing is not
	// connected, so a caller never sends a request into a half-open connection.
	get connected(): boolean {
		return this.joined && !this.socketRetired && Boolean(this.socket && !this.socket.destroyed);
	}

	get listenerState(): ListenerState {
		return this.currentState;
	}

	// Opaque identity of the current socket, including before welcome completes.
	get connectionToken(): object | undefined {
		return !this.closed && !this.replaced && !this.socketRetired && this.socket && !this.socket.destroyed ? this.socket : undefined;
	}

	onFrame(handler: (frame: ListenerFrame) => void): () => void {
		this.listeners.add(handler);
		return () => this.listeners.delete(handler);
	}

	private session(): ListenerSession | undefined {
		if (typeof this.options.session === "function") return this.options.session();
		return { ...this.options.session, voiceOn: this.updatedVoiceOn ?? this.options.session.voiceOn };
	}

	// Unlike set-voice, this updates only this registration and broadcasts nothing.
	// If hello is still in flight, connect sends the latest value after welcome.
	updateVoice(voiceOn: boolean): boolean {
		this.updatedVoiceOn = voiceOn;
		if (!this.connected) return false;
		try {
			this.socket!.write(encodeListenerFrame({ type: "session-voice", voiceOn }));
			return true;
		} catch {
			return false;
		}
	}

	// One attempt: dials, sends hello and resolves with the state the listener
	// reports. Throws when the listener is not there or refuses the session.
	async connect(): Promise<ListenerState> {
		// A manual join supersedes any delayed recovery before it can start or dial.
		this.reconnectOperation?.abort();
		this.reconnectOperation = undefined;
		return this.connectOnce();
	}

	private async connectOnce(): Promise<ListenerState> {
		// A connection the listener already replaced never comes back: the caller
		// joins again with a new one instead of evicting its own replacement.
		if (this.replaced) throw new Error("this voice listener connection was replaced");
		if (this.closed) throw new Error("voice listener client closed");
		// A user-triggered rejoin may beat a scheduled retry. The timer must not
		// later retire the socket that rejoin just established.
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		// A new dial retires the old socket immediately, not when its eventual
		// close event arrives. Its callbacks must not affect the new connection.
		const old = this.socket;
		this.clearStableTimer();
		this.socket = undefined;
		this.joined = false;
		if (old) {
			this.failPending(new Error("the voice listener connection was replaced"));
			this.withdrawDisplay();
			old.destroy();
		}
		const socket = (this.options.dial ?? createConnection)(this.paths.socket);
		socket.setEncoding("utf8");
		this.buffered = "";
		this.socket = socket;
		this.socketRetired = false;
		socket.on("data", (chunk: string) => { if (this.socket === socket && !this.closed && !this.socketRetired) this.receive(chunk); });
		socket.on("error", () => {});
		socket.on("close", () => this.disconnected(socket));
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => { socket.off("connect", connected); socket.off("error", failed); socket.off("close", closed); };
			const connected = () => { cleanup(); resolve(); };
			const failed = (error: Error) => { cleanup(); reject(error); };
			const closed = () => { cleanup(); reject(new Error("voice listener client closed")); };
			socket.once("connect", connected);
			socket.once("error", failed);
			socket.once("close", closed);
		});
		if (this.closed || this.socket !== socket) throw new Error("voice listener client closed");
		const session = this.session();
		if (!session) throw new Error("voice listener session ended");
		const { sessionId, paneId, label, voiceOn } = session;
		const frame = await this.request({ type: "hello", proto: 1, sessionId, paneId, label, voiceOn, ...(this.options.role ? { role: this.options.role } : {}) });
		// A replacement can follow welcome in the same chunk, before this await
		// resumes. That welcome no longer establishes a usable connection.
		if (this.closed || this.socket !== socket || this.socketRetired) throw new Error("voice listener connection closed or replaced");
		if (frame.type !== "welcome") throw new Error("the voice listener refused hello");
		this.joined = true;
		this.everJoined = true;
		this.rateLimited = false;
		const stableTimer = setTimeout(() => {
			if (this.socket === socket && this.joined && !this.socketRetired) this.attempt = 0;
			if (this.stableTimer === stableTimer) this.stableTimer = undefined;
		}, LISTENER_STABLE_MS);
		stableTimer.unref?.();
		this.stableTimer = stableTimer;
		const current = this.session();
		if (current && current.sessionId === sessionId && current.voiceOn !== voiceOn) this.updateVoice(current.voiceOn);
		if (this.options.display) {
			try { void this.request({ type: "display", on: true }).catch(() => {}); } catch { /* display never blocks the connection */ }
		}
		return frame.state;
	}

	request(frame: ListenerRequest, timeoutMs = LISTENER_REQUEST_TIMEOUT_MS, onId?: (id: string) => void): Promise<ListenerFrame> {
		const socket = this.socket;
		if (!socket || socket.destroyed || this.closed || this.socketRetired) return Promise.reject(new Error("voice listener is not connected"));
		const id = (frame.type === "hello" ? TRANSCRIPT_CAPTURE_HELLO_PREFIX : "") + this.nextId++;
		onId?.(id);
		const answered = new Promise<ListenerFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new ListenerTimeoutError());
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
		});
		// Object.assign keeps the request union typed; spreading it widens `type`.
		socket.write(encodeListenerFrame(Object.assign({}, frame, { id })));
		return answered;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.joined = false;
		this.reconnectOperation?.abort();
		this.reconnectOperation = undefined;
		this.clearStableTimer();
		const socket = this.socket;
		this.socket = undefined;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.failPending(new Error("voice listener client closed"));
		this.withdrawDisplay();
		socket?.destroy();
	}

	private receive(chunk: string): void {
		this.buffered += chunk;
		let newline: number;
		while ((newline = this.buffered.indexOf("\n")) !== -1) {
			const line = this.buffered.slice(0, newline);
			this.buffered = this.buffered.slice(newline + 1);
			if (line.length > LISTENER_MAX_LINE) continue;
			const frame = parseListenerFrameLine(line);
			if (frame) this.dispatch(frame);
			if (this.socketRetired || this.closed) break;
		}
		if (this.buffered.length > LISTENER_MAX_LINE) this.buffered = "";
	}

	private withdrawDisplay(): void {
		if (!this.displayPublished) return;
		this.dispatch({ type: "display", state: "off", language: "es" }, true);
	}

	private dispatch(frame: ListenerFrame, withdrawing = false): void {
		// A hello refusal has no request id. Preserve its reason before the peer's
		// close otherwise turns it into an indistinguishable connection failure.
		if (!this.joined && frame.type === "error" && frame.code === "rate-limit") {
			this.rateLimited = true;
			this.failPending(new ListenerRateLimitError());
		}
		const id = "id" in frame ? frame.id : undefined;
		if (id !== undefined) {
			const pending = this.pending.get(id);
			if (pending) {
				this.pending.delete(id);
				clearTimeout(pending.timer);
				if (frame.type === "error") pending.reject(new Error(`the voice listener refused the request: ${frame.code}`));
				else pending.resolve(frame);
			}
		}
		// Welcome and a newer state can arrive in one socket chunk. Apply them in
		// wire order instead of overwriting the newer state after await resumes.
		if (frame.type === "welcome" || frame.type === "state") this.currentState = frame.state;
		if (frame.type === "display") this.displayPublished = !withdrawing;
		if (frame.type === "bye") {
			this.socketRetired = true;
			if (frame.reason === "replaced") this.replaced = true;
			this.withdrawDisplay();
		}
		for (const listener of [...this.listeners]) {
			try { listener(frame); } catch { /* a display or observer cannot break voice */ }
		}
	}

	private clearStableTimer(): void {
		if (this.stableTimer) clearTimeout(this.stableTimer);
		this.stableTimer = undefined;
	}

	private disconnected(socket: Socket): void {
		if (this.socket !== socket) return;
		this.clearStableTimer();
		this.socket = undefined;
		this.joined = false;
		this.failPending(new Error("the voice listener connection closed"));
		this.withdrawDisplay();
		if (this.replaced) return;
		this.scheduleReconnect();
	}

	private failPending(error: Error): void {
		for (const [id, pending] of [...this.pending]) {
			this.pending.delete(id);
			clearTimeout(pending.timer);
			pending.reject(error);
		}
	}

	private scheduleReconnect(): void {
		if (this.closed || this.replaced || this.reconnectTimer || this.reconnectOperation) return;
		const delays = this.options.backoffMs ?? (this.rateLimited ? LISTENER_RATE_LIMIT_BACKOFF_MS : LISTENER_BACKOFF_MS);
		const delay = delays[Math.min(this.attempt, delays.length - 1)];
		this.attempt += 1;
		const timer = setTimeout(() => {
			this.reconnectTimer = undefined;
			const recovery = this.options.restartOnDisconnect;
			if (recovery && this.everJoined && this.options.role !== "reading") {
				if (!this.session()) return;
				const controller = new AbortController();
				this.reconnectOperation = controller;
				void (async () => {
					try {
						await ensureListenerAvailable({
							dir: this.options.dir, probe: recovery.probe, waitMs: recovery.waitMs, signal: controller.signal,
							start: () => {
								if (!this.session()) throw new Error("voice listener session ended");
								return recovery.start?.();
							},
						});
						if (this.reconnectOperation === controller && !controller.signal.aborted) await this.connectOnce();
					} catch { /* retry on the same bounded schedule */ }
					finally {
						if (this.reconnectOperation === controller) {
							this.reconnectOperation = undefined;
							if (!this.connected) this.scheduleReconnect();
						}
					}
				})();
				return;
			}
			const joining = this.connectOnce();
			const socket = this.socket;
			void joining.catch(() => {
				// A manual rejoin may have superseded this dial. Its failure must not
				// schedule a retry that would replace the newer live socket.
				if (this.socket === socket) this.scheduleReconnect();
			});
		}, delay);
		timer.unref?.();
		this.reconnectTimer = timer;
	}
}

export const VOICE_LISTENER_SCRIPT_URL = new URL("../scripts/voice-listener.mjs", import.meta.url);

// Starts the listener as its own process: detached, no stdio, and never waited
// on, because the socket and the lock are what prove it came up. The listener
// owns no session state, so it outliving the session that started it is fine.
export function startVoiceListenerProcess(env: NodeJS.ProcessEnv = process.env): void {
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(VOICE_LISTENER_SCRIPT_URL)], {
		env,
		stdio: "ignore",
		detached: true,
		windowsHide: true,
		shell: false,
	});
	child.once("error", () => {
		/* the join that asked for it reports the missing listener */
	});
	child.unref();
}

export interface EnsureListenerOptions {
	dir: string;
	session: ListenerSession;
	// Spawns the listener process; the socket is the proof it came up.
	start?: () => void | Promise<void>;
	createClient?: () => VoiceListenerClient;
	// Session startup retains a rate-limited client for its scheduled rejoin.
	keepRetryingOnRateLimit?: boolean;
	// Cancellation stops waiting and prevents a late probe from joining.
	signal?: AbortSignal;
	probe?: (path: string) => Promise<boolean>;
	waitMs?: number;
	now?: number;
	isAlive?: (pid: number) => boolean;
}

const joinAborted = () => new Error("voice listener join aborted");
const throwIfAborted = (signal?: AbortSignal): void => { if (signal?.aborted) throw joinAborted(); };

// A probe or an injected start can finish after cancellation: settle now and
// never continue its join when it eventually answers.
function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return task;
	return new Promise((resolve, reject) => {
		const aborted = () => { signal.removeEventListener("abort", aborted); reject(joinAborted()); };
		task.then(
			(value) => { signal.removeEventListener("abort", aborted); resolve(value); },
			(error) => { signal.removeEventListener("abort", aborted); reject(error); },
		);
		if (signal.aborted) aborted();
		else signal.addEventListener("abort", aborted, { once: true });
	});
}

// The poll timer stays referenced while a join is live, but cancellation clears
// it immediately so a closed session does not keep the process alive.
const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(joinAborted());
	const aborted = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); reject(joinAborted()); };
	const timer = setTimeout(() => { signal?.removeEventListener("abort", aborted); resolve(); }, ms);
	signal?.addEventListener("abort", aborted, { once: true });
});

function hasLiveShutdownWorker(paths: ListenerPaths, isAlive?: EnsureListenerOptions["isAlive"]): boolean {
	const lock = readListenerLock(paths);
	return lock?.workerPid !== undefined && !listenerLockStale(lock, { isAlive });
}

async function waitForListener(paths: ListenerPaths, waitMs: number, probe: (path: string) => Promise<boolean>, { signal, isAlive }: Pick<EnsureListenerOptions, "signal" | "isAlive">): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		throwIfAborted(signal);
		// A shutdown worker cannot answer a probe or publish a listener socket.
		if (hasLiveShutdownWorker(paths, isAlive)) throw new Error("voice_listener_busy");
		if (await withAbort(probe(paths.socket), signal)) return true;
		if (Date.now() >= deadline) return false;
		await wait(PROBE_INTERVAL_MS, signal);
	}
}

// The availability half of ensureListener is also used by a connected session's
// reconnect. Both paths share the same probe, lock and stale-socket safeguards.
async function ensureListenerAvailable(options: Pick<EnsureListenerOptions, "dir" | "start" | "signal" | "probe" | "waitMs" | "now" | "isAlive">): Promise<boolean> {
	const paths = listenerPaths(options.dir);
	const waitMs = options.waitMs ?? LISTENER_START_TIMEOUT_MS;
	const probe = options.probe ?? probeListenerSocket;
	const signal = options.signal;
	throwIfAborted(signal);
	if (await withAbort(probe(paths.socket), signal)) return false;
	throwIfAborted(signal);

	// If another listener is starting or running, wait for its socket instead
	// of starting a second microphone owner.
	const lock = clearStaleListenerLock(paths, { now: options.now, isAlive: options.isAlive })
		? takeListenerLock(paths, { now: options.now, socket: paths.socket })
		: undefined;
	if (!lock) {
		if (await waitForListener(paths, waitMs, probe, options)) return false;
		throw new Error("voice_listener_busy");
	}
	// A path that is not this user's socket is refused, never unlinked.
	clearStaleListenerSocket(paths.socket);
	releaseListenerLock(paths, { pid: lock.pid });
	throwIfAborted(signal);
	await withAbort(Promise.resolve().then(() => { throwIfAborted(signal); return options.start?.(); }), signal);
	if (await waitForListener(paths, waitMs, probe, options)) return true;
	throw new Error("voice_listener_missing");
}

// Joins the listener, or starts exactly one and joins it. The start lock is
// released before spawning because the listener takes its own; two sessions
// racing here cannot both win, and the loser's process fails to bind and stops.
export async function ensureListener(options: EnsureListenerOptions): Promise<{ client: VoiceListenerClient; started: boolean }> {
	const signal = options.signal;
	const join = async (started: boolean) => {
		throwIfAborted(signal);
		const client = (options.createClient ?? (() => new VoiceListenerClient({ dir: options.dir, session: options.session })))();
		const abort = () => client.close();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			throwIfAborted(signal);
			await withAbort(client.connect(), signal);
			throwIfAborted(signal);
			return { client, started };
		} catch (error) {
			if (error instanceof ListenerRateLimitError && options.keepRetryingOnRateLimit && !signal?.aborted) return { client, started };
			client.close();
			throw error;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	};
	const started = await ensureListenerAvailable(options);
	return join(started);
}

// How often a reading renews its turn: well inside the listener's lease, and
// short enough that a dead listener stops a reading before the sentence ends.
export const READING_HEARTBEAT_MS = 5_000;
// Waiting for another session's reading to end: a reply that waited this long
// is stale, so its turn is abandoned instead of read into an old conversation.
export const READING_WAIT_MS = 120_000;
export const READING_POLL_MS = 200;

export interface ListenerReadingOptions {
	dir: string;
	session: ListenerSession;
	chars?: number;
	signal: AbortSignal;
	// The turn is gone: the session stops speaking. The reason is the listener's
	// own ("cut", "lease", "closed", "shutdown") or "lease" for a failed renewal.
	onCut?: (reason: ReadingReleaseReason) => void;
	start?: () => void | Promise<void>;
	waitMs?: number;
	pollMs?: number;
	maxWaitMs?: number;
}

// "unavailable" means the listener could not be reached at all: the session may
// fall back to its own reading turn, exactly as it did before the listener
// existed. A refusal or a cancelled wait is undefined: nothing reads then.
export type ListenerReading =
	| {
			kind: "granted";
			release: (outcome?: ReadingOutcome) => void;
			// The loudness of one chunk the player just began, for the overlay wave
			// (T13). Advisory: a frame that cannot be sent or is refused never stops
			// the reading.
			levels: (chunk: VoiceSpeechChunk) => void;
	  }
	| { kind: "unavailable" };

type Answer = "granted" | "reading" | "asleep" | "closed";

const askToRead = (client: VoiceListenerClient, readingId: string, chars: number): Promise<Answer> =>
	new Promise((resolve) => {
		let answered = false;
		const done = (answer: Answer) => {
			if (answered) return;
			answered = true;
			off();
			resolve(answer);
		};
		const off = client.onFrame((frame) => {
			if (frame.type === "granted") done("granted");
			// The microphone is busy: the reading waits in the same line it waits in
			// behind another reader, and the listener says who holds it.
			else if (frame.type === "busy") done(frame.reason === "capture" ? "reading" : frame.reason);
			else if (frame.type === "bye" || frame.type === "error") done("closed");
		});
		client.request({ type: "read-begin", readingId, chars }).catch(() => done("closed"));
	});

// The granted turn: renew it while the session speaks, hear the listener when
// it takes it back, and give it back when the reading ends.
function holdReading(client: VoiceListenerClient, readingId: string, options: ListenerReadingOptions): ListenerReading {
	let done = false;
	const claim = () => {
		if (done) return false;
		done = true;
		return true;
	};
	// The reading's loudness: the same measurement the speech events publish, sent
	// on this turn so the listener can draw it. The wire refuses any number
	// outside 0..1 by closing the connection, so a value the meter cannot draw is
	// silence here instead of a malformed frame that would mute the session.
	const levels = (chunk: VoiceSpeechChunk): void => {
		if (done) return;
		const values = chunk.levels.slice(0, LISTENER_MAX_LEVELS).map((level) => (!Number.isFinite(level) || level <= 0 ? 0 : level >= 1 ? 1 : level));
		const frameMs = Number.isSafeInteger(chunk.frameMs) && chunk.frameMs > 0 && chunk.frameMs <= LISTENER_MAX_FRAME_MS ? chunk.frameMs : VOICE_SPEECH_FRAME_MS;
		client.request({ type: "read-levels", readingId, frameMs, levels: values }).catch(() => {});
	};
	const heartbeat = setInterval(() => {
		const lose = () => {
			if (!claim()) return;
			clearInterval(heartbeat);
			client.close();
			options.onCut?.("lease");
		};
		client.request({ type: "read-heartbeat", readingId }).then((frame) => {
			if (frame.type !== "ok") lose();
		}, lose);
	}, READING_HEARTBEAT_MS);
	heartbeat.unref?.();
	const off = client.onFrame((frame) => {
		if (frame.type !== "reading" || frame.change !== "released" || frame.readingId !== readingId) return;
		if (!claim()) return;
		off();
		clearInterval(heartbeat);
		options.onCut?.(frame.reason ?? "closed");
	});
	return {
		kind: "granted",
		levels,
		release: (outcome: ReadingOutcome = "done") => {
			claim();
			off();
			clearInterval(heartbeat);
			client.request({ type: "read-end", readingId, outcome }).then(
				() => client.close(),
				() => client.close(),
			);
		},
	};
}

// The one reading turn through the listener (slice B): ask, wait behind another
// session's reading, and hold it until the reply ends. Never starts a listener
// for a session that cannot join one, because speaking stays in the session.
export async function listenerReadingTurn(options: ListenerReadingOptions): Promise<ListenerReading | undefined> {
	let client: VoiceListenerClient;
	try {
		const session = options.session;
		const joined = await ensureListener({
			dir: options.dir,
			session,
			start: options.start,
			waitMs: options.waitMs,
			// Keep the live session source, including its voice getter, on reconnect.
			createClient: () => new VoiceListenerClient({ dir: options.dir, session: () => session, role: "reading" }),
		});
		client = joined.client;
	} catch {
		return { kind: "unavailable" };
	}
	const readingId = randomUUID();
	const chars = options.chars ?? 0;
	const deadline = Date.now() + (options.maxWaitMs ?? READING_WAIT_MS);
	for (;;) {
		if (options.signal.aborted) {
			client.close();
			return undefined;
		}
		const answer = await askToRead(client, readingId, chars);
		if (answer === "granted") return holdReading(client, readingId, options);
		// Another session is speaking, and only it can end that: wait in line.
		if (answer !== "reading" || Date.now() >= deadline) {
			client.close();
			return undefined;
		}
		await wait(options.pollMs ?? READING_POLL_MS);
	}
}

// Cuts whatever the listener is reading, from any session. A listener that is
// not running means nothing is reading through it: no process is started here.
export async function cutListenerReading(options: { dir: string; session: ListenerSession }): Promise<boolean> {
	if (!(await probeListenerSocket(listenerPaths(options.dir).socket))) return false;
	const client = new VoiceListenerClient({ dir: options.dir, session: () => options.session, role: "reading" });
	try {
		await client.connect();
		const frame = await client.request({ type: "read-cut" });
		return frame.type === "ok";
	} catch {
		return false;
	} finally {
		client.close();
	}
}

// --- capture through the listener (slice C) ----------------------------------

// One capture as the session drives it. The owner says who holds the worker and
// plays the microphone cues: the listener from this slice on, or the session
// itself when the listener cannot be reached at all.
export interface SessionDictation {
	readonly state: VoiceSessionState;
	readonly owner: "listener" | "session";
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

class ShutdownWorkerBusyError extends VoiceSessionError {
	constructor() {
		// Same code as a listener refusing a dictate because the microphone is held.
		super("invalid-state");
		this.message = "The microphone is busy. Try again in a moment.";
	}
}

// A listener reported that a finished transcript went elsewhere or was dropped.
// Older listeners may still select a different focused pane while the owner stays.
export class ListenerDeliveryError extends Error {
	readonly kind: "elsewhere" | "dropped";
	constructor(kind: "elsewhere" | "dropped") {
		super(kind === "elsewhere" ? "The transcript went to the session that had the focus." : "No session had the focus, so the transcript was dropped.");
		this.name = "ListenerDeliveryError";
		this.kind = kind;
	}
}

export interface ListenerWakeReservation {
	isCurrent(): boolean;
	cancel(): Promise<void>;
}

export interface ListenerDictationOptions {
	mode: CaptureMode;
	endpoint?: VoiceEndpoint;
	// An awake spoken wake must never fall back to an unvalidated local capture.
	wake?: boolean;
	wakeValid?(): boolean;
	wakeReservation?: ListenerWakeReservation;
	onStateChange(state: VoiceSessionState): void;
	// What records when the listener cannot be reached: the session's own capture,
	// exactly as it worked before the listener existed.
	fallback(): SessionDictation;
}

export interface SessionListenerLink {
	// True when this session is joined to a running listener; starts one once.
	ensure(): Promise<boolean>;
	// Optional for injected links; production updates the joined registration.
	updateVoice?(voiceOn: boolean): void;
	cancelWake?(): void;
	captureWake?(): ListenerWakeReservation | undefined;
	dictate(options: ListenerDictationOptions): SessionDictation;
	close(): void;
}

export interface SessionListenerLinkOptions {
	dir: string;
	session(): ListenerSession | undefined;
	// Transfer a connected passive session without replacing its socket.
	adoptedClient?: VoiceListenerClient;
	start?: () => void | Promise<void>;
	waitMs?: number;
	probe?: (path: string) => Promise<boolean>;
	// How long the listener gets to accept a dictate, before the start fails.
	dictateTimeoutMs?: number;
	backoffMs?: readonly number[];
	// A transcript handed to this session outside its own capture, such as a
	// focus fallback for a departed requester. It is handed over once, never buffered.
	onTranscript?(text: string, truncated: boolean): void;
	// The listener telling this session about its own voice: on, because it was
	// woken by voice (the frame says so) or because another session turned it on,
	// and off when voice off reached every session (S7, L10).
	onVoice?(command: ListenerCommand, wake: boolean, awake: boolean): void;
	onDisplay?(frame: Extract<ListenerFrame, { type: "display" | "level" }>): void;
}

// One connection per session carries both roles: it registers the pane for
// focus fallback, and it asks for the microphone. A capture that
// cannot get the listener records here if no shutdown worker still holds the mic.
// Its hello carries no `role`: the session's own connection is what a listener read
// before the role existed, so only a reading declares itself (S6).
export function createSessionListenerLink(options: SessionListenerLinkOptions): SessionListenerLink {
	type PendingJoin = { controller: AbortController; promise: Promise<boolean>; client?: VoiceListenerClient; allowStart: boolean };
	const paths = listenerPaths(options.dir);
	const checkShutdownWorker = (): void => {
		if (hasLiveShutdownWorker(paths)) throw new ShutdownWorkerBusyError();
	};
	// This session's own fallback captures. While one is starting, recording or
	// transcribing, its worker may hold the microphone, so this session starts no
	// listener: the new listener's spotter would open the microphone a second
	// time (T9). A capture reports "finished" only after its worker has exited;
	// the automatic reconnect keeps retrying on its backoff until then.
	const ownCaptures = new Set<SessionDictation>();
	const ownCaptureActive = (): boolean => {
		for (const capture of ownCaptures) if (capture.state === "idle" || capture.state === "finished") ownCaptures.delete(capture);
		return ownCaptures.size > 0;
	};
	const startListener = (): void | Promise<void> => {
		if (ownCaptureActive()) throw new Error("this session's own capture still holds the microphone");
		return options.start?.();
	};
	let client: VoiceListenerClient | undefined = options.adoptedClient;
	let wakeIdentity: object | undefined;
	let joining: PendingJoin | undefined;
	let handler: ((frame: ListenerFrame) => boolean) | undefined;
	const retireJoin = (pending: PendingJoin | undefined): void => {
		if (!pending || joining !== pending) return;
		joining = undefined;
		pending.controller.abort();
		if (pending.client && client === pending.client) {
			pending.client.close();
			client = undefined;
		}
	};
	const route = (frame: ListenerFrame): void => {
		if (frame.type === "display" || frame.type === "level") { options.onDisplay?.(frame); return; }
		if (handler?.(frame)) return;
		if (frame.type === "command") {
			options.onVoice?.(frame.command, frame.wake === true, client?.listenerState !== "asleep");
			return;
		}
		// No capture of this session asked for it; pass the transcript to the session.
		if (frame.type === "transcript") options.onTranscript?.(frame.text, frame.truncated === true);
	};
	let detachAdopted = options.adoptedClient?.onFrame(route);

	const ensure = (): Promise<boolean> => {
		if (client?.connected) return Promise.resolve(true);
		if (joining) return joining.promise;
		// Leave the current client, and the reconnect it owns, untouched: it starts
		// the listener once this session's own capture has released the microphone.
		if (ownCaptureActive()) return Promise.resolve(false);
		const controller = new AbortController();
		const pending: PendingJoin = { controller, promise: undefined!, allowStart: true };
		joining = pending;
		pending.promise = (async () => {
			try {
				const session = options.session();
				if (!session) return false;
				if (client && client === options.adoptedClient && !client.connected) {
					// The transferred socket is gone. Retire its reconnect timer before
					// creating another client, so the two can never evict each other.
					detachAdopted?.();
					detachAdopted = undefined;
					client.close();
					client = undefined;
				}
				if (client) {
					pending.client = client;
					try {
						await withAbort(client.connect(), controller.signal);
						throwIfAborted(controller.signal);
						return true;
					} catch (error) {
						throwIfAborted(controller.signal);
						if (error instanceof ListenerRateLimitError) return false;
						// Its retry must not race the new client created below.
						client.close();
						client = undefined;
						/* the lock or the socket is gone: start a listener below */
					}
				}
				const joined = await ensureListener({
					dir: options.dir,
					session,
					start: () => {
						if (!pending.allowStart) throw new Error("voice was turned off during listener startup");
						return startListener();
					},
					waitMs: options.waitMs,
					probe: options.probe,
					signal: controller.signal,
					keepRetryingOnRateLimit: true,
					createClient: () => {
						throwIfAborted(controller.signal);
						return (pending.client = client = new VoiceListenerClient({
							dir: options.dir,
							session: () => {
								const current = options.session();
								return current?.sessionId === session.sessionId ? current : undefined;
							},
							backoffMs: options.backoffMs,
							restartOnDisconnect: { start: startListener, probe: options.probe, waitMs: options.waitMs },
							display: Boolean(options.onDisplay),
							onFrame: route,
						}));
					},
				});
				throwIfAborted(controller.signal);
				client = joined.client;
				return client.connected;
			} catch {
				return false;
			} finally {
				if (joining === pending) joining = undefined;
			}
		})();
		return pending.promise;
	};

	// A declined wake uses the existing cancel request on the same session link.
	const cancelWake = (): void => {
		wakeIdentity = undefined;
		// A wake can share the welcome's socket chunk, before connect() marks the
		// client joined. Its hello was already accepted, so cancel is safe now.
		if (client) void client.request({ type: "cancel" }).catch(() => {});
	};
	const captureWake = (): ListenerWakeReservation | undefined => {
		const owner = client;
		const connection = owner?.connectionToken;
		if (!owner || !connection) return undefined;
		const identity = {};
		wakeIdentity = identity;
		const isCurrent = () => wakeIdentity === identity && client === owner && owner.connectionToken === connection;
		return {
			isCurrent,
			cancel: async () => {
				if (!isCurrent()) return;
				wakeIdentity = undefined;
				try { await owner.request({ type: "cancel" }); } catch { /* the original socket is already gone */ }
			},
		};
	};

	const dictate = (request: ListenerDictationOptions): SessionDictation => {
		const releaseWake = () => request.wakeReservation ? request.wakeReservation.cancel() : cancelWake();
		let state: VoiceSessionState = "idle";
		let fallback: SessionDictation | undefined;
		let stopSent = false;
		let settled = false;
		let cancelled = false;
		let requested = false;
		let captureId: string | undefined;
		let waitingForJoin: PendingJoin | undefined;
		let failure: { error: unknown } | undefined;
		let resolveTranscript!: (transcript: VoiceTranscript) => void;
		let rejectTranscript!: (error: unknown) => void;
		const transcript = new Promise<VoiceTranscript>((resolve, reject) => {
			resolveTranscript = resolve;
			rejectTranscript = reject;
		});
		transcript.catch(() => {});
		const setState = (next: VoiceSessionState): void => {
			if (state === next) return;
			state = next;
			request.onStateChange(next);
		};
		const settle = (outcome: { transcript: VoiceTranscript } | { error: unknown }): void => {
			if (settled) return;
			settled = true;
			if (handler === handle) handler = undefined;
			setState("finished");
			if ("transcript" in outcome) {
				resolveTranscript(outcome.transcript);
				return;
			}
			failure = { error: outcome.error };
			rejectTranscript(outcome.error);
		};
		// The listener reports this connection's capture and its finished transcript.
		const handle = (frame: ListenerFrame): boolean => {
			if (frame.type === "transcript") {
				// A fallback is unsolicited, not this dictate's result. Treat an
				// unmarked transcript as before for older listeners.
				if (frame.captureId !== undefined && frame.captureId !== captureId) return false;
				settle({ transcript: { text: frame.text, truncated: frame.truncated === true } });
				return true;
			}
			if (frame.type !== "capture") return false;
			switch (frame.phase) {
				case "recording":
					setState("recording");
					return true;
				case "transcribing":
					setState("transcribing");
					return true;
				case "elsewhere":
				case "dropped":
					settle({ error: new ListenerDeliveryError(frame.phase) });
					return true;
				case "failed":
					settle({ error: new VoiceSessionError(frame.code ?? "internal") });
					return true;
				case "cancelled":
					settle({ error: new VoiceSessionError("cancelled") });
					return true;
				default:
					// Delivered: the transcript frame above already settled this capture.
					return true;
			}
		};
		const local = (): Promise<void> => {
			// The fence may have appeared while joining or asking for the microphone.
			checkShutdownWorker();
			if (handler === handle) handler = undefined;
			if (!fallback) ownCaptures.add((fallback = request.fallback()));
			return fallback.start();
		};
		return {
			get state() {
				return fallback ? fallback.state : state;
			},
			get owner() {
				return fallback ? "session" : "listener";
			},
			start: async () => {
				setState("starting");
				handler = handle;
				try {
					// Do not wait on an in-flight startup for a fenced microphone.
					if (!request.wake) checkShutdownWorker();
					const joiningPromise = ensure();
					waitingForJoin = joining;
					const joined = await joiningPromise;
					waitingForJoin = undefined;
					if (cancelled) return;
					if (request.wake && (!joined || !client || !request.wakeValid?.())) {
						releaseWake();
						throw new VoiceSessionError("cancelled");
					}
					if (!joined) return local();
					const active = client;
					if (!active) return local();
					let answer: ListenerFrame;
					try {
						requested = true;
						answer = await active.request({ type: "dictate", mode: request.mode, endpoint: request.endpoint }, options.dictateTimeoutMs ?? LISTENER_DICTATE_TIMEOUT_MS, (id) => { captureId = id; });
					} catch (error) {
						// Only confirmed unavailability records here instead: a listener that is
						// gone, or one that answered and refused. A timeout may still be owned by
						// the listener, so it is asked to let go and the start fails instead.
						if (cancelled) return;
						if (!active.connected || !(error instanceof ListenerTimeoutError)) {
							if (request.wake) throw new VoiceSessionError("cancelled");
							return local();
						}
						if (request.wake && request.wakeReservation) void request.wakeReservation.cancel();
						else void active.request({ type: "cancel" }).catch(() => {});
						throw new VoiceSessionError("timeout");
					}
					if (cancelled) return;
					// A refusal is obeyed, never routed around: another capture holds the mic.
					if (answer.type === "busy") throw new VoiceSessionError("invalid-state");
					if (answer.type !== "ok") throw new VoiceSessionError("protocol");
					if (failure) throw failure.error;
				} catch (error) {
					// A start that failed holds no capture, so its handler goes with it: a
					// later fallback transcript still reaches onTranscript.
					settle({ error });
					throw error;
				}
			},
			stop: () => {
				if (fallback) return fallback.stop();
				if (settled || stopSent) return transcript;
				stopSent = true;
				// The answer only proves the request was handled; the outcome arrives as
				// frames, and a listener that dies mid-capture settles it as a failure.
				void client?.request({ type: "stop" }).then(
					(frame) => {
						if (frame.type === "busy") settle({ error: new VoiceSessionError("invalid-state") });
					},
					() => settle({ error: new VoiceSessionError("worker-exited") }),
				);
				return transcript;
			},
			cancel: async () => {
				if (cancelled) return;
				cancelled = true;
				if (fallback) return fallback.cancel();
				if (settled || !requested) {
					if (request.wake && !requested) releaseWake();
					retireJoin(waitingForJoin);
					settle({ error: new VoiceSessionError("cancelled") });
					return;
				}
				try {
					if (request.wake && request.wakeReservation) await request.wakeReservation.cancel();
					else await client?.request({ type: "cancel" });
				} catch {
					/* the listener is gone: nothing is recording there any more */
				}
			},
		};
	};

	return {
		ensure,
		cancelWake,
		captureWake,
		updateVoice: (voiceOn) => {
			if (joining) {
				joining.allowStart = voiceOn;
				if (!voiceOn && !joining.client) retireJoin(joining);
			}
			client?.updateVoice(voiceOn);
		},
		dictate,
		close: () => {
			retireJoin(joining);
			wakeIdentity = undefined;
			handler = undefined;
			client?.close();
			detachAdopted?.();
			detachAdopted = undefined;
			client = undefined;
		},
	};
}
