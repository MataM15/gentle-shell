import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import {
	clearStaleListenerLock,
	clearStaleListenerSocket,
	listenerPaths,
	probeListenerSocket,
	releaseListenerLock,
	takeListenerLock,
	type ListenerPaths,
} from "./voice-listener.ts";
import {
	encodeListenerFrame,
	parseListenerFrameLine,
	LISTENER_MAX_LINE,
	type CaptureMode,
	type ListenerFrame,
	type ListenerRequest,
	type ListenerState,
	type ReadingOutcome,
	type ReadingReleaseReason,
} from "./voice-listener-protocol.ts";
import { VoiceSessionError, type VoiceEndpoint, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";

// The session side of the one voice listener (S6): join the running listener,
// start it once when it is absent, keep the same session id across a listener
// restart, ask it for the one reading turn (slice B), and, from slice C, ask it
// for the microphone: the listener records and transcribes, and this side hands
// the transcript back to the session that pastes it. Nothing here records audio
// or speaks. A session that cannot reach the listener keeps its own capture, so
// dictation works exactly as it did before the listener existed.

export const LISTENER_START_TIMEOUT_MS = 10_000;
export const LISTENER_REQUEST_TIMEOUT_MS = 5_000;
// A capture start waits for the warm worker to load its model, and a cold start
// takes about 6.3 s: dictate gets a wait of its own, well past that.
export const LISTENER_DICTATE_TIMEOUT_MS = 30_000;
// 250 ms → 2 s, capped: a killed listener costs one retry, never a stuck voice.
export const LISTENER_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;
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
	session: ListenerSession;
	dial?: (path: string) => Socket;
	backoffMs?: readonly number[];
	onFrame?: (frame: ListenerFrame) => void;
}

interface Pending {
	resolve(frame: ListenerFrame): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
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
	private joined = false;
	private closed = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private currentState: ListenerState = "asleep";

	constructor(options: VoiceListenerClientOptions) {
		this.options = options;
		this.paths = listenerPaths(options.dir);
		if (options.onFrame) this.listeners.add(options.onFrame);
	}

	// Joined means the hello was answered: a socket that is still dialing is not
	// connected, so a caller never sends a request into a half-open connection.
	get connected(): boolean {
		return this.joined && Boolean(this.socket && !this.socket.destroyed);
	}

	get listenerState(): ListenerState {
		return this.currentState;
	}

	onFrame(handler: (frame: ListenerFrame) => void): () => void {
		this.listeners.add(handler);
		return () => this.listeners.delete(handler);
	}

	// One attempt: dials, sends hello and resolves with the state the listener
	// reports. Throws when the listener is not there or refuses the session.
	async connect(): Promise<ListenerState> {
		const socket = (this.options.dial ?? createConnection)(this.paths.socket);
		socket.setEncoding("utf8");
		this.buffered = "";
		this.socket = socket;
		socket.on("data", (chunk: string) => this.receive(chunk));
		socket.on("error", () => {});
		socket.on("close", () => this.disconnected(socket));
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", reject);
		});
		const { sessionId, paneId, label, voiceOn } = this.options.session;
		const frame = await this.request({ type: "hello", proto: 1, sessionId, paneId, label, voiceOn });
		if (frame.type !== "welcome") throw new Error("the voice listener refused hello");
		this.currentState = frame.state;
		this.joined = true;
		this.attempt = 0;
		return frame.state;
	}

	request(frame: ListenerRequest, timeoutMs = LISTENER_REQUEST_TIMEOUT_MS): Promise<ListenerFrame> {
		const socket = this.socket;
		if (!socket || socket.destroyed) return Promise.reject(new Error("voice listener is not connected"));
		const id = String(this.nextId++);
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
		this.closed = true;
		this.joined = false;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		this.failPending(new Error("voice listener client closed"));
		this.socket?.destroy();
		this.socket = undefined;
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
		}
		if (this.buffered.length > LISTENER_MAX_LINE) this.buffered = "";
	}

	private dispatch(frame: ListenerFrame): void {
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
		if (frame.type === "state") this.currentState = frame.state;
		for (const listener of [...this.listeners]) listener(frame);
	}

	private disconnected(socket: Socket): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.joined = false;
		this.failPending(new Error("the voice listener connection closed"));
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
		if (this.closed || this.reconnectTimer) return;
		const delays = this.options.backoffMs ?? LISTENER_BACKOFF_MS;
		const delay = delays[Math.min(this.attempt, delays.length - 1)];
		this.attempt += 1;
		const timer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.connect().catch(() => this.scheduleReconnect());
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
	waitMs?: number;
	now?: number;
	isAlive?: (pid: number) => boolean;
}

