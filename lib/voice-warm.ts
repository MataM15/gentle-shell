import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { VoiceTarget } from "./voice-artifacts.ts";
import {
	childEnv,
	defaultSpawn,
	MAX_LINE,
	parseWorkerLine,
	prepareVoiceWorkerLaunch,
	VOICE_SESSION_DEFAULTS,
	VOICE_WORKER_SCHEMA,
	VOICE_WORKER_URL,
	VoiceSessionError,
	type VoiceEndpoint,
	type VoiceKeywordOption,
	type VoiceSessionErrorCode,
	type VoiceSessionState,
	type VoiceTranscript,
	type VoiceWorkerChild,
	type VoiceWorkerSpawnOptions,
	type WorkerMessage,
} from "./voice-session.ts";

// The warm dictation worker (docs/voice.md, "Faster transcription"). A
// single-use session starts a worker per recording, which verifies the 670 MB
// model digests and loads the recognizer every time: about 6 seconds before a
// 0.4-second decode. In a voice session one worker is kept alive with
// `keepAlive: true` and answers recording after recording, so the model is
// verified and loaded once. The microphone is still opened only while
// recording. The worker closes after it has been idle for a while, when voice
// is turned off and when the Pi session ends; any error or a cancel ends it,
// and the next recording starts a fresh one.

export const WARM_WORKER_DEFAULTS = {
	idleMs: 10 * 60_000,
	// Measured on the owner's 10-core machine: 4 threads decode fastest.
	numThreads: 4,
	closeGraceMs: 2_000,
} as const;

const RECORDING_MARGIN_MS = 10_000;
const MAX_NATIVE_DIAGNOSTIC_LINE = 128;
const NATIVE_CAPTURE_KINDS = [
	"DEVICE_BUSY", "DEVICE_CHANGED", "DEVICE_NOT_AVAILABLE", "HOST_UNAVAILABLE", "INVALID_INPUT", "PERMISSION_DENIED", "REALTIME_DENIED", "RESOURCE_EXHAUSTED", "STREAM_INVALIDATED", "UNSUPPORTED_CONFIG", "UNSUPPORTED_OPERATION", "BACKEND_ERROR", "CALLBACK_FAILED", "OTHER", "UNKNOWN",
] as const;

export interface NativeCaptureError { readonly phase: "open" | "stream"; readonly kind: typeof NATIVE_CAPTURE_KINDS[number] }

export type KeywordRejectionReason = "lead" | "speech-after" | "no-utterance" | "unknown-command" | "superseded" | "stopped" | "ended" | "cancelled";
export interface KeywordRejection { readonly command: string; readonly reason: KeywordRejectionReason }

export interface WarmDictation {
	readonly state: VoiceSessionState;
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
	// The result can arrive before a retiring worker releases the microphone.
	waitUntilReleased(): Promise<void>;
}

// A spot-only capture (S7): the microphone open for the keyword spotter alone.
// It has no transcript and no end of its own; it is `recording` while it listens.
export interface WarmSpotting {
	readonly state: VoiceSessionState;
	// Resolves once the microphone is open.
	start(): Promise<void>;
	// The command that was heard, or undefined when the capture was stopped.
	heard(): Promise<string | undefined>;
	// After a busy start, wait for the capture that refused it to release its worker.
	waitUntilSettled(): Promise<void>;
	// Closes the microphone and keeps the worker.
	stop(): Promise<void>;
	cancel(): Promise<void>;
}

export interface WarmVoiceWorkerOptions {
	target: VoiceTarget;
	env?: NodeJS.ProcessEnv;
	idleMs?: number;
	// Audio-free, fixed-code diagnostics from the worker's stderr; advisory only.
	onNativeError?: (error: NativeCaptureError) => void;
	// Tests only: the install check and launch, the process and its script.
	prepare?: () => Promise<{ root: string; request: Record<string, unknown> }>;
	spawn?: (executable: string, args: string[], options: VoiceWorkerSpawnOptions) => VoiceWorkerChild;
	workerPath?: string;
}

