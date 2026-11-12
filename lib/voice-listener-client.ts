import { createConnection, type Socket } from "node:net";
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
	type ListenerFrame,
	type ListenerRequest,
	type ListenerState,
} from "./voice-listener-protocol.ts";

// The session side of the one voice listener (S6, slice A): join the running
// listener, start it once when it is absent, and keep the same session id across
// a listener restart. Nothing here records audio; the listener owns the
// microphone from slice C on, and this module only speaks its protocol.

export const LISTENER_START_TIMEOUT_MS = 10_000;
export const LISTENER_REQUEST_TIMEOUT_MS = 5_000;
// 250 ms → 2 s, capped: a killed listener costs one retry, never a stuck voice.
export const LISTENER_BACKOFF_MS = [250, 500, 1_000, 2_000] as const;
const PROBE_INTERVAL_MS = 50;

export interface ListenerSession {
	sessionId: string;
	paneId?: string;
	label?: string;
	voiceOn: boolean;
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

	request(frame: ListenerRequest): Promise<ListenerFrame> {
		const socket = this.socket;
		if (!socket || socket.destroyed) return Promise.reject(new Error("voice listener is not connected"));
		const id = String(this.nextId++);
		const answered = new Promise<ListenerFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("the voice listener did not answer"));
			}, LISTENER_REQUEST_TIMEOUT_MS);
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
