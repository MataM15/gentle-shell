import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
	encodeListenerFrame,
	LISTENER_MAX_CLIENTS,
	LISTENER_MAX_FRAMES_PER_SECOND,
	LISTENER_MAX_LINE,
	parseListenerRequestLine,
	type ListenerErrorCode,
	type ListenerFrame,
	type ListenerRequest,
	type ListenerState,
} from "./voice-listener-protocol.ts";

// One voice listener for every Pi session (S6, odd/notes/voice-listener-design.md).
// Slice A owns the process, not the microphone: a single instance per voice home
// (an exclusive lock file plus the unix socket it binds), the JSON-lines registry
// every session joins, the state edges, focus resolution through herdr, and the
// rule that a transcript reaches the focused session only. Capture, the keyword
// spotter, cues and the overlay arrive in the later slices, so nothing here opens
// an audio device.

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

// The exclusive create is the primitive the reading turn already uses
// (lib/voice-presence.ts): whoever creates the file owns the listener.
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

export interface ListenerFocus {
	focusedPaneId(): Promise<string | undefined>;
}

interface Client {
	readonly socket: Socket;
	sessionId?: string;
	paneId?: string;
	voiceOn: boolean;
	label?: string;
	buffered: string;
	window: number;
	windowStart: number;
}

export interface VoiceListenerOptions {
	// The voice home shared by every Pi process of this user.
	dir: string;
	pid?: number;
	now?: () => number;
	log?: ListenerLog;
	// Focus comes from herdr; a failure or a changed shape focuses nothing, so
	// nothing is delivered and no microphone is opened for a guess.
	focus?: ListenerFocus;
	idleMs?: number;
	asleepIdleMs?: number;
}

const noFocus: ListenerFocus = { focusedPaneId: async () => undefined };

const withId = <T extends object>(frame: T, id?: string): T => (id === undefined ? frame : ({ ...frame, id } as T));

export class VoiceListener {
	readonly paths: ListenerPaths;
	private readonly options: VoiceListenerOptions;
	private readonly pid: number;
	private readonly now: () => number;
	private readonly log: ListenerLog;
	private readonly idleMs: number;
	private readonly asleepIdleMs: number;
	private server: Server | undefined;
	private readonly clients = new Map<Socket, Client>();
	private currentState: ListenerState = "asleep";
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;
	private closing = false;
	private closed: Promise<void> | undefined;

	constructor(options: VoiceListenerOptions) {
		this.options = options;
		this.paths = listenerPaths(options.dir);
		this.pid = options.pid ?? process.pid;
		this.now = options.now ?? Date.now;
		this.log = options.log ?? (() => {});
		this.idleMs = options.idleMs ?? LISTENER_IDLE_MS;
		this.asleepIdleMs = options.asleepIdleMs ?? LISTENER_ASLEEP_IDLE_MS;
	}

	get state(): ListenerState {
		return this.currentState;
	}

	get clientCount(): number {
		return this.clients.size;
	}

	// Binds the socket. Exactly one process can do this per voice home: the lock
	// alone is not enough because a starting session writes one too, so the
	// second listener fails here and stops before it owns anything.
	async listen(): Promise<void> {
		ensureDir(this.paths.dir);
		this.takeLock();
		clearStaleListenerSocket(this.paths.socket);
		const server = createServer((socket) => this.accept(socket));
		this.server = server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.paths.socket, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(this.paths.socket, 0o600);
		const heartbeat = setInterval(() => refreshListenerLock(this.paths, { pid: this.pid }), LISTENER_HEARTBEAT_MS);
		heartbeat.unref?.();
		this.heartbeat = heartbeat;
		this.log("listener.listen", { pid: this.pid });
		this.armIdle();
	}

	async close(reason: "idle" | "shutdown" | "error" = "shutdown"): Promise<void> {
		if (this.closed) return this.closed;
		this.closing = true;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
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
		try {
			unlinkSync(this.paths.socket);
		} catch {
			/* already gone */
		}
		releaseListenerLock(this.paths, { pid: this.pid });
		this.log("listener.exit", { reason });
	}

