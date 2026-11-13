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

export interface WarmDictation {
	readonly state: VoiceSessionState;
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

// A spot-only capture (S7): the microphone open for the keyword spotter alone.
// It has no transcript and no end of its own; it is `recording` while it listens.
export interface WarmSpotting {
	readonly state: VoiceSessionState;
	// Resolves once the microphone is open.
	start(): Promise<void>;
	// The command that was heard, or undefined when the capture was stopped.
	heard(): Promise<string | undefined>;
	// Closes the microphone and keeps the worker.
	stop(): Promise<void>;
	cancel(): Promise<void>;
}

export interface WarmVoiceWorkerOptions {
	target: VoiceTarget;
	env?: NodeJS.ProcessEnv;
	idleMs?: number;
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
	session(options: { onStateChange(state: VoiceSessionState): void; endpoint?: VoiceEndpoint; levels?: boolean; onLevel?: (rms: number) => void; kws?: VoiceKeywordOption }): WarmDictation;
	// Listens for spoken commands only, on the same worker and its one spotter.
	spot(options: { kws: VoiceKeywordOption; onStateChange?(state: VoiceSessionState): void }): WarmSpotting;
	// Closes the worker, killing it if it has not exited within graceMs.
	close(graceMs?: number): Promise<void>;
}

const fail = (code: VoiceSessionErrorCode) => new VoiceSessionError(code);

interface Live {
	child: VoiceWorkerChild;
	closed: Promise<void>;
	exited: boolean;
}

interface Capture {
	state: VoiceSessionState;
	onStateChange(state: VoiceSessionState): void;
	levels: boolean;
	onLevel?: (rms: number) => void;
	// Asked for keyword spotting; and, when `spot`, for nothing else.
	kws: boolean;
	spot: boolean;
	recording: { resolve(): void; reject(error: unknown): void };
	result: { resolve(transcript: VoiceTranscript): void; reject(error: unknown): void };
	settled: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

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
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const setState = (capture: Capture, state: VoiceSessionState) => {
		if (capture.state === state) return;
		capture.state = state;
		try {
			capture.onStateChange(state);
		} catch {
			/* the observer is advisory */
		}
	};
	const settle = (capture: Capture, outcome: { transcript: VoiceTranscript } | { error: VoiceSessionError }) => {
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
		if (live && !live.exited) armIdle();
	};
	const arm = (capture: Capture, ms: number) => {
		if (capture.timer) clearTimeout(capture.timer);
		capture.timer = unref(setTimeout(() => {
			settle(capture, { error: fail("timeout") });
			kill();
		}, ms));
	};
	const armIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = unref(setTimeout(() => void close(), idleMs));
	};
	const kill = () => {
		try {
			live?.child.kill("SIGKILL");
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
			case "error":
				// The worker ends itself after an error.
				settle(capture, { error: fail(message.code) });
		}
	};
	const protocolError = () => {
		if (current) settle(current, { error: fail("protocol") });
		kill();
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
		const entry: Live = { child, closed: new Promise((resolve) => { resolveClosed = resolve; }), exited: false };
		const decoder = new StringDecoder("utf8");
		let buffered = "";
		child.stdout?.on("data", (chunk: unknown) => {
			buffered += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
			let newline: number;
			while ((newline = buffered.indexOf("\n")) !== -1) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				const message = line.length <= MAX_LINE ? parseWorkerLine(line) : undefined;
				if (message) onMessage(message);
				else protocolError();
			}
			if (buffered.length > MAX_LINE) protocolError();
		});
		// Native libraries may print paths or device names: drained, never shown.
		child.stderr?.on("data", () => {});
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
			if (current) settle(current, { error: fail("worker-exited") });
			resolveClosed();
		});
		return entry;
	};

	const close = async (graceMs: number = WARM_WORKER_DEFAULTS.closeGraceMs): Promise<void> => {
		if (idleTimer) clearTimeout(idleTimer);
		const entry = live;
		if (!entry) return;
		live = undefined;
		if (current) settle(current, { error: fail("cancelled") });
		try {
			entry.child.stdin?.write(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: "close" })}\n`);
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

	// One capture on the worker: a dictation, or with `spot` a capture for the
	// keyword spotter alone. `result` is the outcome without asking it to stop.
	const open = ({ onStateChange, endpoint, levels, onLevel, kws, spot }: { onStateChange(state: VoiceSessionState): void; endpoint?: VoiceEndpoint; levels?: boolean; onLevel?: (rms: number) => void; kws?: VoiceKeywordOption; spot?: boolean }): WarmDictation & { result(): Promise<VoiceTranscript> } => {
			let recording!: Capture["recording"];
			let result!: Capture["result"];
			const recordingPromise = new Promise<void>((resolve, reject) => { recording = { resolve, reject }; });
			const resultPromise = new Promise<VoiceTranscript>((resolve, reject) => { result = { resolve, reject }; });
			recordingPromise.catch(() => {});
			resultPromise.catch(() => {});
			const capture: Capture = { state: "idle", onStateChange, levels: levels === true, onLevel, kws: kws !== undefined, spot: spot === true, recording, result, settled: false };
			return {
				get state() {
					return capture.state;
				},
				result: () => resultPromise,
				async start() {
					if (capture.state !== "idle" || current) throw fail("invalid-state");
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
					if (capture.settled) return recordingPromise;
					live ??= launch(prepared.root);
					arm(capture, VOICE_SESSION_DEFAULTS.startTimeoutMs);
					send({
						...prepared.request,
						numThreads: WARM_WORKER_DEFAULTS.numThreads,
						...(endpoint ? { endpoint: { endOfSpeechMs: endpoint.endOfSpeechMs, noSpeechMs: endpoint.noSpeechMs } } : {}),
						...(levels === true ? { levels: true } : {}),
						...(kws ? { kws } : {}),
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
					const entry = live;
					settle(capture, { error: fail("cancelled") });
					if (!entry) return;
					try {
						entry.child.stdin?.write(`${JSON.stringify({ schema: VOICE_WORKER_SCHEMA, type: "cancel" })}\n`);
					} catch {
						/* already gone */
					}
					if (live === entry) live = undefined;
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
		session: (sessionOptions) => open(sessionOptions),
		spot({ kws, onStateChange }) {
			const capture = open({ onStateChange: onStateChange ?? (() => {}), kws, spot: true });
			return {
				get state() {
					return capture.state;
				},
				start: () => capture.start(),
				heard: () => capture.result().then((outcome) => outcome.command),
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
