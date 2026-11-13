import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type Component, type TUI } from "@earendil-works/pi-tui";
import { withOverlayRepaint } from "./overlay-repaint.ts";
import { PARAKEET_MODEL_MANIFEST, VOICE_NOTICES, voiceRuntimeManifest, type VoiceTarget } from "./voice-artifacts.ts";
import { installVoiceModel, installVoiceRuntime, readVoiceStatus, resolveVoiceHome, VoiceInstallError, type VoiceComponentStatus, type VoiceInstallErrorCode, type VoiceInstallProgress, type VoiceInstallResult } from "./voice-install.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe, type VoicePlatformDiagnosis, type VoicePlatformProbe } from "./voice-platform.ts";
import { SpaceHoldDetector, type PushToTalkOptions } from "./voice-push-to-talk.ts";
import { createVoiceSession, VoiceSessionError, type VoiceEndpoint, type VoiceSessionErrorCode, type VoiceSessionState, type VoiceTranscript } from "./voice-session.ts";
import { installKokoro, installMiro, KOKORO_MANIFESTS, KOKORO_NOTICES, kokoroBytes, MIRO_MANIFEST, MIRO_NOTICE, miroBytes, readKokoroStatus, readMiroStatus, type KokoroStatus } from "./voice-kokoro.ts";
import { createReplyReader, defaultSpeechEngineResolver, lastAssistantText, replyLanguage } from "./voice-reply-speech.ts";
import { createVoiceSpeechPublisher, type VoiceSpeechChunk, type VoiceSpeechReading } from "./voice-speech-events.ts";
import { acquireLocalReadingTurn, paneFocus as herdrPaneFocus, paneFocused as herdrPaneFocused, type PaneFocus } from "./voice-presence.ts";
import { cutListenerReading, createSessionListenerLink, listenerReadingTurn, sessionDisplayLabel, startVoiceListenerProcess, VoiceListenerClient, type ListenerReading, type ListenerSession, type SessionDictation, type SessionListenerLink } from "./voice-listener-client.ts";
import type { ReadingReleaseReason, CaptureMode } from "./voice-listener-protocol.ts";
import { createCuePlayer, type CueName, type CuePlayer, type CueResult } from "./voice-cues.ts";
import { createVoiceLog, type VoiceLog } from "./voice-diagnostics.ts";
import { matchSpokenCommand } from "./voice-spoken-command.ts";
import { createWarmVoiceWorker, type WarmVoiceWorker } from "./voice-warm.ts";
import { readVoicePushToTalk, readVoiceSessions, writeVoicePushToTalk, writeVoiceSessions } from "./voice-settings.ts";
import { SpeechEngineError, speechFailureCode, speechVoiceName, type SpeechEngine } from "./voice-speech.ts";
import { createVoiceStatePublisher, voiceDisplayState, type VoiceDisplayState, type VoiceStatePublisher } from "./voice-status-event.ts";
import { pushToTalkStatus, voiceConversationStatus, voiceReadingStatus, voiceToggleStatus, VoiceDictationView, VoiceProgressView, type VoiceViewTheme } from "./voice-ui.ts";

// /gentle:voice (S1-S3): the only entry point to optional local dictation. It
// shows status, downloads the pinned runtime and model after an explicit
// confirmation, and records one dictation whose transcript is pasted into the
// editor draft, never submitted. Registration does nothing else: the platform
// probe, status reads, downloads and the worker all start from the command, in
// an interactive parent session only. One install or dictation runs at a time.
//
// Push-to-talk (hold Space) is the second way to dictate. When its persisted
// toggle is on, session start arms a raw input listener in an interactive
// parent session. The session also joins the shared voice listener without
// requesting a capture; whether dictation is installed is checked at the first
// hold, and a missing install disarms it.
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
	// Who holds the microphone: the listener from slice C on, or this session when
	// the listener cannot be reached. The owner also plays the microphone cues.
	readonly owner?: "listener" | "session";
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
	createSession?: (options: { target: VoiceTarget; onStateChange(state: VoiceSessionState): void; endpoint?: VoiceEndpoint; warm?: boolean; mode?: CaptureMode }) => VoiceDictation;
	// The persisted push-to-talk toggle.
	settings?: { read(): boolean; write(enabled: boolean): void };
	pushToTalk?: PushToTalkOptions;
	// Spoken replies: the engine (undefined where no voice is reachable), the
	// sessions where voice is on, whether this pane is the focused one, and the
	// reading turn shared by every Pi process (resolves undefined when skipped).
	speechEngine?: () => SpeechEngine | undefined;
	voiceSessions?: { read(): string[]; write(sessions: string[]): void };
	paneFocused?: () => Promise<boolean>;
	// Whether this pane has the focus, with herdr's third answer (S12): a reply is
	// held outside the focused pane, and read where the focus cannot be told.
	paneFocus?: () => Promise<PaneFocus>;
	// How often a held reply asks for the focus, and how long it stays readable.
	// Both have a fixed production value; the tests only shorten them.
	holdPollMs?: number;
	holdStaleMs?: number;
	// The one reading turn: the voice listener arbitrates it across sessions, and a
	// session that cannot reach the listener reads through its own local turn.
	readingTurn?: ReadingTurn;
	// The session's side of the listener (slice C): the microphone lives there, and
	// a session that cannot reach it records itself. Tests inject a link built on a
	// socket they own; production builds one from the voice home.
	listener?: SessionListenerLink;
	// Cuts whatever the listener is reading, wherever it is spoken.
	readCut?: (sessionId: string) => void;
	// Releases the dictation worker kept alive for hands-free recordings.
	releaseWarm?: () => Promise<void>;
	// The microphone cues; one player per process, created on first use.
	cues?: CuePlayer;
	// The voice event log, for diagnosing cut readings and closed microphones.
	log?: VoiceLog;
	// The natural voice (Kokoro): its install status and its consented download.
	kokoro?: { readStatus(): Promise<KokoroStatus>; install(options: VoiceInstallRequest): Promise<void> };
	// The Miro voice (Piper) and its consented download, still offered by
	// /gentle:voice; the robot voices read every spoken reply.
	miro?: { readStatus(): Promise<{ state: string; voiceHome: string }>; install(options: VoiceInstallRequest): Promise<void> };
}

const MB = 1_000_000;
const OVERLAY = { overlay: true, overlayOptions: { anchor: "center", width: "60%", minWidth: 44 } } as const;

const START = "Start dictation";
const STATUS = "Show status and notices";
const DISABLE_PUSH_TO_TALK = "Disable push-to-talk (hold Space)";
const ENABLE_PUSH_TO_TALK = "Enable push-to-talk (hold Space)";
const STATUS_KEY = "gentle-voice";
const VOICE_ON = "Voice in this session (off): turn on";
const VOICE_OFF = "Voice in this session (on): turn off";
const STOP_READING = "Stop reading";
const SPEECH_UNAVAILABLE = "Spoken replies need the Windows voice (Windows or WSL).";
// Conversation mode records hands-free: 2.5 s of quiet after speech ends a
// turn, room to think between sentences, and 8 s without speech pauses the
// conversation.
export const CONVERSATION_ENDPOINT: VoiceEndpoint = { endOfSpeechMs: 2_500, noSpeechMs: 8_000 };