// The poll timer stays referenced: waiting for the listener is live work, and an
// unref'd timer would let the event loop empty in the middle of it.
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForListener(path: string, waitMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (await probeListenerSocket(path)) return true;
		if (Date.now() >= deadline) return false;
		await wait(PROBE_INTERVAL_MS);
	}
}

// Joins the listener, or starts exactly one and joins it. The start lock is
// released before spawning because the listener takes its own; two sessions
// racing here cannot both win, and the loser's process fails to bind and stops.
export async function ensureListener(options: EnsureListenerOptions): Promise<{ client: VoiceListenerClient; started: boolean }> {
	const paths = listenerPaths(options.dir);
	const waitMs = options.waitMs ?? LISTENER_START_TIMEOUT_MS;
	const join = async (started: boolean) => {
		const client = (options.createClient ?? (() => new VoiceListenerClient({ dir: options.dir, session: options.session })))();
		await client.connect();
		return { client, started };
	};
	if (await probeListenerSocket(paths.socket)) return join(false);

	// A lock somebody is renewing means a listener is starting or running: wait
	// for its socket instead of starting a second microphone owner.
	if (!clearStaleListenerLock(paths, { now: options.now, isAlive: options.isAlive })) {
		if (await waitForListener(paths.socket, waitMs)) return join(false);
		throw new Error("voice_listener_busy");
	}
	const lock = takeListenerLock(paths, { now: options.now, socket: paths.socket });
	if (!lock) {
		if (await waitForListener(paths.socket, waitMs)) return join(false);
		throw new Error("voice_listener_busy");
	}
	// A path that is not this user's socket is refused, never unlinked.
	clearStaleListenerSocket(paths.socket);
	releaseListenerLock(paths, { pid: lock.pid });
	await options.start?.();
	if (await waitForListener(paths.socket, waitMs)) return join(true);
	throw new Error("voice_listener_missing");
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
export type ListenerReading = { kind: "granted"; release: (outcome?: ReadingOutcome) => void } | { kind: "unavailable" };

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
		const joined = await ensureListener({ dir: options.dir, session: options.session, start: options.start, waitMs: options.waitMs });
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
	const client = new VoiceListenerClient({ dir: options.dir, session: options.session });
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

// The utterance was transcribed and then delivered somewhere else: the focused
// pane decides, and a session that is not it never receives a copy (S6).
export class ListenerDeliveryError extends Error {
	readonly kind: "elsewhere" | "dropped";
	constructor(kind: "elsewhere" | "dropped") {
		super(kind === "elsewhere" ? "The transcript went to the session that had the focus." : "No session had the focus, so the transcript was dropped.");
		this.name = "ListenerDeliveryError";
		this.kind = kind;
	}
}

export interface ListenerDictationOptions {
	mode: CaptureMode;
	endpoint?: VoiceEndpoint;
	onStateChange(state: VoiceSessionState): void;
	// What records when the listener cannot be reached: the session's own capture,
	// exactly as it worked before the listener existed.
	fallback(): SessionDictation;
}

export interface SessionListenerLink {
	// True when this session is joined to a running listener; starts one once.
	ensure(): Promise<boolean>;
	dictate(options: ListenerDictationOptions): SessionDictation;
	close(): void;
}

export interface SessionListenerLinkOptions {
	dir: string;
	session(): ListenerSession | undefined;
	start?: () => void | Promise<void>;
	waitMs?: number;
	// How long the listener gets to accept a dictate, before the start fails.
	dictateTimeoutMs?: number;
	backoffMs?: readonly number[];
	// A transcript the listener handed to this session: another session recorded
	// it and this pane had the focus. It is handed over once, never buffered.
	onTranscript?(text: string, truncated: boolean): void;
}

// One connection per session carries both roles: it registers the pane that the
// focus sends a transcript to, and it asks for the microphone. A capture that
// cannot get the listener records here instead of failing the dictation.
export function createSessionListenerLink(options: SessionListenerLinkOptions): SessionListenerLink {
	let client: VoiceListenerClient | undefined;
	let handler: ((frame: ListenerFrame) => boolean) | undefined;
	const route = (frame: ListenerFrame): void => {
		if (handler?.(frame)) return;
		// No capture of this session asked for it: the focus sent it here (S6).
		if (frame.type === "transcript") options.onTranscript?.(frame.text, frame.truncated === true);
	};

	const ensure = async (): Promise<boolean> => {
		if (client?.connected) return true;
		const session = options.session();
		if (!session) return false;
		if (client) {
			try {
				await client.connect();
				return true;
			} catch {
				/* the lock or the socket is gone: start a listener below */
			}
		}
		try {
			const joined = await ensureListener({
				dir: options.dir,
				session,
				start: options.start,
				waitMs: options.waitMs,
				createClient: () => (client = new VoiceListenerClient({ dir: options.dir, session, backoffMs: options.backoffMs, onFrame: route })),
			});
			client = joined.client;
			return true;
		} catch {
			return false;
		}
	};

	const dictate = (request: ListenerDictationOptions): SessionDictation => {
		let state: VoiceSessionState = "idle";
		let fallback: SessionDictation | undefined;
		let stopSent = false;
		let settled = false;
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
		// The listener reports the capture it holds here; the transcript itself only
		// arrives when this pane has the focus.
		const handle = (frame: ListenerFrame): boolean => {
			if (frame.type === "transcript") {
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
			if (handler === handle) handler = undefined;
			return (fallback ??= request.fallback()).start();
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
					if (!(await ensure())) return local();
					const active = client;
					if (!active) return local();
					let answer: ListenerFrame;
					try {
						answer = await active.request({ type: "dictate", mode: request.mode, endpoint: request.endpoint }, options.dictateTimeoutMs ?? LISTENER_DICTATE_TIMEOUT_MS);
					} catch (error) {
						// Only confirmed unavailability records here instead: a listener that is
						// gone, or one that answered and refused. A timeout may still be owned by
						// the listener, so it is asked to let go and the start fails instead.
						if (!active.connected || !(error instanceof ListenerTimeoutError)) return local();
						void active.request({ type: "cancel" }).catch(() => {});
						throw new VoiceSessionError("timeout");
					}
					// A refusal is obeyed, never routed around: another capture holds the mic.
					if (answer.type === "busy") throw new VoiceSessionError("invalid-state");
					if (answer.type !== "ok") throw new VoiceSessionError("protocol");
					if (failure) throw failure.error;
				} catch (error) {
					// A start that failed holds no capture, so its handler goes with it: a
					// transcript the focus sends this session still reaches onTranscript.
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
				if (fallback) return fallback.cancel();
				if (settled) return;
				try {
					await client?.request({ type: "cancel" });
				} catch {
					/* the listener is gone: nothing is recording there any more */
				}
			},
		};
	};

	return {
		ensure,
		dictate,
		close: () => {
			handler = undefined;
			client?.close();
			client = undefined;
		},
	};
}