export interface WarmVoiceWorker {
	// `levels`: the worker publishes the microphone RMS for a display, and it is
	// handed to `onLevel` while recording. A session that does not ask sends
	// exactly the request it always did.
	// `kws`: the worker also listens for spoken commands while it records, and a
	// capture that ends on one resolves with `command` set and an empty text.
	session(options: { onStateChange(state: VoiceSessionState): void; endpoint?: VoiceEndpoint; levels?: boolean; onLevel?: (rms: number) => void; kws?: VoiceKeywordOption; onKeywordRejected?: (hit: KeywordRejection) => void }): WarmDictation;
	// Listens for spoken commands only, on the same worker and its one spotter.
	spot(options: { kws: VoiceKeywordOption; onStateChange?(state: VoiceSessionState): void; onKeywordRejected?: (hit: KeywordRejection) => void }): WarmSpotting;
	// A child that reached transcription may hold the dictation model.
	needsRecycle(): boolean;
	// Retire that child, waiting for its exit before another child may start.
	recycle(graceMs?: number): Promise<boolean>;
	// Closes the worker, killing it if it has not exited within graceMs.
	close(graceMs?: number): Promise<void>;
}

const fail = (code: VoiceSessionErrorCode) => new VoiceSessionError(code);

interface Live {
	child: VoiceWorkerChild;
	closed: Promise<void>;
	exited: boolean;
	transcribed: boolean;
	// A cancelled worker can report its last pending hit before it exits.
	cancelling?: Capture;
}

interface Capture {
	state: VoiceSessionState;
	onStateChange(state: VoiceSessionState): void;
	levels: boolean;
	onLevel?: (rms: number) => void;
	onKeywordRejected?: (hit: KeywordRejection) => void;
	// Asked for keyword spotting; and, when `spot`, for nothing else.
	kws: boolean;
	spot: boolean;
	recording: { resolve(): void; reject(error: unknown): void };
	result: { resolve(transcript: VoiceTranscript): void; reject(error: unknown): void };
	// A failed or cancelled capture may have an outcome before its child exits.
	released: Promise<void>;
	release(): void;
	entry?: Live;
	settled: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

// The shared single-use parser intentionally stays unchanged: only warm clients
// that opted in receive this exact, audio-free diagnostic message.
const parseKeywordRejection = (line: string): KeywordRejection | undefined => {
	let value: unknown;
	try { value = JSON.parse(line); } catch { return undefined; }
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = ["schema", "type", "command", "reason"];
	if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) return undefined;
	if (record.schema !== VOICE_WORKER_SCHEMA || record.type !== "keyword-rejected") return undefined;
	if (typeof record.command !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(record.command)) return undefined;
	const reasons: readonly unknown[] = ["lead", "speech-after", "no-utterance", "unknown-command", "superseded", "stopped", "ended"];
	if (!reasons.includes(record.reason)) return undefined;
	return { command: record.command, reason: record.reason as KeywordRejectionReason };
};

const unref = (handle: ReturnType<typeof setTimeout>) => {
	(handle as { unref?: () => void }).unref?.();
	return handle;
};