// A dictation that pastes ends by itself too, instead of recording to the
// 120 s limit: the same 2.5 s of quiet after speech ends the capture and
// inserts the transcript, and 8 s without speech gives up and reports that
// nothing was pasted. The values match the conversation's, but the two stay
// separate constants because what happens when nothing is heard differs.
export const DICTATION_ENDPOINT: VoiceEndpoint = { endOfSpeechMs: 2_500, noSpeechMs: 8_000 };

// A reply from a pane without the focus waits for it (S12): one poll of the
// focus while a reply is held, and ten minutes after it settled before it is
// too old to be read. Both are what docs/voice.md documents.
export const HELD_REPLY_POLL_MS = 1_500;
export const HELD_REPLY_STALE_MS = 10 * 60_000;

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

// What the caller adds to a settled dictation: a whole-utterance command may
// consume the transcript instead of pasting it, the text that did reach the
// editor is remembered for the spoken-turn rule (S2), and the command repaints
// its overlay once the paste landed.
interface DeliveryHooks {
	command?(text: string): boolean;
	dictated?(text: string): void;
	afterPaste?(): void;
}

// Reports a settled dictation. The transcript goes through the editor's paste
// pipeline as is; it is never sent.
function deliver(ctx: ExtensionContext, result: Outcome, platform: string, start: DictationStart, say: Say, hooks: DeliveryHooks = {}): void {
	if (result.kind === "cancelled") {
		say("Voice dictation cancelled; the draft is unchanged.", "info");
		return;
	}
	if (result.kind === "error") {
		// The toggle always records with an endpoint, so a recording that hears
		// nothing gives up by itself after a few seconds: that is not a failure, and
		// the notice says what the draft kept. A hold and the command still end by
		// hand and keep their own message.
		const code = result.error instanceof VoiceSessionError ? result.error.code : undefined;
		if (start === "toggle" && (code === "no-speech" || code === "empty-audio")) {
			say("No speech was heard; nothing was pasted.", "info");
			return;
		}
		say(sessionErrorMessage(result.error, platform, start), "error");
		return;
	}
	const { text, truncated } = result.transcript;
	if (!text.trim()) {
		say("No speech was recognized.", "warning");
		return;
	}
	// A whole-utterance command never reaches the editor and never the model.
	if (hooks.command?.(text.trim())) return;
	ctx.ui.pasteToEditor(text);
	hooks.dictated?.(text);
	hooks.afterPaste?.();
	if (truncated) say("Recording reached the 2-minute limit; the transcript covers what was recorded.", "info");
}

