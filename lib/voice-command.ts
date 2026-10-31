import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { PARAKEET_MODEL_MANIFEST, VOICE_NOTICES, voiceRuntimeManifest, type VoiceTarget } from "./voice-artifacts.ts";
import { installVoiceModel, installVoiceRuntime, readVoiceStatus, VoiceInstallError, type VoiceComponentStatus, type VoiceInstallErrorCode, type VoiceInstallProgress, type VoiceInstallResult } from "./voice-install.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe, type VoicePlatformDiagnosis, type VoicePlatformProbe } from "./voice-platform.ts";
import { SpaceHoldDetector, type PushToTalkOptions } from "./voice-push-to-talk.ts";
import { createVoiceSession, VoiceSessionError, type VoiceSessionErrorCode, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";
import { createReplyReader, defaultSpeechEngineResolver, lastAssistantText } from "./voice-reply-speech.ts";
import { readVoicePushToTalk, readVoiceSpeechSettings, writeVoicePushToTalk, writeVoiceSpeechSettings, type VoiceSpeechSettings } from "./voice-settings.ts";
import { SpeechEngineError, type SpeechEngine } from "./voice-speech.ts";
import { createVoiceStatePublisher, voiceDisplayState, type VoiceDisplayState, type VoiceStatePublisher } from "./voice-status-event.ts";
import { pushToTalkStatus, voiceReadingStatus, voiceToggleStatus, VoiceDictationView, VoiceProgressView, type VoiceViewTheme } from "./voice-ui.ts";

// /gentle:voice (S1-S3): the only entry point to optional local dictation. It
// shows status, downloads the pinned runtime and model after an explicit
// confirmation, and records one dictation whose transcript is pasted into the
// editor draft, never submitted. Registration does nothing else: the platform
// probe, status reads, downloads and the worker all start from the command, in
// an interactive parent session only. One install or dictation runs at a time.
//
// Push-to-talk (hold Space) is the second way to dictate. When its persisted
// toggle is on, session start arms a raw input listener in an interactive
// parent session; reading the toggle is the only startup work. Whether voice is
// installed is checked at the first hold, and a missing install disarms it.
// A hold shares the single-operation lock with the command.
//
// Toggle dictation is the third way: one shortcut starts listening and the same
// shortcut stops and inserts. It needs no overlay and no key held down, so the
// editor keeps the focus; Esc cancels. It shares the same single-operation lock,
// so the command, a hold and the toggle can never capture at once.
//
// Every way publishes its display state (lib/voice-status-event.ts) for the
// parent shell, keyed by this session's real id. All of the display writers --
// the footer status of a hold and of a toggle, the terminal idle of every run,
// and the session teardown -- go through one guarded pair below, so no code
// path can paint or publish for a run whose session is gone.

export const VOICE_COMMAND_NAME = "gentle:voice";

// Free in Pi's keybindings and in every Gentle shortcut registered today
// (alt+d, the obvious pick, is Pi's deleteWordForward).
export const VOICE_TOGGLE_KEY_DEFAULT = "alt+m";

// GENTLE_PI_VOICE_TOGGLE_KEY overrides the shortcut: unset means the default,
// an empty value or "off" disables it, anything else is used as the key.
export function voiceToggleKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.GENTLE_PI_VOICE_TOGGLE_KEY?.trim();
	if (value === undefined) return VOICE_TOGGLE_KEY_DEFAULT;
	return value === "" || value.toLowerCase() === "off" ? undefined : value;
}

// The part of VoiceSession the command drives.
export interface VoiceDictation {
	readonly state: VoiceSessionState;
	start(): Promise<void>;
	stop(): Promise<VoiceTranscript>;
	cancel(): Promise<void>;
}

export interface VoiceStatusSnapshot {
	voiceHome: string;
	model: VoiceComponentStatus;
	runtime?: VoiceComponentStatus;
}

interface VoiceInstallRequest {
	signal: AbortSignal;
	onProgress(progress: VoiceInstallProgress): void;
}

export interface VoiceCommandDeps {
	env?: NodeJS.ProcessEnv;
	probe?: () => VoicePlatformProbe;
	readStatus?: (target: VoiceTarget) => Promise<VoiceStatusSnapshot>;
	installRuntime?: (options: VoiceInstallRequest & { target: VoiceTarget }) => Promise<VoiceInstallResult>;
	installModel?: (options: VoiceInstallRequest) => Promise<VoiceInstallResult>;
	createSession?: (options: { target: VoiceTarget; onStateChange(state: VoiceSessionState): void }) => VoiceDictation;
	// The persisted push-to-talk toggle.
	settings?: { read(): boolean; write(enabled: boolean): void };
	pushToTalk?: PushToTalkOptions;
	// Spoken replies: the engine (undefined where no voice is reachable) and the
	// persisted on/off switches.
	speechEngine?: () => SpeechEngine | undefined;
	speechSettings?: { read(): VoiceSpeechSettings; write(settings: VoiceSpeechSettings): void };
}

const MB = 1_000_000;
const OVERLAY = { overlay: true, overlayOptions: { anchor: "center", width: "60%", minWidth: 44 } } as const;