export function createWarmVoiceWorker(options: WarmVoiceWorkerOptions): WarmVoiceWorker {
	const env = options.env ?? process.env;
	const prepare = options.prepare ?? (() => prepareVoiceWorkerLaunch({ target: options.target, env }));
	const spawn = options.spawn ?? defaultSpawn;
	const idleMs = options.idleMs ?? WARM_WORKER_DEFAULTS.idleMs;
	let live: Live | undefined;
	let current: Capture | undefined;
	let retiring: Promise<void> | undefined;
	// A child that survives SIGKILL must still fence the microphone, but callers
	// cannot wait forever for its close event.
	let retirementFailure: Promise<never> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	// A terminal worker message is written before the process exits. Do not send
	// another start to it, or let a replacement own the microphone before it exits.
	const retire = (entry: Live) => {
		if (live === entry) live = undefined;
		const previous = retiring;
		const waiting = previous ? Promise.all([previous, entry.closed]).then(() => {}) : entry.closed;
		retiring = waiting;
		void waiting.then(() => { if (retiring === waiting) retiring = undefined; });
	};

	const setState = (capture: Capture, state: VoiceSessionState) => {
		if (capture.state === state) return;
		capture.state = state;
		try {
			capture.onStateChange(state);
		} catch {
			/* the observer is advisory */
		}
	};
	const settle = (capture: Capture, outcome: { transcript: VoiceTranscript } | { error: VoiceSessionError }, releaseAfter?: Promise<void>) => {
		if (capture.settled) return;
		capture.settled = true;
		if (capture.timer) clearTimeout(capture.timer);
		if (current === capture) current = undefined;
		setState(capture, "finished");
		if ("transcript" in outcome) {
			capture.result.resolve(outcome.transcript);
		} else {
			capture.recording.reject(outcome.error);
			capture.result.reject(outcome.error);
		}
		if (releaseAfter) void releaseAfter.then(capture.release);
		else capture.release();
		if (!current && live && !live.exited) armIdle();
	};
	const arm = (capture: Capture, ms: number) => {
		if (capture.timer) clearTimeout(capture.timer);
		capture.timer = unref(setTimeout(() => {
			const entry = capture.entry;
			if (entry) retire(entry);
			settle(capture, { error: fail("timeout") }, entry?.closed);
			if (entry) kill(entry);
		}, ms));
	};
	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = unref(setTimeout(() => void close(), idleMs));
	};
	const kill = (entry: Live | undefined = live) => {
		try {
			entry?.child.kill("SIGKILL");
		} catch {
			/* close still follows */
		}
	};
	const send = (message: Record<string, unknown>) => {
		try {
			live?.child.stdin?.write(`${JSON.stringify(message)}\n`);
		} catch {
			/* a worker that cannot be written to is gone; close settles it */
		}
	};

	const onMessage = (message: WorkerMessage) => {
		const capture = current;
		if (!capture) return;
		switch (message.type) {
			case "level":
				// A display stream: only a session that asked for it is handed one,
				// and a callback that throws can never disturb the recording.
				if (!capture.levels) return;
				try {
					capture.onLevel?.(message.rms);
				} catch {
					/* the display is advisory */
				}
				return;
			case "recording":
				if (capture.spot || capture.state !== "starting") return protocolError();
				setState(capture, "recording");
				arm(capture, VOICE_SESSION_DEFAULTS.maxRecordingMs + RECORDING_MARGIN_MS);
				capture.recording.resolve();
				return;
			case "spotting":
				if (!capture.spot || capture.state !== "starting") return protocolError();
				setState(capture, "recording");
				// No limit: it listens until a command is heard or it is told to stop.
				if (capture.timer) clearTimeout(capture.timer);
				capture.recording.resolve();
				return;
			case "command":
				// Only a capture that asked for keywords is handed one; a stray one
				// changes nothing.
				if (!capture.kws) return;
				if (capture.state !== "recording" && capture.state !== "transcribing") return protocolError();
				settle(capture, { transcript: { text: "", truncated: false, command: message.command } });
				return;
			case "stopped":
				if (!capture.spot) return;
				if (capture.state !== "recording" && capture.state !== "transcribing") return protocolError();
				settle(capture, { transcript: { text: "", truncated: false } });
				return;
			case "transcribing":
				if (capture.spot) return protocolError();
				if (capture.entry) capture.entry.transcribed = true;
				if (capture.state === "recording") {
					setState(capture, "transcribing");
					arm(capture, VOICE_SESSION_DEFAULTS.transcribeTimeoutMs);
				} else if (capture.state !== "transcribing") protocolError();
				return;
			case "result": {
				if (capture.spot || capture.state !== "transcribing") return protocolError();
				const text = message.text.trim();
				settle(capture, text ? { transcript: { text, truncated: message.truncated } } : { error: fail("no-speech") });
				return;
			}
			case "error": {
				// The error is the child's last message, not its exit. Bound a child
				// that never exits and keep the microphone reserved until it does.
				const entry = live;
				if (entry) {
					retire(entry);
					const timer = setTimeout(() => kill(entry), VOICE_SESSION_DEFAULTS.exitGraceMs);
					void entry.closed.then(() => clearTimeout(timer));
				}
				settle(capture, { error: fail(message.code) }, entry?.closed);
			}
		}
	};
	const protocolError = () => {
		const entry = live;
		if (entry) retire(entry);
		if (current) settle(current, { error: fail("protocol") }, entry?.closed);
		if (entry) kill(entry);
	};

	const launch = (root: string): Live => {
		const child = spawn(process.execPath, [options.workerPath ?? fileURLToPath(VOICE_WORKER_URL)], {
			cwd: root,
			shell: false,
			windowsHide: true,
			detached: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: childEnv(env),
		});
		let resolveClosed!: () => void;
		const entry: Live = { child, closed: new Promise((resolve) => { resolveClosed = resolve; }), exited: false, transcribed: false };
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		child.stdout?.on("data", (chunk: unknown) => {
			buffered += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const message = line.length <= MAX_LINE ? parseWorkerLine(line) : undefined;
				const rejected = line.length <= MAX_LINE && !message ? parseKeywordRejection(line) : undefined;
				const diagnosticCapture = entry.cancelling ?? (live === entry ? current : undefined);
				if (message?.type === "command" && entry.cancelling?.kws) {
					try { entry.cancelling.onKeywordRejected?.({ command: message.command, reason: "cancelled" }); } catch { /* diagnostics are advisory */ }
				} else if (message && live === entry) onMessage(message);
				else if (rejected && diagnosticCapture?.kws && diagnosticCapture.onKeywordRejected && (entry.cancelling === diagnosticCapture || diagnosticCapture.state === "recording" || diagnosticCapture.state === "transcribing")) {
					try { diagnosticCapture.onKeywordRejected(rejected); } catch { /* diagnostics are advisory */ }
				} else if (live === entry) protocolError();
			}
			if (buffered.length > MAX_LINE) protocolError();
		});
		// Native libraries can print paths or device names: only accept fixed,
		// complete diagnostic lines. Oversized lines are discarded until newline.
		const stderrDecoder = new StringDecoder("utf8");
		let stderrBuffered = "";
		let discardStderrLine = false;
		child.stderr?.on("data", (chunk: unknown) => {
			const text = typeof chunk === "string" ? chunk : stderrDecoder.write(chunk as Buffer);
			let at = 0;
			while (at < text.length) {
				const newline = text.indexOf("\n", at);
				const end = newline === -1 ? text.length : newline;
				if (!discardStderrLine) {
					if (stderrBuffered.length + end - at > MAX_NATIVE_DIAGNOSTIC_LINE) { stderrBuffered = ""; discardStderrLine = true; }
					else stderrBuffered += text.slice(at, end);
				}
				if (newline === -1) break;
				if (!discardStderrLine) {
					const match = /^gentle-voice-diag capture (open|stream):([A-Z_]+)$/.exec(stderrBuffered);
					if (match && (NATIVE_CAPTURE_KINDS as readonly string[]).includes(match[2]!)) {
						try { options.onNativeError?.({ phase: match[1] as NativeCaptureError["phase"], kind: match[2] as NativeCaptureError["kind"] }); } catch { /* diagnostics are advisory */ }
					}
				}
				stderrBuffered = "";
				discardStderrLine = false;
				at = newline + 1;
			}
		});
		child.stdin?.on("error", () => {});
		child.once("error", () => {
			/* close follows a spawn error */
		});
		child.once("close", () => {
			entry.exited = true;
			if (live === entry) {
				live = undefined;
				if (idleTimer) clearTimeout(idleTimer);
			}
			// A retired child cannot fail a capture reserved for its replacement.
			if (current?.entry === entry) settle(current, { error: fail("worker-exited") });
			resolveClosed();
		});
		return entry;
	};

	const close = async (graceMs: number = WARM_WORKER_DEFAULTS.closeGraceMs): Promise<void> => {
		if (idleTimer) clearTimeout(idleTimer);
		const entry = live;
		if (!entry) {
			if (current) settle(current, { error: fail("cancelled") }, retiring);
			if (retiring && retirementFailure) await Promise.race([retiring, retirementFailure]);
			else await retiring;
			return;
		}
		const active = current;
		retire(entry);
		if (active) settle(active, { error: fail("cancelled") }, entry.closed);
		try {
			// The worker accepts close only when idle; an active capture is cancelled.
			entry.child.stdin?.write(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: active ? "cancel" : "close" })}\n`);
			entry.child.stdin?.end();
		} catch {
			/* already gone */
		}
		// Not unref'd: Pi must not exit before its worker is gone.
		const timer = setTimeout(() => {
			try {
				entry.child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}, graceMs);
		await entry.closed;
		clearTimeout(timer);
	};

	const recycle = async (graceMs: number = WARM_WORKER_DEFAULTS.closeGraceMs): Promise<boolean> => {
		const entry = live;
		if (!entry?.transcribed) return false;
		// A dictation is never interrupted. A stuck spot-only stop can instead be
		// cancelled by close(), which still fences the child until it exits.
		if (current && !current.spot) throw fail("invalid-state");
		let rejectFailure!: (error: VoiceSessionError) => void;
		const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
		retirementFailure = failure;
		void entry.closed.then(() => { if (retirementFailure === failure) retirementFailure = undefined; });
		// close() sends close, then SIGKILL at graceMs. If even that does not
		// produce close, fail waiting captures while still fencing a new child.
		const timer = setTimeout(() => rejectFailure(fail("worker-exited")), graceMs * 2);
		try {
			await Promise.race([close(graceMs), failure]);
			return true;
		} finally {
			clearTimeout(timer);
		}
	};

	// One capture on the worker: a dictation, or with `spot` a capture for the
	// keyword spotter alone. `result` is the outcome without asking it to stop.
	const open = ({ onStateChange, endpoint, levels, onLevel, kws, spot, onKeywordRejected }: { onStateChange(state: VoiceSessionState): void; endpoint?: VoiceEndpoint; levels?: boolean; onLevel?: (rms: number) => void; kws?: VoiceKeywordOption; spot?: boolean; onKeywordRejected?: (hit: KeywordRejection) => void }): WarmDictation & { result(): Promise<VoiceTranscript>; waitUntilSettled(): Promise<void> } => {
			let recording!: Capture["recording"];
			let result!: Capture["result"];
			let release!: () => void;
			let blockedBy: Promise<void> | undefined;
			const released = new Promise<void>((resolve) => { release = resolve; });
			const recordingPromise = new Promise<void>((resolve, reject) => { recording = { resolve, reject }; });
			const resultPromise = new Promise<VoiceTranscript>((resolve, reject) => { result = { resolve, reject }; });
			recordingPromise.catch(() => {});
			resultPromise.catch(() => {});
			const capture: Capture = { state: "idle", onStateChange, levels: levels === true, onLevel, onKeywordRejected, kws: kws !== undefined, spot: spot === true, recording, result, released, release, settled: false };
			return {
				get state() {
					return capture.state;
				},
				result: () => resultPromise,
				// Reuse the capture release that the busy-spot retry already waits for.
				waitUntilReleased: () => blockedBy ?? released,
				// A refused busy start waits on its owner; a terminal start error
				// waits on this capture's child, not merely on the error message.
				waitUntilSettled: () => blockedBy ?? (capture.state === "idle" ? Promise.resolve() : released),
				async start() {
					if (capture.state !== "idle") throw fail("invalid-state");
					if (current) {
						blockedBy = current.released;
						throw fail("invalid-state");
					}
					blockedBy = undefined;
					current = capture;
					setState(capture, "starting");
					if (idleTimer) clearTimeout(idleTimer);
					let prepared: { root: string; request: Record<string, unknown> };
					try {
						prepared = await prepare();
					} catch (error) {
						settle(capture, { error: error instanceof VoiceSessionError ? error : fail("not-installed") });
						throw error instanceof VoiceSessionError ? error : fail("not-installed");
					}
					while (retiring && !capture.settled) {
						try { await (retirementFailure ? Promise.race([retiring, retirementFailure]) : retiring); }
						catch (error) {
							if (!capture.settled) settle(capture, { error: error instanceof VoiceSessionError ? error : fail("worker-exited") });
							return recordingPromise;
						}
					}
					if (capture.settled) return recordingPromise;
					live ??= launch(prepared.root);
					capture.entry = live;
					arm(capture, VOICE_SESSION_DEFAULTS.startTimeoutMs);
					send({
						...prepared.request,
						numThreads: WARM_WORKER_DEFAULTS.numThreads,
						...(endpoint ? { endpoint: { endOfSpeechMs: endpoint.endOfSpeechMs, noSpeechMs: endpoint.noSpeechMs } } : {}),
						...(levels === true ? { levels: true } : {}),
						...(kws ? { kws } : {}),
						...(kws && onKeywordRejected ? { keywordDiagnostics: true } : {}),
						...(spot === true ? { spot: true } : {}),
						keepAlive: true,
					});
					return recordingPromise;
				},
				async stop() {
					if (capture.state === "idle" || capture.state === "starting") throw fail("invalid-state");
					if (capture.state === "recording" && !capture.settled) {
						send({ schema: VOICE_WORKER_SCHEMA, type: "stop" });
						setState(capture, "transcribing");
						arm(capture, VOICE_SESSION_DEFAULTS.transcribeTimeoutMs);
					}
					return resultPromise;
				},
				// The worker leaves on cancel; it settles once it has exited, so the
				// microphone is free when this resolves.
				async cancel() {
					if (capture.settled) return;
					if (capture.state === "idle") {
						settle(capture, { error: fail("cancelled") });
						return;
					}
					const entry = capture.entry;
					if (entry) {
						entry.cancelling = capture;
						retire(entry);
					}
					settle(capture, { error: fail("cancelled") }, entry?.closed ?? retiring);
					if (!entry) { await retiring; return; }
					try {
						entry.child.stdin?.write(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: "cancel" })}\n`);
					} catch {
						/* already gone */
					}
					const timer = setTimeout(() => {
						try {
							entry.child.kill("SIGKILL");
						} catch {
							/* already gone */
						}
					}, VOICE_SESSION_DEFAULTS.exitGraceMs);
					await entry.closed;
					clearTimeout(timer);
				},
			};
	};

	return {
		close,
		needsRecycle: () => Boolean(live?.transcribed),
		recycle,
		session: (sessionOptions) => open(sessionOptions),
		spot({ kws, onStateChange, onKeywordRejected }) {
			const capture = open({ onStateChange: onStateChange ?? (() => {}), kws, spot: true, onKeywordRejected });
			return {
				get state() {
					return capture.state;
				},
				start: () => capture.start(),
				heard: () => capture.result().then((outcome) => outcome.command),
				waitUntilSettled: () => capture.waitUntilSettled(),
				// Before the microphone opened there is nothing to stop: it is cancelled.
				async stop() {
					if (capture.state === "idle" || capture.state === "starting") return capture.cancel();
					await capture.stop().catch(() => {});
				},
				cancel: () => capture.cancel(),
			};
		},
	};
}