// One dictation session driven to an Outcome. stop() and cancel() settle only
// after the worker has exited; a transcript that lands while cancelling is
// dropped. A release before recording starts waits for recording.
//
// The microphone is claimed at start(), not at creation: creation is inert, and
// start() first waits for the capture that is still closing, so two workers can
// never be alive at once, however long the platform takes to release the device.
function runDictation(createSession: NonNullable<VoiceCommandDeps["createSession"]>, target: VoiceTarget, onState: (state: VoiceSessionState) => void, admission?: () => Promise<void> | undefined, options: { endpoint?: VoiceEndpoint; warm?: boolean; mode?: CaptureMode } = {}) {
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
	const session = createSession({ target, onStateChange, endpoint: options.endpoint, warm: options.warm, mode: options.mode });
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

// How a reading ended, as the listener records it: the session's own outcome
// ("skipped" keeps a spoken turn), never its local failure words.
export type ReadingEnd = "done" | "skipped" | "cancelled";

export interface ReadingTurnHooks {
	sessionId?: string;
	chars?: number;
	// The listener took the turn back (a cut, a lost lease): the reading stops.
	onCut?: (reason: ReadingReleaseReason) => void;
}

// Giving the turn back. A turn held through the listener also takes the loudness
// of each chunk the player began, so the listener draws the reading's wave (T13);
// a turn with no listener has no `levels`, and the reading behaves as it did.
export interface ReadingRelease {
	(outcome?: ReadingEnd): void;
	levels?(chunk: VoiceSpeechChunk): void;
}

export type ReadingTurn = (signal: AbortSignal, hooks?: ReadingTurnHooks) => Promise<ReadingRelease | undefined>;

export interface CreateReadingTurnOptions {
	// The voice home, shared by every Pi process of this user.
	dir: string;
	// The listener route and the local fallback; both have production defaults.
	turn?: (options: { dir: string; session: ListenerSession; chars?: number; signal: AbortSignal; onCut?: (reason: ReadingReleaseReason) => void }) => Promise<ListenerReading | undefined>;
	local?: (options: { signal: AbortSignal }) => Promise<(() => void) | undefined>;
	start?: () => void | Promise<void>;
}

// The reading turn a session asks for (S6, slice B): the listener decides who
// reads, and a listener that cannot be reached at all leaves the session exactly
// where it was before the listener existed. A refusal is obeyed, never routed
// around, so two sessions cannot both read through different turns.
export function createReadingTurn(options: CreateReadingTurnOptions): ReadingTurn {
	const turn = options.turn ?? ((request: Parameters<NonNullable<CreateReadingTurnOptions["turn"]>>[0]) => listenerReadingTurn({ ...request, start: options.start }));
	const local = options.local ?? acquireLocalReadingTurn;
	return async (signal, hooks = {}) => {
		if (hooks.sessionId) {
			let answer: ListenerReading | undefined;
			try {
				answer = await turn({ dir: options.dir, session: { sessionId: hooks.sessionId, voiceOn: true }, chars: hooks.chars, signal, onCut: hooks.onCut });
			} catch {
				answer = { kind: "unavailable" };
			}
			if (answer?.kind === "granted") {
				const granted = answer;
				let released = false;
				const release: ReadingRelease = (outcome?: ReadingEnd) => {
					if (released) return;
					released = true;
					granted.release(outcome ?? "done");
				};
				// The listener draws what the reading plays; once the turn is given back
				// there is nothing left to draw on it.
				release.levels = (chunk) => {
					if (!released) granted.levels(chunk);
				};
				return release;
			}
			// A refusal or a cancelled wait is the listener's answer: nothing reads.
			if (!answer || answer.kind !== "unavailable") return undefined;
		}
		return local({ signal });
	};
}

const readingEndFor = (outcome: string | undefined): ReadingEnd => (outcome === "skipped" ? "skipped" : outcome === undefined || outcome === "done" || outcome === "empty" ? "done" : "cancelled");

export function registerVoiceCommand(pi: ExtensionAPI, deps: VoiceCommandDeps = {}): void {
	const env = deps.env ?? process.env;
	const probe = deps.probe ?? readVoicePlatformProbe;
	const readStatus = deps.readStatus ?? ((target) => readVoiceStatus({ env, target }));
	// Production always installs and runs the pinned manifests: no manifest or
	// fetch override is ever passed from here.
	const installRuntime = deps.installRuntime ?? (({ target, signal, onProgress }) => installVoiceRuntime({ env, target, signal, onProgress }));
	const installModel = deps.installModel ?? (({ signal, onProgress }) => installVoiceModel({ env, signal, onProgress }));
	// Hands-free recordings (they carry an endpoint) reuse one kept-alive worker,
	// so the model is verified and loaded once; dictation that pastes keeps its
	// single-use worker.
	let warm: { target: VoiceTarget; worker: WarmVoiceWorker } | undefined;
	const warmFor = (target: VoiceTarget): WarmVoiceWorker => {
		if (warm?.target !== target) {
			void warm?.worker.close();
			warm = { target, worker: createWarmVoiceWorker({ target, env }) };
		}
		return warm.worker;
	};
	// The session's own microphone, kept for the case where no listener answers: the
	// same warm worker for a hands-free recording, the same single-use worker for a
	// dictation. This is what recorded before slice C, unchanged.
	const localDictation = (options: Parameters<NonNullable<VoiceCommandDeps["createSession"]>>[0]): SessionDictation => {
		const session: VoiceDictation = options.warm
			? warmFor(options.target).session({ onStateChange: options.onStateChange, endpoint: options.endpoint })
			: createVoiceSession({ env, target: options.target, onStateChange: options.onStateChange, endpoint: options.endpoint });
		// The session holds the microphone here, so the session plays the cues.
		return { get state() { return session.state; }, owner: "session", start: () => session.start(), stop: () => session.stop(), cancel: () => session.cancel() };
	};
	// The session's side of the listener, built once: it joins the listener, starts
	// one when there is none, and reports this session's pane so the focus can hand
	// a transcript to it.
	let sessionLink: SessionListenerLink | undefined = deps.listener;
	// A voice-off startup connects only to an existing listener: it must never
	// start one and open the spot-only microphone on its own.
	let passiveClient: VoiceListenerClient | undefined;
	const closePassive = () => {
		const client = passiveClient;
		passiveClient = undefined;
		client?.close();
	};
	const receiveVoice = (command: "voice-on" | "voice-off", wake: boolean) => {
		const ctx = sessionCtx;
		if (!ctx) return;
		if (command === "voice-off") {
			if (voiceOn(ctx)) setVoice(ctx, false, (message, type) => ctx.ui.notify(message, type));
			return;
		}
		if (wake) wakeConversation(ctx);
	};
	const listener = (): SessionListenerLink => {
		if (sessionLink) return sessionLink;
		const link = createSessionListenerLink({
			dir: resolveVoiceHome(env),
			start: () => startVoiceListenerProcess(env),
			session: () => {
				const id = sessionIdOf(sessionCtx);
				return id ? { sessionId: id, paneId: paneIdOf(), label: labelOf(sessionCtx), voiceOn: voiceOn(sessionCtx) } : undefined;
			},
			onTranscript: (text, truncated) => {
				if (sessionLink === link) receiveTranscript(text, truncated);
			},
			onVoice: (command, wake) => {
				// An in-flight old hello can receive a frame after its session ended.
				if (sessionLink === link) receiveVoice(command, wake);
			},
		});
		sessionLink = link;
		return link;
	};
	const createSession: NonNullable<VoiceCommandDeps["createSession"]> = deps.createSession ?? ((options) => {
		// Dictation supersedes an off-session's passive connection with its normal
		// session link; never leave two session-role connections replacing each other.
		closePassive();
		return listener().dictate({
			// A recording with an endpoint is the hands-free conversation; the listener
			// uses the mode for its own request to the worker and for its log.
			mode: options.mode ?? (options.endpoint ? "conversation" : "dictation"),
			endpoint: options.endpoint,
			onStateChange: options.onStateChange,
			fallback: () => localDictation(options),
		});
	});
	const voiceLog: VoiceLog = deps.log ?? createVoiceLog({ dir: resolveVoiceHome(env) });
	let cuePlayer = deps.cues;
	let cuesUsed = false;
	const cues = (): CuePlayer => {
		cuesUsed = true;
		return (cuePlayer ??= createCuePlayer({ env }));
	};
	const releaseWarm = deps.releaseWarm ?? (async () => {
		const current = warm;
		warm = undefined;
		await current?.worker.close();
	});
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
	const voiceSessions = deps.voiceSessions ?? {
		read: () => readVoiceSessions({ env }),
		write: (next: string[]) => { writeVoiceSessions(next, { env }); },
	};
	const paneFocused = deps.paneFocused ?? (() => herdrPaneFocused({ env }));
	const paneFocus = deps.paneFocus ?? (() => herdrPaneFocus({ env }));
	const readingTurn = deps.readingTurn ?? createReadingTurn({ dir: resolveVoiceHome(env), start: () => startVoiceListenerProcess(env) });
	const readCut = deps.readCut ?? ((sessionId: string) => {
		void cutListenerReading({ dir: resolveVoiceHome(env), session: { sessionId, voiceOn: false } }).catch(() => {});
	});
	const sessionIdOf = (ctx: ExtensionContext | undefined): string | undefined => {
		try {
			const id = ctx?.sessionManager?.getSessionId?.();
			return typeof id === "string" && id.trim() ? id : undefined;
		} catch {
			return undefined;
		}
	};
	// The pane herdr names for this process, which is what the focus lookup matches
	// a transcript against. Outside herdr nothing is set and the single session
	// still counts as focused, exactly as lib/voice-presence.ts reads it.
	const paneIdOf = (): string | undefined => env.HERDR_PANE_ID?.trim() || undefined;
	// The label a window shows for this session (S5): the name Pi keeps for it, or
	// the directory it runs in, shortened and stripped by the protocol's own rule.
	// Display only: nothing routes a transcript by it.
	const labelOf = (ctx: ExtensionContext | undefined): string | undefined => {
		try {
			const manager = ctx?.sessionManager;
			return sessionDisplayLabel({ name: manager?.getSessionName?.(), cwd: manager?.getCwd?.() });
		} catch {
			return undefined;
		}
	};
	// A transcript another session recorded, handed here because this pane had the
	// focus when the recording ended (S6). It is pasted into this session's draft
	// and never sent; a session with voice off, or no live session, drops it.
	const receiveTranscript = (text: string, truncated: boolean): void => {
		const ctx = sessionCtx;
		if (!ctx || !supportedSession(ctx) || !voiceOn(ctx) || !text.trim()) {
			voiceLog("transcript.received", { session: sessionIdOf(ctx), pasted: false });
			return;
		}
		try {
			ctx.ui.pasteToEditor(text);
		} catch {
			voiceLog("transcript.received", { session: sessionIdOf(ctx), pasted: false });
			return;
		}
		// It is a dictated draft like any other: sending it later is a spoken turn.
		recordDictation(text);
		voiceLog("transcript.received", { session: sessionIdOf(ctx), pasted: true, chars: text.length, truncated });
	};
	// Plays one microphone cue and records what became of it: a cue the Pulse
	// player never confirmed used to disappear without a trace. The cue stays
	// advisory, so a player that throws or answers with nothing never breaks the
	// microphone state that asked for it.
	// When the last reading ended, for the cue event: it tells a cue that played
	// over the reply's tail from one that played in the clear.
	let lastReadingEndedAt: number | undefined;
	const cue = (ctx: ExtensionContext | undefined, name: CueName, mode: "conversation" | "dictation"): void => {
		// The mode and the distance to the last reading are logged with the cue so a
		// reported difference between the two modes can be traced from the log: the
		// tones, the player and this call are the same for both.
		const sinceReadingMs = lastReadingEndedAt === undefined ? undefined : Date.now() - lastReadingEndedAt;
		let playing: Promise<CueResult | undefined>;
		try {
			playing = Promise.resolve(cues().play(name));
		} catch {
			return;
		}
		void playing
			.then((result) => {
				if (!result) return;
				voiceLog("cue", { session: sessionIdOf(ctx), name: result.name, outcome: result.outcome, ms: result.ms, mode, ...(sinceReadingMs === undefined ? {} : { sinceReadingMs }) });
			})
			.catch(() => {});
	};
	// Voice is on per Pi session: replies are read there and the shortcut starts
	// a hands-free conversation. Read fresh each time, so a change made in
	// another process applies at once.
	const voiceOn = (ctx: ExtensionContext | undefined): boolean => {
		const id = sessionIdOf(ctx);
		if (!id) return false;
		try {
			return voiceSessions.read().includes(id);
		} catch {
			return false;
		}
	};
	// Set when a transcript is sent by voice; the reply to that turn may reopen
	// the microphone, and no other reply does.
	let spokenTurnPending = false;
	// The last transcript a dictation inserted into the editor (S2). A message the
	// owner submits while it is still in it came from a dictation, so it is a
	// spoken turn even though Pi reports interactive input.
	let lastDictated: string | undefined;
	const replyReader = createReplyReader({ engine: speechEngine });
	// Every reading reports itself on the event bus, so a consumer outside this
	// command can follow the voice: one start, one chunk per chunk the player
	// begins, one end. The payload carries no reply text.
	const speechEvents = createVoiceSpeechPublisher(pi.events);
	const miro = deps.miro ?? {
		readStatus: () => readMiroStatus({ env }),
		install: ({ signal, onProgress }: VoiceInstallRequest) => installMiro({ env, signal, onProgress }),
	};
	const kokoro = deps.kokoro ?? {
		readStatus: () => readKokoroStatus({ env }),
		install: ({ signal, onProgress }: VoiceInstallRequest) => installKokoro({ env, signal, onProgress }),
	};
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

	// A reply that settles while another is read waits here; only the newest
	// waits, so a burst of background replies cannot pile up.
	let queuedReply: { ctx: ExtensionContext; text: string } | undefined;
	// A reply that settles while the owner looks at another pane is held instead
	// of read (S12): reading waits for that pane, so no session talks over the one
	// in front. Only the newest held reply is kept, with the time it settled, so a
	// burst of replies cannot pile up either.
	interface HeldReply {
		ctx: ExtensionContext;
		text: string;
		session: string | undefined;
		settledAt: number;
	}
	const holdPollMs = deps.holdPollMs ?? HELD_REPLY_POLL_MS;
	const holdStaleMs = deps.holdStaleMs ?? HELD_REPLY_STALE_MS;
	let heldReply: HeldReply | undefined;
	let heldTimer: NodeJS.Timeout | undefined;
	// Set while one focus question is in flight, so a slow herdr never stacks
	// lookups on top of each other.
	let heldAsking = false;
	// Drops the held reply and stops its poll. The text stays where it already is
	// on screen; nothing reads it later.
	const clearHeld = (): void => {
		heldReply = undefined;
		if (!heldTimer) return;
		clearTimeout(heldTimer);
		heldTimer = undefined;
	};
	// One poll at a time, and only while something is held. The timer is unref'd,
	// so a held reply never keeps a process alive on its own.
	const scheduleHeldPoll = (): void => {
		if (heldTimer || heldAsking || !heldReply) return;
		heldTimer = setTimeout(() => {
			heldTimer = undefined;
			void pollHeld();
		}, holdPollMs);
		heldTimer.unref?.();
	};
	const pollHeld = async (): Promise<void> => {
		const held = heldReply;
		if (!held) return;
		// Voice turned off, in this process or another one: nothing is read here.
		if (!voiceOn(held.ctx)) {
			clearHeld();
			return;
		}
		// Too old to be worth hearing: the reply stays on screen, unread.
		if (Date.now() - held.settledAt >= holdStaleMs) {
			clearHeld();
			voiceLog("reading.dropped", { session: held.session, reason: "stale" });
			return;
		}
		heldAsking = true;
		let focus: PaneFocus;
		try {
			focus = await paneFocus();
		} catch {
			focus = "unknown";
		} finally {
			heldAsking = false;
		}
		// Replaced, dropped or ended while herdr answered: the newer state wins,
		// never a read of the reply it replaced. A reply held meanwhile keeps its
		// own poll, which this one could not schedule while it was asking.
		if (heldReply !== held) {
			scheduleHeldPoll();
			return;
		}
		if (focus === "unfocused") {
			scheduleHeldPoll();
			return;
		}
		clearHeld();
		startReply(held.ctx, held.text);
	};
	const holdReply = (ctx: ExtensionContext, text: string): void => {
		const held: HeldReply = { ctx, text, session: sessionIdOf(ctx), settledAt: Date.now() };
		heldReply = held;
		voiceLog("reading.held", { session: held.session, chars: text.length });
		scheduleHeldPoll();
	};
	// Stops the reading and drops the reply waiting behind it: for the user's
	// own Esc, message, shortcut, Stop reading, voice off and session end. A held
	// reply goes with them (S12): the owner moved on, or nothing is left to read.
	const cutReadings = (): void => {
		queuedReply = undefined;
		clearHeld();
		stopReading();
	};
	// Set while this extension sends a spoken transcript, so its input event is
	// recognized as the user's own turn.
	let voiceSendPending = false;

	// "skipped" is the user's Esc: the reading stops, and a spoken turn goes on
	// to the microphone as if it had been heard to the end.
	type ReadingOutcome = "done" | "skipped" | "cancelled" | "empty" | "unavailable" | "error";
	const readAloud = async (ctx: ExtensionContext, markdown: string): Promise<ReadingOutcome> => {
		stopReading();
		const current: Reading = { ctx, generation, controller: new AbortController(), unsubscribe: () => {} };
		reading = current;
		let skipped = false;
		const live = () => reading === current && current.generation === generation;
		current.unsubscribe = ctx.ui.onTerminalInput((data) => {
			try {
				if (reading !== current) return undefined;
				if (!isKeyRelease(data) && matchesKey(data, "escape")) {
					// Skipping a reading keeps the spoken turn: the microphone reopens so
					// the user can answer what they already heard. alt+m is the way to
					// close it.
					skipped = true;
					cutReadings();
					return { consume: true };
				}
				return undefined;
			} catch {
				return undefined;
			}
		});
		setVoiceFooter(ctx, live, "Waiting to read · esc skip");
		let release: ReadingRelease | undefined;
		let ended: ReadingOutcome | undefined;
		let started: VoiceSpeechReading | undefined;
		// The voice that speaks this reading, as the log and the event report it.
		let voice: string | undefined;
		try {
			// One reading at a time across every Pi process: wait for the turn. The
			// listener hands it to one session, and tells that session when it takes
			// it back, so a cut or a lost lease stops the speech here.
			release = await readingTurn(current.controller.signal, {
				sessionId: sessionIdOf(ctx),
				chars: markdown.length,
				onCut: () => cutReadings(),
			});
			// Voice may have been turned off, in any Pi process, while this waited.
			if (!release || !live() || !voiceOn(ctx)) return skipped ? "skipped" : "cancelled";
			setVoiceFooter(ctx, live, voiceReadingStatus(toggleShortcut));
			// The start is published before the engine is asked to speak, so a
			// consumer knows the voice is live before the first chunk arrives. Both
			// the event and the log name the voice that speaks, not the chain.
			const engine = speechEngine();
			const language = replyLanguage(markdown);
			voice = engine ? speechVoiceName(engine, language) : undefined;
			started = engine ? speechEvents.begin(voice ?? engine.id) : undefined;
			voiceLog("reading.start", { session: sessionIdOf(ctx), chars: markdown.length, language, voice });
			const read = await replyReader.read(markdown, current.controller.signal, {
				// The event bus first, unchanged, so outside consumers see exactly what
				// they saw before; then the same chunk to the listener's overlay wave.
				chunk: (chunk) => {
					started?.chunk(chunk);
					release?.levels?.(chunk);
				},
				// Why the reply was read again by the same voice (S4).
				retry: ({ attempt, failure }) => voiceLog("reading.retry", { session: sessionIdOf(ctx), voice, attempt, failure }),
			});
			const outcome: ReadingOutcome = read === "cancelled" && skipped ? "skipped" : read;
			ended = outcome;
			voiceLog("reading.end", { session: sessionIdOf(ctx), outcome, voice });
			started?.end(outcome);
			lastReadingEndedAt = Date.now();
			if (outcome === "unavailable" && live() && !unavailableReported) {
				unavailableReported = true;
				ctx.ui.notify(SPEECH_UNAVAILABLE, "warning");
			}
			return outcome;
		} catch (error) {
			ended = "error";
			voiceLog("reading.end", { session: sessionIdOf(ctx), outcome: "error", voice, failure: speechFailureCode(error) });
			started?.end("error");
			lastReadingEndedAt = Date.now();
			if (live()) ctx.ui.notify(error instanceof SpeechEngineError ? error.message : "The reply could not be read aloud.", "warning");
			return "error";
		} finally {
			// A reading that ended by any path still pairs its start with one end.
			started?.end("error");
			release?.(readingEndFor(ended));
			if (reading === current) stopReading();
		}
	};

	const setVoice = (ctx: ExtensionContext, enabled: boolean, say: Say): void => {
		const id = sessionIdOf(ctx);
		if (!id) {
			say("Voice needs a saved session; this one has no id.", "warning");
			return;
		}
		if (enabled && !speechEngine()) {
			say(SPEECH_UNAVAILABLE, "warning");
			return;
		}
		try {
			const others = voiceSessions.read().filter((session) => session !== id);
			voiceSessions.write(enabled ? [...others, id] : others);
		} catch {
			say("The voice setting could not be saved.", "error");
			return;
		}
		// The listener's registration follows this session's persisted voice. An
		// off session never starts a listener; an on session may join/start one.
		const liveCtx = sessionCtx;
		if (!deps.createSession && liveCtx && sessionIdOf(liveCtx) === id) {
			if (passiveClient?.connected) {
				passiveClient.updateVoice(enabled);
			} else if (sessionLink) {
				closePassive();
				sessionLink.updateVoice?.(enabled);
				if (enabled) joinAtStart(liveCtx);
			} else if (enabled) {
				closePassive();
				joinAtStart(liveCtx);
			} else {
				passiveClient?.updateVoice(false);
			}
		}
		if (!enabled) {
			cutReadings();
			// Another session may be the one speaking: the listener tells it to stop.
			readCut(id);
			spokenTurnPending = false;
			void releaseWarm().catch(() => {});
			say("Voice is off in this session.", "info");
			return;
		}
		cues().warm();
		const start = toggleShortcut ? `${toggleShortcut} starts a hands-free conversation` : "the reply starts a hands-free conversation";
		say(`Voice is on in this session: replies are read aloud, and ${start}. Esc skips a reading.`, "info");
	};

	// A whole-utterance command (S4, S10) runs the same action the menu runs and is
	// never sent, pasted or written to the log: only its name is recorded. The
	// matcher's fixed list decides what is a command; anything else is text.
	const runSpokenCommand = (ctx: ExtensionContext, text: string, say: Say): boolean => {
		const name = matchSpokenCommand(text);
		if (!name) return false;
		voiceLog("voice.command", { session: sessionIdOf(ctx), name });
		if (name === "voice-off") setVoice(ctx, false, say);
		return true;
	};

	// The transcript a dictation inserted into the editor, so a message the owner
	// sends while it is still there counts as a spoken turn (S2).
	const recordDictation = (text: string): void => {
		const inserted = text.trim();
		if (inserted) lastDictated = inserted;
	};
	// A dictation answers for one turn: once a submitted message contained it, the
	// next typed message is typed again. Editing it away makes the turn typed.
	const takeDictated = (submitted: string | undefined): boolean => {
		const inserted = lastDictated;
		if (!inserted) return false;
		if (!submitted || !submitted.trim().includes(inserted)) return false;
		lastDictated = undefined;
		return true;
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
		// The natural voice runs on the dictation runtime, so it is offered once that is installed.
		const kokoroStatus = runtimeMissing ? undefined : await kokoro.readStatus().catch(() => undefined);
		if (!live()) return;
		const naturalDownload = `Download natural voice (Kokoro, about ${megabytes(kokoroBytes())})`;
		const natural = kokoroStatus && kokoroStatus.state !== "installed" ? [naturalDownload] : [];
		const miroStatus = runtimeMissing ? undefined : await miro.readStatus().catch(() => undefined);
		if (!live()) return;
		const miroDownload = `Download Miro voice (Piper, about ${megabytes(miroBytes())})`;
		if (miroStatus && miroStatus.state !== "installed") natural.unshift(miroDownload);
		const speech = [voiceOn(ctx) ? VOICE_OFF : VOICE_ON, ...(reading ? [STOP_READING] : [])];
		const choice = await ctx.ui.select(ready ? "Voice dictation · ready" : "Voice dictation · not installed", ready ? [START, ...toggle, ...speech, ...natural, STATUS] : [download, ...toggle, ...speech, ...natural, STATUS]);
		if (!live() || !choice) return;
		if (choice === STATUS) say(statusReport(target, diagnosis, status, platform.platform), "info");
		else if (choice === VOICE_ON || choice === VOICE_OFF) setVoice(ctx, choice === VOICE_ON, say);
		else if (choice === STOP_READING) {
			spokenTurnPending = false;
			cutReadings();
		}
		else if (choice === naturalDownload) await installNatural(ctx, run, status.voiceHome, say);
		else if (choice === miroDownload) await installMiroVoice(ctx, run, status.voiceHome, say);
		else if (choice === DISABLE_PUSH_TO_TALK || choice === ENABLE_PUSH_TO_TALK) setPushToTalk(ctx, choice === ENABLE_PUSH_TO_TALK, say);
		else if (choice === download) await install(ctx, run, { target, diagnosis, status, platform: platform.platform, runtimeMissing, modelMissing }, say);
		else if (choice === START) await dictate(ctx, run, target, platform.platform, say);
	};

	const installMiroVoice = async (ctx: ExtensionCommandContext, run: Run, voiceHome: string, say: Say): Promise<void> => {
		const message = [
			`Downloads into ${voiceHome}:`,
			`- Piper voice Miro, Spanish from Spain (${MIRO_MANIFEST.files.map((file) => file.name).join(", ")}), and the Spanish and English phoneme data when missing: about ${megabytes(miroBytes())}`,
			"Every file is checked against its pinned size and digest. Nothing downloaded is loaded or run during the download.",
			"License:",
			`- ${MIRO_NOTICE.attribution} Source: ${MIRO_NOTICE.source}`,
			"- The phoneme data is espeak-ng-data, licensed under GPL-3.0-or-later.",
		].join("\n");
		if (!(await ctx.ui.confirm("Download the Miro voice?", message))) {
			say("Miro voice download skipped; nothing was downloaded.", "info");
			return;
		}
		if (run.generation !== generation) return;
		const controller = new AbortController();
		run.abort = () => controller.abort();
		const overlay = openOverlay(ctx, (theme, requestRender) => new VoiceProgressView({ theme, requestRender, onCancel: () => controller.abort() }));
		let failure: unknown;
		try {
			await miro.install({ signal: controller.signal, onProgress: (progress) => overlay.view()?.update(progress) });
		} catch (error) {
			failure = error;
		} finally {
			run.abort = () => {};
			await overlay.close();
		}
		if (controller.signal.aborted) say("Miro voice download was cancelled. Unfinished files were removed; completed parts are kept.", "info");
		else if (failure !== undefined) say(failure instanceof VoiceInstallError ? INSTALL_MESSAGES[failure.code] : "Miro voice download failed.", "error");
		else say("The Miro voice is installed. Spoken replies keep using the robot voices.", "info");
	};

	const installNatural = async (ctx: ExtensionCommandContext, run: Run, voiceHome: string, say: Say): Promise<void> => {
		const { core, espeak, espeakRomance, espeakGermanic } = KOKORO_MANIFESTS;
		const bytes = (files: readonly { size: number }[]) => files.reduce((sum, file) => sum + file.size, 0);
		const phonemes = bytes(espeak.files) + bytes(espeakRomance.files) + bytes(espeakGermanic.files);
		const message = [
			`Downloads into ${voiceHome}:`,
			`- Kokoro v1.0 multi-language model from Hugging Face (${core.files.map((file) => file.name).join(", ")}): ${megabytes(bytes(core.files))}`,
			`- espeak-ng-data phoneme files for Spanish and English: ${megabytes(phonemes)}`,
			`About ${megabytes(kokoroBytes())} in total. It runs on the voice runtime dictation already installed.`,
			"Every file is checked against its pinned size and digest. Nothing downloaded is loaded or run during the download.",
			"Licenses and attribution:",
			...KOKORO_NOTICES.map((notice) => `- ${notice.attribution ?? `${notice.component}: ${notice.license}.`} Source: ${notice.source}`),
		].join("\n");
		if (!(await ctx.ui.confirm("Download the natural voice?", message))) {
			say("Natural voice download skipped; nothing was downloaded.", "info");
			return;
		}
		if (run.generation !== generation) return;
		const controller = new AbortController();
		run.abort = () => controller.abort();
		const overlay = openOverlay(ctx, (theme, requestRender) => new VoiceProgressView({ theme, requestRender, onCancel: () => controller.abort() }));
		let failure: unknown;
		try {
			await kokoro.install({ signal: controller.signal, onProgress: (progress) => overlay.view()?.update(progress) });
		} catch (error) {
			failure = error;
		} finally {
			run.abort = () => {};
			await overlay.close();
		}
		if (controller.signal.aborted) say("Natural voice download was cancelled. Unfinished files were removed; completed parts are kept.", "info");
		else if (failure !== undefined) say(failure instanceof VoiceInstallError ? INSTALL_MESSAGES[failure.code] : "Natural voice download failed.", "error");
		else say("The natural voice is installed. Spoken replies keep using the robot voices.", "info");
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
			deliver(ctx, result, platform, "command", say, {
				command: (text) => runSpokenCommand(ctx, text, say),
				dictated: recordDictation,
				afterPaste: () => {
					setTimeout(() => {
						try {
							tui?.requestRender();
						} catch {
							/* best-effort repaint after the overlay teardown */
						}
					}, 0);
				},
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
			if (live()) deliver(ctx, result, platform, "hold", say, { command: (text) => runSpokenCommand(ctx, text, say), dictated: recordDictation });
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
		// Conversation mode: hands-free recording, and the transcript is sent.
		send: boolean;
		// The microphone cue already played for this capture.
		cue: "none" | "open" | "closed";
		cancelled: boolean;
		unsubscribe(): void;
	}
	let toggling: ToggleRun | undefined;

	// The toggle's footer status and display event, written only while its run is
	// still the live one and still the session's only toggle.
	const toggleDisplay = (current: ToggleRun) => {
		const live = () => current.run.generation === generation && toggling === current;
		// The microphone cues belong to whoever holds the microphone: the listener
		// plays them from slice C on, and this session only plays them when it
		// recorded itself (no listener was reachable).
		const local = () => current.dictation?.session.owner !== "listener";
		return (state: VoiceSessionState) => {
			if (!live()) return;
			// Rising when the microphone really records, falling when it stops.
			if (state === "recording" && current.cue === "none") {
				current.cue = "open";
				if (local()) cue(current.ctx, "open", current.send ? "conversation" : "dictation");
			} else if (state !== "recording" && current.cue === "open") {
				current.cue = "closed";
				if (local()) cue(current.ctx, "close", current.send ? "conversation" : "dictation");
			}
			setVoiceFooter(current.ctx, live, current.send ? voiceConversationStatus(state, toggleKey) : voiceToggleStatus(state, toggleKey));
			publishVoiceState(current.ctx, voiceDisplayState(state), live);
		};
	};

	const closeToggle = (current: ToggleRun) => {
		if (toggling !== current) return;
		// A capture cancelled while recording reports no more states.
		if (current.cue === "open") {
			current.cue = "closed";
			if (current.dictation?.session.owner !== "listener") cue(current.ctx, "close", current.send ? "conversation" : "dictation");
		}
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

	const openToggle = (ctx: ExtensionContext, send: boolean): ToggleRun => {
		const current: ToggleRun = { ctx, run: { generation, abort: () => {} }, stopRequested: false, send, cue: "none", cancelled: false, unsubscribe: () => {} };
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
			const dictation = runDictation(createSession, found.target, (state) => display(state), captureSlot, { endpoint: current.send ? CONVERSATION_ENDPOINT : DICTATION_ENDPOINT, warm: current.send, mode: current.send ? "conversation" : "dictation" });
			current.dictation = dictation;
			current.run.abort = dictation.cancel;
			display("starting");
			dictation.start();
			if (current.stopRequested) dictation.stop();
			const result = await dictation.outcome;
			if (!live()) return;
			if (current.send) sendToAgent(ctx, result, found.platform, say, current.stopRequested);
			else deliver(ctx, result, found.platform, "toggle", say, { command: (text) => runSpokenCommand(ctx, text, say), dictated: recordDictation });
		} finally {
			current.run.abort = () => {};
			closeToggle(current);
		}
	};

	const toggleDictation = async (ctx: ExtensionContext): Promise<void> => {
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || !ctx?.hasUI || ctx.mode !== "tui") return;
		// Talking over a reading stops it first, then dictation starts as usual.
		cutReadings();
		const current = toggling;
		if (current) {
			stopToggle(current);
			return;
		}
		if (active) {
			ctx.ui.notify("Voice dictation is already running. Finish or cancel it first.", "warning");
			return;
		}
		await runToggle(openToggle(ctx, voiceOn(ctx)));
	};

	// Conversation mode: the transcript is the next prompt. A busy agent gets it
	// as a follow-up instead of interrupting its run.
	// A stop the speaker asked for with the shortcut is a pause, even when nothing
	// was said yet: the microphone reopens by itself after a reply.
	const sendToAgent = (ctx: ExtensionContext, result: Outcome, platform: string, say: Say, stoppedByKey = false): void => {
		const paused = `Conversation paused. Press ${toggleKey} to talk.`;
		const unheard = `Conversation paused: no speech was heard. Press ${toggleKey} to talk.`;
		if (result.kind === "cancelled") {
			say(paused, "info");
			return;
		}
		if (result.kind === "error") {
			const code = result.error instanceof VoiceSessionError ? result.error.code : undefined;
			if (code === "no-speech" || code === "empty-audio") say(stoppedByKey ? paused : unheard, "info");
			else say(sessionErrorMessage(result.error, platform, "toggle"), "error");
			return;
		}
		const text = result.transcript.text.trim();
		if (!text) {
			say(unheard, "info");
			return;
		}
		// A whole-utterance command is never sent to the model: it runs the action
		// the menu runs and the draft stays as it is.
		if (runSpokenCommand(ctx, text, say)) return;
		// Whatever is in the draft goes with the transcript: a pasted image is a
		// file path in the draft, so it travels exactly as a typed submit would
		// send it. The draft is cleared only once it was sent.
		let draft = "";
		try {
			draft = ctx.ui.getEditorText().trim();
		} catch {
			/* no readable draft: send the transcript alone */
		}
		const message = draft ? `${draft}\n\n${text}` : text;
		spokenTurnPending = true;
		const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
		voiceSendPending = true;
		voiceLog("turn.sent", { session: sessionIdOf(ctx), chars: message.length, idle, draft: draft.length > 0 });
		if (idle) pi.sendUserMessage(message);
		else pi.sendUserMessage(message, { deliverAs: "followUp" });
		if (draft) {
			try {
				ctx.ui.setEditorText("");
			} catch {
				/* the message was sent; a stale draft is harmless */
			}
		}
	};

	// Reopens the microphone after a reply in conversation mode, unless voice is
	// already busy with another capture.
	const listenForReply = (ctx: ExtensionContext): void => {
		const busy = toggling ? "dictation-running" : active ? "voice-busy" : !supportedSession(ctx) ? "unsupported-session" : undefined;
		voiceLog("mic.reopen", { session: sessionIdOf(ctx), result: busy ? "skipped" : "opened", reason: busy });
		if (busy) return;
		void runToggle(openToggle(ctx, true));
	};

	// A wake by voice leaves the session where the shortcut leaves it (S7, S11):
	// voice on, and the same hands-free conversation recording, so the listener's
	// capture plays the one open cue and the transcript is sent. A session that
	// cannot record right now only turns voice on: nothing beeps and nothing is
	// claimed for a microphone it never opened.
	const wakeConversation = (ctx: ExtensionContext): void => {
		if (!supportedSession(ctx)) return;
		// The session may have voice off and still be the one that was woken: the
		// listener turned its flag on, and the session follows with its own setting.
		if (!voiceOn(ctx)) setVoice(ctx, true, (message, type) => ctx.ui.notify(message, type));
		const busy = !voiceOn(ctx) ? "voice-refused" : toggling ? "dictation-running" : active ? "voice-busy" : reading ? "reading" : undefined;
		voiceLog("wake.conversation", { session: sessionIdOf(ctx), result: busy ? "skipped" : "opened", reason: busy });
		if (busy) return;
		void runToggle(openToggle(ctx, true));
	};

	// Join the same link dictation uses, with the session's current voice flag.
	// Voice-off sessions need a connection too: wake selects the focused session
	// from session-role connections. Joining never asks the listener to dictate.
	const joinAtStart = (ctx: ExtensionContext): void => {
		// An injected session factory replaces the listener as the capture path.
		const id = sessionIdOf(ctx);
		if (deps.createSession || !id) return;
		if (!voiceOn(ctx)) {
			try {
				const client = new VoiceListenerClient({
					dir: resolveVoiceHome(env),
					session: () => sessionIdOf(sessionCtx) === id
						? { sessionId: id, paneId: paneIdOf(), label: labelOf(sessionCtx), voiceOn: voiceOn(sessionCtx) }
						: undefined,
					onFrame: (frame) => {
						if (passiveClient !== client) return;
						if (frame.type === "command") receiveVoice(frame.command, frame.wake === true);
						else if (frame.type === "transcript") receiveTranscript(frame.text, frame.truncated === true);
					},
				});
				passiveClient = client;
				void client.connect().catch(() => {
					if (passiveClient === client) closePassive();
				});
			} catch { /* a passive join never interrupts startup */ }
			return;
		}
		const owner = generation;
		let link: SessionListenerLink;
		try {
			link = listener();
		} catch {
			try { voiceLog("listener.join", { session: sessionIdOf(ctx), result: "unavailable" }); } catch { /* logging is advisory */ }
			return;
		}
		const live = () => owner === generation && sessionCtx === ctx && sessionLink === link;
		void (async () => {
			if (!live()) return;
			let joined = false;
			try { joined = await link.ensure(); } catch { /* an unreachable listener leaves voice usable */ }
			if (!live()) {
				try { link.close(); } catch { /* the old link is already gone */ }
				return;
			}
			if (!joined) {
				try { voiceLog("listener.join", { session: sessionIdOf(ctx), result: "unavailable" }); } catch { /* logging is advisory */ }
			}
		})();
	};

	// Ends every voice activity one session owned. The generation moves first, so
	// no run of it can publish or paint again even before its capture finishes
	// cancelling; then the footer and the display go idle under that session's own
	// id, and its publisher closes. The next session starts from a clean display.
	const endSession = (ctx: ExtensionContext | undefined): void => {
		cutReadings();
		void releaseWarm().catch(() => {});
		// A reload keeps the same session id, so its connection goes with the
		// instance that owned it: a client that outlives its session comes back and
		// evicts the new instance's for ever (S6).
		if (ctx) {
			closePassive();
			sessionLink?.close();
			sessionLink = undefined;
		}
		if (cuesUsed) {
			cuesUsed = false;
			cuePlayer?.dispose();
			cuePlayer = deps.cues;
		}
		pendingReply = undefined;
		unavailableReported = false;
		spokenTurnPending = false;
		lastDictated = undefined;
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
		// Pi can reuse the context object while its session id changes: close the
		// old link on every replacement, not only when the object is different.
		endSession(previous);
		if (env.GENTLE_PI_AGENTS_CHILD === "1" || !ctx?.hasUI || ctx.mode !== "tui") return;
		sessionCtx = ctx;
		setVoiceFooter(ctx, () => true, undefined);
		// A supported session opens idle for its own id: the tab has a baseline and
		// any footer a replacement left behind is cleared.
		publishVoiceState(ctx, "idle");
		if (readToggle()) arm(ctx);
		// The session link receives wake and voice-off even before the first Alt+M.
		joinAtStart(ctx);
		// A voice session wakes the cue player now, so the first cue is on time.
		if (voiceOn(ctx)) cues().warm();
	});
	// A new run stops the reading and forgets the previous reply; the reply of the
	// last run is read once nothing else will run automatically.
	// A typed message ends the spoken turn; messages sent by extensions,
	// including this one, leave it as it is.
	// The user's own message, typed or spoken, stops the reading: they moved
	// on. A typed one also ends the spoken turn. Runs that background notices or
	// other extensions start leave the reading alone, and their reply waits.
	pi.on("input", (event) => {
		const typed = event?.source === "interactive";
		const spokenSend = voiceSendPending;
		// A dictation the owner sent with Enter is a spoken turn too, even though Pi
		// reports it as interactive input: that is what the log showed (S2).
		const dictated = typed && takeDictated(event?.text);
		voiceLog("input", { source: event?.source, spokenSend, dictated, reading: Boolean(reading) });
		voiceSendPending = false;
		if (dictated) spokenTurnPending = true;
		else if (typed) spokenTurnPending = false;
		if (typed || spokenSend) cutReadings();
	});
	pi.on("agent_start", () => {
		pendingReply = undefined;
	});
	pi.on("agent_end", (event) => {
		const text = lastAssistantText(Array.isArray(event?.messages) ? event.messages : []);
		if (text) pendingReply = text;
	});
	// Reads one reply, then the one that waited behind it; once nothing is left
	// to read, a pending spoken turn reopens the microphone.
	const readReply = (ctx: ExtensionContext, text: string): void => {
		const owner = generation;
		void readAloud(ctx, text).then(async (outcome) => {
			if (owner !== generation) return;
			// A reading heard to the end or skipped with Esc goes on to the
			// microphone; one that failed, or was cut by a new message or voice off,
			// leaves it closed. Only a reply to a spoken turn reopens it.
			const finished = outcome === "done" || outcome === "skipped" || outcome === "empty" || outcome === "unavailable";
			if (outcome === "error") spokenTurnPending = false;
			if (!finished) {
				voiceLog("mic.reopen", { session: sessionIdOf(ctx), result: "skipped", reason: `reading-${outcome}`, spokenTurnPending });
				queuedReply = undefined;
				return;
			}
			const next = queuedReply;
			queuedReply = undefined;
			if (next && voiceOn(next.ctx)) return readReply(next.ctx, next.text);
			if (!spokenTurnPending || !voiceOn(ctx)) {
				voiceLog("mic.reopen", { session: sessionIdOf(ctx), result: "skipped", reason: spokenTurnPending ? "voice-off" : "no-spoken-turn" });
				return;
			}
			spokenTurnPending = false;
			const focused = await paneFocused().catch(() => false);
			if (owner !== generation) return;
			if (focused) listenForReply(ctx);
			else voiceLog("mic.reopen", { session: sessionIdOf(ctx), result: "skipped", reason: "not-focused" });
			if (!focused) ctx.ui.notify(`Conversation paused in this pane. Press ${toggleKey} to talk.`, "info");
		});
	};
	// Reads the reply that settled now, or waits behind the reading in progress as
	// before.
	const startReply = (ctx: ExtensionContext, text: string): void => {
		if (reading) {
			queuedReply = { ctx, text };
			return;
		}
		readReply(ctx, text);
	};
	// A reply is read only in the pane the owner is looking at (S12); anywhere
	// else it is held and read when that pane comes back. A herdr that cannot say
	// never silences a reply: unknown keeps the old behavior and reads it now.
	const settleForReading = async (ctx: ExtensionContext, text: string): Promise<void> => {
		const owner = generation;
		let focus: PaneFocus;
		try {
			focus = await paneFocus();
		} catch {
			focus = "unknown";
		}
		// The session was replaced, or voice was turned off, while herdr answered.
		if (owner !== generation || !voiceOn(ctx)) return;
		if (focus === "unfocused") holdReply(ctx, text);
		else startReply(ctx, text);
	};
	pi.on("agent_settled", (event, ctx) => {
		const text = pendingReply;
		pendingReply = undefined;
		// The spoken turn stays pending until the microphone reopens. Typing, Esc
		// and a failed reading end it.
		voiceLog("reply.settled", { session: sessionIdOf(ctx), aborted: Boolean(event?.aborted), chars: text?.length ?? 0, voice: voiceOn(ctx), reading: Boolean(reading), spokenTurnPending });
		if (event?.aborted || !text || !supportedSession(ctx) || !voiceOn(ctx)) return;
		void settleForReading(ctx, text);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		const previous = sessionCtx;
		sessionCtx = undefined;
		endSession(ctx ?? previous);
	});
}