const START = "Start dictation";
const STATUS = "Show status and notices";
const DISABLE_PUSH_TO_TALK = "Disable push-to-talk (hold Space)";
const ENABLE_PUSH_TO_TALK = "Enable push-to-talk (hold Space)";
const STATUS_KEY = "gentle-voice";
const READ_ON = "Read replies aloud: turn on";
const READ_OFF = "Read replies aloud: turn off";
const STOP_READING = "Stop reading";
const SPEECH_UNAVAILABLE = "Spoken replies need the Windows voice (Windows or WSL).";

const INSTALL_MESSAGES: Record<VoiceInstallErrorCode, string> = {
	aborted: "Voice download was cancelled. Unfinished files were removed; completed components are kept.",
	timeout: "Voice download timed out. Check the network connection and try again.",
	http: "The download server answered with an error. Try again later.",
	redirect: "The download was redirected to an unexpected location and was refused.",
	size: "A downloaded file did not match its pinned size or digest and was discarded.",
	integrity: "A downloaded file did not match its pinned size or digest and was discarded.",
	archive: "A downloaded runtime package failed validation and was discarded.",
	unsupported: "Voice dictation has no pinned runtime for this platform.",
	io: "Voice files could not be written to the voice directory. Check its permissions and free space.",
};

type DictationStart = "command" | "hold" | "toggle";

// What the user can do about a session failure, by platform where it differs.
// Gentle AI never runs an installer for any of these.
function sessionAction(code: VoiceSessionErrorCode, platform: string, start: DictationStart): string | undefined {
	switch (code) {
		case "not-installed":
		case "runtime-invalid":
		case "model-invalid":
			return "Run /gentle:voice and download it again.";
		case "runtime-load":
			if (platform === "linux") return "Install the ALSA library (libasound.so.2, for example the libasound2 or alsa-lib package), then try again.";
			if (platform === "win32") return "Install the Microsoft Visual C++ Redistributable (x64) from Microsoft, then try again.";
			return "Loading has not been verified on hardware for this target.";
		case "no-input-device":
			return "Connect a microphone or choose a default input device, then try again.";
		case "capture":
			return platform === "darwin"
				? "Allow microphone access for this terminal in System Settings > Privacy & Security > Microphone, then try again."
				: "Check that the default microphone is available, then try again.";
		case "node-version":
			return "Run Gentle AI with Node 22 or newer.";
		case "empty-audio":
		case "no-speech":
			if (start === "hold") return "Keep holding Space until recording starts, then speak.";
			if (start === "toggle") return "Speak after recording starts, then stop it with the same shortcut.";
			return "Speak after recording starts, then press Enter.";
		default:
			return undefined;
	}
}

function sessionErrorMessage(error: unknown, platform: string, start: DictationStart): string {
	if (!(error instanceof VoiceSessionError)) return "Voice dictation failed.";
	const action = sessionAction(error.code, platform, start);
	return action ? `${error.message} ${action}` : error.message;
}

type Outcome = { kind: "text"; transcript: VoiceTranscript } | { kind: "cancelled" } | { kind: "error"; error: unknown };
type Say = (message: string, type: "info" | "warning" | "error") => void;

// Reports a settled dictation. The transcript goes through the editor's paste
// pipeline as is; it is never sent.
function deliver(ctx: ExtensionContext, result: Outcome, platform: string, start: DictationStart, say: Say, afterPaste?: () => void): void {
	if (result.kind === "cancelled") {
		say("Voice dictation cancelled; the draft is unchanged.", "info");
		return;
	}
	if (result.kind === "error") {
		say(sessionErrorMessage(result.error, platform, start), "error");
		return;
	}
	const { text, truncated } = result.transcript;
	if (!text.trim()) {
		say("No speech was recognized.", "warning");
		return;
	}
	ctx.ui.pasteToEditor(text);
	afterPaste?.();
	if (truncated) say("Recording reached the 2-minute limit; the transcript covers what was recorded.", "info");
}

// One dictation session driven to an Outcome. stop() and cancel() settle only
// after the worker has exited; a transcript that lands while cancelling is
// dropped. A release before recording starts waits for recording.
//
// The microphone is claimed at start(), not at creation: creation is inert, and
// start() first waits for the capture that is still closing, so two workers can
// never be alive at once, however long the platform takes to release the device.
function runDictation(createSession: NonNullable<VoiceCommandDeps["createSession"]>, target: VoiceTarget, onState: (state: VoiceSessionState) => void, admission?: () => Promise<void> | undefined) {
	let settled = false;
	let stopping = false;
	let cancelled = false;
	let released = false;
	let cancelPending: Promise<void> | undefined;
	let resolveOutcome!: (outcome: Outcome) => void;
	const outcome = new Promise<Outcome>((resolve) => { resolveOutcome = resolve; });
	const settle = (value: Outcome) => {
		if (settled) return;
		settled = true;
		resolveOutcome(cancelled ? { kind: "cancelled" } : value);
	};
	const collect = () => {
		if (stopping || cancelled || settled) return;
		if (session.state !== "recording" && session.state !== "finished") return;
		stopping = true;
		session.stop().then((transcript) => settle({ kind: "text", transcript }), (error) => settle({ kind: "error", error }));
	};
	// Settles only once the worker has exited, and it is the same promise for
	// every caller, so the next capture can wait on this exact teardown.
	const cancel = (): Promise<void> => {
		if (cancelPending) return cancelPending;
		if (settled) return Promise.resolve();
		cancelled = true;
		cancelPending = session.cancel().catch(() => {}).finally(() => settle({ kind: "cancelled" }));
		return cancelPending;
	};
	// The session calls this synchronously from its own transitions, so it
	// must never throw: a throw there could leave a closing session unsettled.
	const onStateChange = (state: VoiceSessionState) => {
		// A cancelled run discards its recording, so it never reports progress
		// again: the display must not claim it is transcribing on the way out.
		if (cancelled) return;
		try {
			onState(state);
			// The recording limit ends capture without a key press.
			if (state === "finished" || (state === "recording" && released)) queueMicrotask(collect);
		} catch {
			/* the observer is advisory */
		}
	};
	const session = createSession({ target, onStateChange });
	const begin = () => {
		// A run cancelled, stopped or settled while it waited never starts.
		if (cancelled || settled) return;
		session.start().catch((error) => settle({ kind: "error", error }));
	};
	return {
		session,
		outcome,
		start: () => {
			// Claiming the microphone waits for the previous capture's teardown;
			// with none pending the session starts at once.
			const closing = admission?.();
			if (!closing) begin();
			else void closing.then(begin, begin);
		},
		stop: () => { released = true; collect(); },
		cancel,
	};
}