	// A transcript belongs to the session whose pane is focused when the
	// recording ends. It is never broadcast, buffered or retried, and the session
	// that asked always learns the outcome through its own request.
	async deliverTranscript(text: string): Promise<string | undefined> {
		const clients = [...this.clients.values()].filter((client) => client.sessionId);
		if (clients.length === 0) {
			this.log("transcript.undelivered", { clients: 0 });
			return undefined;
		}
		const withPane = clients.filter((client) => client.paneId);
		const focused = await (this.options.focus ?? noFocus).focusedPaneId();
		// A known focused pane decides alone; with nobody focused the single
		// registered session still counts (design §2.2, §2.3), and anything else is
		// dropped rather than broadcast.
		let target = focused === undefined ? undefined : withPane.find((client) => client.paneId === focused);
		if (!target && focused === undefined && clients.length === 1) target = clients[0];
		if (!target) {
			this.log("transcript.undelivered", { clients: clients.length });
			return undefined;
		}
		this.say(target, { type: "transcript", text });
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
		const client: Client = { socket, voiceOn: false, buffered: "", window: 0, windowStart: this.now() };
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
		for (const other of [...this.clients.values()]) {
			// One session, one live socket: a reloaded session replaces its old one.
			if (other === client || other.sessionId !== hello.sessionId) continue;
			this.say(other, { type: "bye", reason: "shutdown" });
			this.forget(other);
		}
		client.sessionId = hello.sessionId;
		client.paneId = hello.paneId;
		client.voiceOn = hello.voiceOn;
		client.label = hello.label;
		this.say(client, withId({ type: "welcome", listenerPid: this.pid, proto: 1, state: this.currentState }, hello.id));
		this.log("listener.hello", { sessionId: hello.sessionId, voiceOn: hello.voiceOn, clients: this.clients.size });
		this.armIdle();
	}

	private apply(client: Client, request: Exclude<ListenerRequest, { type: "hello" }>): void {
		switch (request.type) {
			case "set-voice": {
				client.voiceOn = request.voiceOn;
				this.log("listener.voice", { sessionId: client.sessionId, voiceOn: request.voiceOn });
				this.say(client, withId({ type: "ok", request: "set-voice" }, request.id));
				// L10: voice off from any session turns voice off everywhere.
				this.broadcast({ type: "command", command: request.voiceOn ? "voice-on" : "voice-off" });
				if (!request.voiceOn) this.setState("asleep");
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
							sessions: [...this.clients.values()].flatMap((entry) => (entry.sessionId ? [entry.sessionId] : [])),
						},
						request.id,
					),
				);
				return;
		}
	}

	private setState(next: ListenerState): void {
		if (next === this.currentState) {
			this.armIdle();
			return;
		}
		this.currentState = next;
		this.log("listener.state", { state: next });
		this.broadcast({ type: "state", state: next, at: this.now() });
		this.armIdle();
	}

	private broadcast(frame: ListenerFrame): void {
		for (const client of [...this.clients.values()]) if (client.sessionId) this.say(client, frame);
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
		if (!this.clients.delete(client.socket)) return;
		client.socket.end(encodeListenerFrame({ type: "error", code }));
		this.log("listener.rejected", { code, sessionId: client.sessionId });
		this.armIdle();
	}

	private forget(client: Client): void {
		if (!this.clients.delete(client.socket)) return;
		client.socket.destroy();
		this.log("listener.client-closed", { sessionId: client.sessionId, clients: this.clients.size });
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
		const wantsVoice = [...this.clients.values()].some((client) => client.sessionId && client.voiceOn);
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
	const read = async (): Promise<HerdrAgent[]> => {
		if (cached && now() - cached.at < ttlMs) return cached.agents;
		cached = undefined;
		try {
			const agents = parseHerdrAgents(await (options.run ?? runHerdr)(env.HERDR_BIN_PATH?.trim() || "herdr", ["agent", "list"]));
			if (!agents) return [];
			cached = { at: now(), agents };
			return agents;
		} catch {
			return [];
		}
	};
	return { agents: read, focusedPaneId: async () => (await read()).find((agent) => agent.focused)?.paneId };
}