const PREREQUISITE_ACTIONS: Partial<Record<string, string>> = {
	linux: "Gentle AI never installs system libraries; install ALSA with your package manager if loading fails.",
	win32: "Gentle AI never installs the Visual C++ runtime; install it from Microsoft if loading fails.",
};

const runtimeBytes = (target: VoiceTarget) => voiceRuntimeManifest(target).packages.reduce((sum, pkg) => sum + pkg.size, 0);
const modelBytes = () => PARAKEET_MODEL_MANIFEST.files.reduce((sum, file) => sum + file.size, 0);
const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / MB))} MB`;

function noticeLines(): string[] {
	return VOICE_NOTICES.flatMap((notice) => [`- ${notice.attribution ?? `${notice.component}: ${notice.license}.`} Source: ${notice.source}`, ...(notice.unresolved ? [`  ${notice.unresolved}`] : [])]);
}

function limitationLines(diagnosis: VoicePlatformDiagnosis, platform: string): string[] {
	const action = PREREQUISITE_ACTIONS[platform];
	return [...diagnosis.limitations, ...(action ? [action] : [])].map((line) => `- ${line}`);
}

const describe = (status: VoiceComponentStatus | undefined) => (!status ? "unknown" : status.state === "invalid" && status.reason ? `invalid (${status.reason})` : status.state);

function statusReport(target: VoiceTarget, diagnosis: VoicePlatformDiagnosis, status: VoiceStatusSnapshot, platform: string): string {
	return [
		"Voice dictation status",
		`Target: ${target} (${diagnosis.support})`,
		`Voice home: ${status.voiceHome}`,
		`Model: ${describe(status.model)}`,
		`Runtime: ${describe(status.runtime)}`,
		"Limitations:",
		...limitationLines(diagnosis, platform),
		"Licenses and attribution:",
		...noticeLines(),
	].join("\n");
}

interface Overlay<V> {
	view(): V | undefined;
	tui(): TUI | undefined;
	// Closes once, whether or not the factory has run yet; resolves when closed.
	close(): Promise<void>;
}

function openOverlay<V extends Component & { dispose(): void }>(ctx: ExtensionCommandContext, make: (theme: VoiceViewTheme, requestRender: () => void) => V): Overlay<V> {
	let view: V | undefined;
	let tui: TUI | undefined;
	let finish: ((value: undefined) => void) | undefined;
	let closing = false;
	const closed = ctx.ui
		.custom<undefined>((t, theme, _keybindings, done) => {
			tui = t;
			finish = withOverlayRepaint(t, done);
			view = make(theme as VoiceViewTheme, () => t.requestRender());
			if (closing) queueMicrotask(() => finish?.(undefined));
			return view;
		}, OVERLAY)
		.catch(() => undefined)
		.finally(() => view?.dispose());
	return {
		view: () => view,
		tui: () => tui,
		close: () => {
			if (!closing) {
				closing = true;
				view?.dispose();
				finish?.(undefined);
			}
			return closed.then(() => undefined);
		},
	};
}

interface Run {
	generation: number;
	// Cancels the run. A run that owns a capture returns the promise that settles
	// once its worker has exited, and the microphone stays reserved until then.
	abort(): void | Promise<void>;
}

export function registerVoiceCommand(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	const env = deps.env ?? process.env;
	const probe = deps.probe ?? readVoicePlatformProbe;
	const readStatus = deps.readStatus ?? ((target) => readVoiceStatus({ env, target }));
	// Production always installs and runs the pinned manifests: no manifest or
	// fetch override is ever passed from here.
	const installRuntime = deps.installRuntime ?? (({ target, signal, onProgress }) => installVoiceRuntime({ env, target, signal, onProgress }));
	const installModel = deps.installModel ?? (({ signal, onProgress }) => installVoiceModel({ env, signal, onProgress }));
	const createSession = deps.createSession ?? (({ target, onStateChange }) => createVoiceSession({ env, target, onStateChange }));
	const settings = deps.settings ?? { read: () => readVoicePushToTalk({ env }), write: (enabled: boolean) => { writeVoicePushToTalk(enabled, { env }); } };
	// The toggle shortcut is fixed for the session: Pi binds shortcuts once.
	const toggleShortcut = voiceToggleKey(env);
	const toggleKey = toggleShortcut ?? VOICE_TOGGLE_KEY_DEFAULT;
	let generation = 0;
	let active: Run | undefined;

	// --- display: footer status and the session-scoped state event ---------------

	// One publisher per live session. It quotes that session's real id, drops a
	// state its run no longer owns, and is closed when the session is replaced, so
	// a late callback can neither publish nor paint into the next session.
	let statePublisher: VoiceStatePublisher | undefined;
	let statePublisherCtx: ExtensionContext | undefined;
	// The context of the session that owns voice right now; a replacement ends it.
	let sessionCtx: ExtensionContext | undefined;
	const publisherFor = (ctx: ExtensionContext): VoiceStatePublisher => {
		if (statePublisher && statePublisherCtx === ctx) return statePublisher;
		statePublisher?.close();
		statePublisherCtx = ctx;
		statePublisher = createVoiceStatePublisher(pi, ctx);
		return statePublisher;
	};
	const publishVoiceState = (ctx: ExtensionContext | undefined, state: VoiceDisplayState, live?: () => boolean): void => {
		try {
			// A run that no longer owns the display returns before touching it: a
			// stale finally must not replace the live session's publisher, which
			// would drop its duplicate suppression and let it repeat a state.
			if (live && !live()) return;
			(ctx ? publisherFor(ctx) : statePublisher)?.publish(state, live);
		} catch {
			/* the display is advisory */
		}
	};
	const setVoiceFooter = (ctx: ExtensionContext | undefined, live: () => boolean, text: string | undefined): void => {
		if (!ctx || !live()) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			/* the status is display only */
		}
	};

	// --- the microphone slot ----------------------------------------------------

	// One capture at a time. A cancelled capture keeps this slot until its worker
	// has exited, because that is exactly when session.cancel() settles, so the
	// next capture awaits a real teardown instead of assuming the cancel was
	// quick. A run that never reached a worker reserves nothing, so an abandoned
	// menu or a run that only checked the install cannot block voice.
	let captureClosing: Promise<void> | undefined;
	const reserveCapture = (closing: Promise<void> | void): void => {
		if (!closing) return;
		// Reservations compose instead of replacing: a run that never reached a
		// worker settles at once, and that must not free an older capture whose
		// worker is still exiting. The slot clears only when every teardown
		// reserved so far has settled, and an older completion never clears a
		// later combined slot.
		const pending = captureClosing;
		const settled = Promise.resolve(closing).then(() => {}, () => {});
		const slot = (pending ? pending.then(() => settled) : settled).then(() => {
			if (captureClosing === slot) captureClosing = undefined;
		});
		captureClosing = slot;
	};
	const captureSlot = (): Promise<void> | undefined => captureClosing;

	// --- spoken replies -----------------------------------------------------------

	const speechEngine = deps.speechEngine ?? defaultSpeechEngineResolver(env);
	const speechSettings = deps.speechSettings ?? {
		read: () => readVoiceSpeechSettings({ env }),
		write: (next: VoiceSpeechSettings) => { writeVoiceSpeechSettings(next, { env }); },
	};
	const readSpeech = (): VoiceSpeechSettings => {
		try {
			return speechSettings.read();
		} catch {
			return { speakReplies: false, conversation: false };
		}
	};
	const replyReader = createReplyReader({ engine: speechEngine });
	const supportedSession = (ctx: ExtensionContext | undefined): ctx is ExtensionContext => env.GENTLE_PI_AGENTS_CHILD !== "1" && Boolean(ctx?.hasUI) && ctx?.mode === "tui";

	interface Reading {
		ctx: ExtensionContext;
		generation: number;
		controller: AbortController;
		unsubscribe(): void;
	}
	let reading: Reading | undefined;
	// The reply of the run in progress, read once the run has settled.
	let pendingReply: string | undefined;
	// An unreachable voice is reported once per session, not after every reply.
	let unavailableReported = false;

	// Stops the reading in progress, if any: the engine process is killed, the
	// Esc listener goes and the footer clears. Safe to call at any time.
	const stopReading = (): void => {
		const current = reading;
		if (!current) return;
		reading = undefined;
		current.controller.abort();
		try {
			current.unsubscribe();
		} catch {
			/* the input listener is already gone */
		}
		setVoiceFooter(current.ctx, () => current.generation === generation, undefined);
	};

	const readAloud = async (ctx: ExtensionContext, markdown: string): Promise<void> => {
		stopReading();
		const current: Reading = { ctx, generation, controller: new AbortController(), unsubscribe: () => {} };
		reading = current;
		const live = () => reading === current && current.generation === generation;
		current.unsubscribe = ctx.ui.onTerminalInput((data) => {
			try {
				if (reading !== current) return undefined;
				if (!isKeyRelease(data) && matchesKey(data, "escape")) {
					stopReading();
					return { consume: true };
				}
				return undefined;
			} catch {
				return undefined;
			}
		});
		setVoiceFooter(ctx, live, voiceReadingStatus(toggleShortcut));
		try {
			const outcome = await replyReader.read(markdown, current.controller.signal);
			if (outcome === "unavailable" && live() && !unavailableReported) {
				unavailableReported = true;
				ctx.ui.notify(SPEECH_UNAVAILABLE, "warning");
			}
		} catch (error) {
			if (live()) ctx.ui.notify(error instanceof SpeechEngineError ? error.message : "The reply could not be read aloud.", "warning");
		} finally {
			if (reading === current) stopReading();
		}
	};

	const setSpeakReplies = (ctx: ExtensionContext, enabled: boolean, say: Say): void => {
		if (enabled && !speechEngine()) {
			say(SPEECH_UNAVAILABLE, "warning");
			return;
		}
		try {
			speechSettings.write({ ...readSpeech(), speakReplies: enabled });
		} catch {
			say("The spoken-reply setting could not be saved.", "error");
			return;
		}
		if (!enabled) stopReading();
		say(enabled ? "Replies will be read aloud. Esc stops a reading." : "Replies are no longer read aloud.", "info");
	};

	const command = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1") {
			if (ctx.hasUI) ctx.ui.notify("Voice dictation is not available in delegated sessions.", "warning");
			return;
		}
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Voice dictation requires TUI mode.", "warning");
			return;
		}
		if (active) {
			ctx.ui.notify("Voice dictation is already running. Finish or cancel it first.", "warning");
			return;
		}
		const run: Run = { generation, abort: () => {} };
		active = run;
		try {
			await workflow(ctx, run);
		} catch {
			if (run.generation === generation) ctx.ui.notify("Voice dictation failed.", "error");
		} finally {
			if (active === run) active = undefined;
		}
	};

	const workflow = async (ctx: ExtensionCommandContext, run: Run): Promise<void> => {
		// After a session shutdown the old context is stale: say and paste nothing.
		const live = () => run.generation === generation;
		const say = (message: string, type: "info" | "warning" | "error") => {
			if (live()) ctx.ui.notify(message, type);
		};
		const platform = probe();
		const diagnosis = diagnoseVoicePlatform(platform);
		if (diagnosis.support === "unsupported" || !diagnosis.target) {
			say(diagnosis.limitations[0] ?? "Voice dictation is not supported on this platform.", "error");
			return;
		}
		const target = diagnosis.target;
		const status = await readStatus(target);
		if (!live()) return;
		const runtimeMissing = status.runtime?.state !== "installed";
		const modelMissing = status.model.state !== "installed";
		const pending = (runtimeMissing ? runtimeBytes(target) : 0) + (modelMissing ? modelBytes() : 0);
		const download = `Download voice dictation (about ${megabytes(pending)})`;
		const ready = !runtimeMissing && !modelMissing;
		if (ready) installed = { target, platform: platform.platform };
		else if (installed !== "checking") installed = undefined;
		// Enable is offered only once voice is installed; Disable whenever it is on.
		const pushToTalk = readToggle();
		const toggle = pushToTalk ? [DISABLE_PUSH_TO_TALK] : ready ? [ENABLE_PUSH_TO_TALK] : [];
		const speech = [readSpeech().speakReplies ? READ_OFF : READ_ON, ...(reading ? [STOP_READING] : [])];
		const choice = await ctx.ui.select(ready ? "Voice dictation · ready" : "Voice dictation · not installed", ready ? [START, ...toggle, ...speech, STATUS] : [download, ...toggle, ...speech, STATUS]);
		if (!live() || !choice) return;
		if (choice === STATUS) say(statusReport(target, diagnosis, status, platform.platform), "info");
		else if (choice === READ_ON || choice === READ_OFF) setSpeakReplies(ctx, choice === READ_ON, say);
		else if (choice === STOP_READING) stopReading();
		else if (choice === DISABLE_PUSH_TO_TALK || choice === ENABLE_PUSH_TO_TALK) setPushToTalk(ctx, choice === ENABLE_PUSH_TO_TALK, say);
		else if (choice === download) await install(ctx, run, { target, diagnosis, status, platform: platform.platform, runtimeMissing, modelMissing }, say);
		else if (choice === START) await dictate(ctx, run, target, platform.platform, say);
	};

	const install = async (
		ctx: ExtensionCommandContext,
		run: Run,
		plan: { target: VoiceTarget; diagnosis: VoicePlatformDiagnosis; status: VoiceStatusSnapshot; platform: string; runtimeMissing: boolean; modelMissing: boolean },
		say: (message: string, type: "info" | "warning" | "error") => void,
	): Promise<void> => {
		const items = [
			...(plan.runtimeMissing ? [`- Voice runtime for ${plan.target} (sherpa-onnx, node-cpal) from the npm registry: ${megabytes(runtimeBytes(plan.target))}`] : []),
			...(plan.modelMissing ? [`- Parakeet TDT 0.6B v3 int8 model from Hugging Face: ${megabytes(modelBytes())}`] : []),
		];
		const message = [
			`Downloads into ${plan.status.voiceHome}:`,
			...items,
			"Every file is checked against its pinned size and digest. Nothing downloaded is loaded or run during the download.",
			"Licenses and attribution:",
			...noticeLines(),
			"Limitations:",
			...limitationLines(plan.diagnosis, plan.platform),
		].join("\n");
		if (!(await ctx.ui.confirm("Download voice dictation?", message))) {
			say("Voice download skipped; nothing was downloaded.", "info");
			return;
		}
		if (run.generation !== generation) return;
		const controller = new AbortController();
		run.abort = () => controller.abort();
		const overlay = openOverlay(ctx, (theme, requestRender) => new VoiceProgressView({ theme, requestRender, onCancel: () => controller.abort() }));
		const onProgress = (progress: VoiceInstallProgress) => overlay.view()?.update(progress);
		let failure: unknown;
		try {
			if (plan.runtimeMissing) await installRuntime({ target: plan.target, signal: controller.signal, onProgress });
			if (plan.modelMissing && !controller.signal.aborted) await installModel({ signal: controller.signal, onProgress });
		} catch (error) {
			failure = error;
		} finally {
			run.abort = () => {};
			await overlay.close();
		}
		if (controller.signal.aborted) say(INSTALL_MESSAGES.aborted, "info");
		else if (failure !== undefined) say(failure instanceof VoiceInstallError ? INSTALL_MESSAGES[failure.code] : "Voice download failed.", "error");
		else {
			// Push-to-talk is turned on by a successful download (assumption in
			// the task document); the menu turns it off again.
			installed = { target: plan.target, platform: plan.platform };
			let enabled = false;
			try {
				if (run.generation === generation) {
					settings.write(true);
					enabled = true;
					arm(ctx);
				}
			} catch {
				/* push-to-talk stays off; /gentle:voice still dictates */
			}
			say(enabled ? "Voice dictation is installed. Hold Space in the editor to dictate, or run /gentle:voice and choose Start dictation." : "Voice dictation is installed. Run /gentle:voice and choose Start dictation.", "info");
		}
	};

	const dictate = async (ctx: ExtensionCommandContext, run: Run, target: VoiceTarget, platform: string, say: Say): Promise<void> => {
		const live = () => run.generation === generation;
		let overlay: Overlay<VoiceDictationView> | undefined;
		// The command shows an overlay instead of a footer, but it publishes the same
		// session-scoped display state a hold and a toggle publish.
		const dictation = runDictation(createSession, target, (state) => {
			overlay?.view()?.setState(state);
			publishVoiceState(ctx, voiceDisplayState(state), live);
		}, captureSlot);
		const { session } = dictation;
		run.abort = dictation.cancel;
		overlay = openOverlay(ctx, (theme, requestRender) => {
			const view = new VoiceDictationView({ theme, requestRender, onStop: dictation.stop, onCancel: dictation.cancel });
			// The factory may run after the session has already moved on.
			if (session.state !== "idle") view.setState(session.state);
			return view;
		});
		dictation.start();
		const result = await dictation.outcome;
		run.abort = () => {};
		const tui = overlay.tui();
		await overlay.close();
		try {
			// After a session shutdown the old context is stale: say and paste nothing.
			if (!live()) return;
			deliver(ctx, result, platform, "command", say, () => {
				setTimeout(() => {
					try {
						tui?.requestRender();
					} catch {
						/* best-effort repaint after the overlay teardown */
					}
				}, 0);
			});
		} finally {
			// Delivered, empty, cancelled and failed all end idle; a stale run
			// publishes nothing, because its session teardown already cleared it.
			publishVoiceState(ctx, "idle", live);
		}
	};

	// --- push-to-talk (hold Space) ----------------------------------------------

	interface Armed {
		ctx: ExtensionContext;
		detector: SpaceHoldDetector;
		unsubscribe(): void;
		// The dictation a hold started, until it settles.
		hold?: { release(): void; cancel(): void };
	}
	let armed: Armed | undefined;
	// Learned at the first hold, from the command or from the toggle: a target
	// once voice is known to be installed, "checking" while the lazy check runs.
	let installed: { target: VoiceTarget; platform: string } | "checking" | undefined;
	// One check answers every asker. A missing install is not cached, so the
	// next ask checks again once the user has downloaded it.
	let installCheck: Promise<{ target: VoiceTarget; platform: string } | undefined> | undefined;

	const probeInstall = async (): Promise<{ target: VoiceTarget; platform: string } | undefined> => {
		let found: { target: VoiceTarget; platform: string } | undefined;
		try {
			const platform = probe();
			const diagnosis = diagnoseVoicePlatform(platform);
			if (diagnosis.support !== "unsupported" && diagnosis.target) {
				const status = await readStatus(diagnosis.target);
				if (status.runtime?.state === "installed" && status.model.state === "installed") found = { target: diagnosis.target, platform: platform.platform };
			}
		} catch {
			/* an unreadable install counts as not installed */
		}
		return found;
	};

	const resolveInstalled = (): Promise<{ target: VoiceTarget; platform: string } | undefined> => {
		if (installed && installed !== "checking") return Promise.resolve(installed);
		if (installCheck) return installCheck;
		installed = "checking";
		const check = probeInstall().then((found) => {
			installCheck = undefined;
			if (found) installed = found;
			else if (installed === "checking") installed = undefined;
			return found;
		});
		installCheck = check;
		return check;
	};

	const readToggle = (): boolean => {
		try {
			return settings.read();
		} catch {
			return false;
		}
	};

	const disarm = () => {
		const current = armed;
		armed = undefined;
		if (!current) return;
		current.detector.dispose();
		try {
			current.unsubscribe();
		} catch {
			/* the input listener is already gone */
		}
	};

	const arm = (ctx: ExtensionContext) => {
		if (armed) return;
		const current: Armed = {
			ctx,
			detector: new SpaceHoldDetector({ readDraft: () => ctx.ui.getEditorText(), onHold: () => startHold(current), onRelease: () => current.hold?.release() }, deps.pushToTalk),
			unsubscribe: () => {},
		};
		armed = current;
		current.unsubscribe = ctx.ui.onTerminalInput((data) => {
			try {
				if (current.hold && !isKeyRelease(data) && matchesKey(data, "escape")) {
					current.detector.end();
					current.hold.cancel();
					return { consume: true };
				}
				return current.detector.handleInput(data);
			} catch {
				return undefined;
			}
		});
	};

	// The first hold of a session checks the install; its spaces keep typing
	// meanwhile. A missing install disarms push-to-talk until it is re-enabled.
	const checkInstalled = async (current: Armed): Promise<void> => {
		const checkGeneration = generation;
		const found = await resolveInstalled();
		if (checkGeneration !== generation || armed !== current || found) return;
		disarm();
		current.ctx.ui.notify("Push-to-talk is paused: voice dictation is not installed. Run /gentle:voice to download it.", "warning");
	};

	const startHold = (current: Armed): boolean => {
		if (armed !== current || active) return false;
		// While the check runs the spaces keep typing; it settles once, for every
		// hold that asked.
		if (!installed || installed === "checking") {
			void checkInstalled(current);
			return false;
		}
		const run: Run = { generation, abort: () => {} };
		active = run;
		void holdDictation(current, run, installed.target, installed.platform)
			.catch(() => {
				if (run.generation === generation) current.ctx.ui.notify("Voice dictation failed.", "error");
			})
			.finally(() => {
				if (active === run) active = undefined;
			});
		return true;
	};

	// A hold records into the draft with a footer status instead of an overlay,
	// so the editor keeps the focus. Esc cancels; nothing is ever sent.
	const holdDictation = async (current: Armed, run: Run, target: VoiceTarget, platform: string): Promise<void> => {
		const { ctx } = current;
		const live = () => run.generation === generation;
		const say: Say = (message, type) => {
			if (live()) ctx.ui.notify(message, type);
		};
		// The footer status and the display event always move together, so the tab
		// shows exactly what the footer says, and never a stale run's state.
		const status = (state: VoiceSessionState) => {
			if (!live()) return;
			setVoiceFooter(ctx, live, pushToTalkStatus(state));
			publishVoiceState(ctx, voiceDisplayState(state), live);
		};
		const dictation = runDictation(createSession, target, (state) => status(state), captureSlot);
		run.abort = dictation.cancel;
		current.hold = { release: dictation.stop, cancel: dictation.cancel };
		status("starting");
		try {
			dictation.start();
			const result = await dictation.outcome;
			if (live()) deliver(ctx, result, platform, "hold", say);
		} finally {
			run.abort = () => {};
			current.hold = undefined;
			// Cleared and published with the run's own guard: after a session
			// replacement the teardown already cleared this session's display.
			setVoiceFooter(ctx, live, undefined);
			publishVoiceState(ctx, "idle", live);
		}
	};

	const setPushToTalk = (ctx: ExtensionContext, enabled: boolean, say: Say) => {
		try {
			settings.write(enabled);
		} catch {
			say("The push-to-talk setting could not be saved.", "error");
			return;
		}
		if (enabled) {
			arm(ctx);
			say("Push-to-talk is on: hold Space in the editor to dictate, release it to insert the text.", "info");
		} else {
			disarm();
			say("Push-to-talk is off.", "info");
		}
	};

	// --- toggle dictation (one shortcut starts and stops) ------------------------

	interface ToggleRun {
		ctx: ExtensionContext;
		run: Run;
		// Set once the session exists; a press before that is applied to it.
		dictation?: ReturnType<typeof runDictation>;
		// A press while preparing stops as soon as recording can be stopped.
		stopRequested: boolean;
		cancelled: boolean;
		unsubscribe(): void;
	}
	let toggling: ToggleRun | undefined;

	// The toggle's footer status and display event, written only while its run is
	// still the live one and still the session's only toggle.
	const toggleDisplay = (current: ToggleRun) => {
		const live = () => current.run.generation === generation && toggling === current;
		return (state: VoiceSessionState) => {
			if (!live()) return;
			setVoiceFooter(current.ctx, live, voiceToggleStatus(state, toggleKey));
			publishVoiceState(current.ctx, voiceDisplayState(state), live);
		};
	};

	const closeToggle = (current: ToggleRun) => {
		if (toggling !== current) return;
		toggling = undefined;
		if (active === current.run) active = undefined;
		try {
			current.unsubscribe();
		} catch {
			/* the input listener is already gone */
		}
		// A run that settles after its session was replaced publishes nothing: the
		// generation moved and the session teardown already cleared that display.
		const live = () => current.run.generation === generation;
		setVoiceFooter(current.ctx, live, undefined);
		publishVoiceState(current.ctx, "idle", live);
	};

	const stopToggle = (current: ToggleRun) => {
		current.stopRequested = true;
		current.dictation?.stop();
	};

	const cancelToggle = (current: ToggleRun) => {
		if (current.cancelled || toggling !== current) return;
		current.cancelled = true;
		if (!current.dictation) {
			// Still checking the install: nothing was recorded, so end it silently.
			closeToggle(current);
			return;
		}
		current.dictation.cancel();
	};

	const openToggle = (ctx: ExtensionContext): ToggleRun => {
		const current: ToggleRun = { ctx, run: { generation, abort: () => {} }, stopRequested: false, cancelled: false, unsubscribe: () => {} };
		toggling = current;
		active = current.run;
		// Esc has to cancel without reaching the editor's own interrupt.
		current.unsubscribe = ctx.ui.onTerminalInput((data) => {
			try {
				if (toggling !== current) return undefined;
				if (!isKeyRelease(data) && matchesKey(data, "escape")) {
					cancelToggle(current);
					return { consume: true };
				}
				return undefined;
			} catch {
				return undefined;
			}
		});
		return current;
	};

	const runToggle = async (current: ToggleRun): Promise<void> => {
		const { ctx } = current;
		const live = () => current.run.generation === generation && toggling === current;
		const say: Say = (message, type) => {
			if (live()) ctx.ui.notify(message, type);
		};
		const display = toggleDisplay(current);
		try {
			const found = await resolveInstalled();
			if (!live()) return;
			if (!found) {
				say("Voice dictation is not installed. Run /gentle:voice to download it.", "warning");
				return;
			}
			const dictation = runDictation(createSession, found.target, (state) => display(state), captureSlot);
			current.dictation = dictation;
			current.run.abort = dictation.cancel;
			display("starting");
			dictation.start();
			if (current.stopRequested) dictation.stop();
			const result = await dictation.outcome;
			if (!live()) return;
			deliver(ctx, result, found.platform, "toggle", say);
		} finally {
			current.run.abort = () => {};
			closeToggle(current);
		}
	};

	const toggleDictation = async (ctx: ExtensionContext): Promise<void> => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || !ctx?.hasUI || ctx.mode !== "tui") return;
		// Talking over a reading stops it first, then dictation starts as usual.
		stopReading();
		const current = toggling;
		if (current) {
			stopToggle(current);
			return;
		}
		if (active) {
			ctx.ui.notify("Voice dictation is already running. Finish or cancel it first.", "warning");
			return;
		}
		await runToggle(openToggle(ctx));
	};

	// Ends every voice activity one session owned. The generation moves first, so
	// no run of it can publish or paint again even before its capture finishes
	// cancelling; then the footer and the display go idle under that session's own
	// id, and its publisher closes. The next session starts from a clean display.
	const endSession = (ctx: ExtensionContext | undefined): void => {
		stopReading();
		pendingReply = undefined;
		unavailableReported = false;
		generation++;
		const running = active;
		active = undefined;
		// Its capture, if it reached one, keeps the microphone slot until the worker
		// is gone: abort() returns the promise that settles exactly then.
		reserveCapture(running?.abort());
		disarm();
		const current = toggling;
		toggling = undefined;
		if (current) {
			try {
				current.unsubscribe();
			} catch {
				/* the input listener is already gone */
			}
		}
		const target = ctx ?? statePublisherCtx;
		setVoiceFooter(target, () => true, undefined);
		// Nothing was ever published for this session: no display to clear.
		if (statePublisher) publishVoiceState(target, "idle");
		statePublisher?.close();
		statePublisher = undefined;
		statePublisherCtx = undefined;
	};

	pi.registerCommand(VOICE_COMMAND_NAME, {
		description: "Local voice dictation with Parakeet (download it once, then record and insert the transcript into the draft, never sent) and spoken replies read aloud with the Windows voice.",
		handler: async (_args, ctx) => command(ctx),
	});
	if (toggleShortcut) {
		pi.registerShortcut(toggleShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0], {
			description: "Start or stop one voice dictation: the transcript goes into the draft and is never sent.",
			handler: async (ctx) => toggleDictation(ctx),
		});
	}

	pi.on("session_start", (_event, ctx) => {
		// A replacement session starts by ending the one it replaced: the old idle
		// goes out under the old id, then every listener, run and publisher of it is
		// gone, so none of its callbacks can reach this session.
		const previous = sessionCtx;
		sessionCtx = undefined;
		endSession(previous && previous !== ctx ? previous : undefined);
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || !ctx?.hasUI || ctx.mode !== "tui") return;
		sessionCtx = ctx;
		setVoiceFooter(ctx, () => true, undefined);
		// A supported session opens idle for its own id: the tab has a baseline and
		// any footer a replacement left behind is cleared.
		publishVoiceState(ctx, "idle");
		if (readToggle()) arm(ctx);
	});
	// A new run stops the reading and forgets the previous reply; the reply of the
	// last run is read once nothing else will run automatically.
	pi.on("agent_start", () => {
		stopReading();
		pendingReply = undefined;
	});
	pi.on("agent_end", (event) => {
		const text = lastAssistantText(Array.isArray(event?.messages) ? event.messages : []);
		if (text) pendingReply = text;
	});
	pi.on("agent_settled", (event, ctx) => {
		const text = pendingReply;
		pendingReply = undefined;
		if (event?.aborted || !text || !supportedSession(ctx)) return;
		const speech = readSpeech();
		if (!speech.speakReplies && !speech.conversation) return;
		void readAloud(ctx, text);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const previous = sessionCtx;
		sessionCtx = undefined;
		endSession(ctx ?? previous);
	});
}
