#!/usr/bin/env node
// The one voice listener for every Pi session (S6,
// odd/notes/voice-listener-design.md). It owns the process, the lock and the
// socket, and from slice C it owns the microphone too: the warm dictation worker
// records and transcribes here, the cues play here, and a session that asked for
// a capture only receives its transcript. Sessions start it through
// lib/voice-listener-client.ts and never spawn a second one.
import { createCuePlayer } from "../lib/voice-cues.ts";
import { createVoiceLog } from "../lib/voice-diagnostics.ts";
import { resolveVoiceHome } from "../lib/voice-install.ts";
import { buildVoiceKeywordOption, createHerdrFocus, VoiceListener } from "../lib/voice-listener.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe } from "../lib/voice-platform.ts";
import { createWarmVoiceWorker } from "../lib/voice-warm.ts";

const env = process.env;
const dir = resolveVoiceHome(env);
const log = createVoiceLog({ dir });

// One warm worker owns each child: recordings reuse its loaded model until voice
// goes off, then the listener recycles it before resuming keyword spotting.
// A platform without a pinned runtime leaves capture to the sessions.
const diagnosis = diagnoseVoicePlatform(readVoicePlatformProbe());
const target = diagnosis.support === "unsupported" ? undefined : diagnosis.target;
const warm = target ? createWarmVoiceWorker({ target, env, onNativeError: (error) => listener.reportNativeCaptureError(error) }) : undefined;
if (!warm) log("listener.capture-unavailable", { reason: diagnosis.limitations[0] ?? diagnosis.support });

// The cues are played where the microphone is: this process, next to the worker.
const cues = createCuePlayer({ env });
// Focus comes from herdr: a failed lookup never wakes a session or opens the
// microphone. It is consulted for a transcript only if its requester has left.
//
// The keyword option (S7): built from the spotter that is installed here, its
// pinned digests and the keyword file that ships with the package. Without it no
// capture hears a spoken command and the listener behaves exactly as before, so a
// spotter that is missing or half extracted only costs the keyword.
const keyword = await buildVoiceKeywordOption({ voiceHome: dir });
const keywordOption = "option" in keyword ? keyword.option : undefined;
if (!keywordOption) log("listener.keyword-unavailable");

const listener = new VoiceListener({
	dir,
	log,
	cues,
	focus: createHerdrFocus({ env }),
	// The display levels travel with the capture: the listener decides whether
	// they are needed and the warm worker publishes them only then.
	dictation: warm ? ({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }) => warm.session({ onStateChange, endpoint, levels, onLevel, kws, onKeywordRejected }) : undefined,
	worker: warm,
	// A surviving child must not keep the listener process (or its pipes) alive.
	// Exit only after confirming worker closure or persisting a surviving child's PID.
	onExit: () => process.exit(0),
	// Spotting shares the warm worker while asleep, between turns and during readings.
	keyword: keywordOption,
	spot: warm && keywordOption ? (onKeywordRejected) => warm.spot({ kws: keywordOption, onKeywordRejected }) : undefined,
});

let stopping = false;
const stop = (reason) => {
	if (stopping) return;
	stopping = true;
	// Listener shutdown also closes the worker it owns.
	void listener.close(reason).catch(() => {});
};
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop("shutdown"));
// The parent session going away must not leave a microphone owner behind.
process.once("disconnect", () => stop("shutdown"));

listener.listen().then(
	() => log("listener.ready", { pid: process.pid, capture: warm ? "ready" : "unavailable" }),
	(error) => {
		log("listener.start-failed", { reason: String(error?.message ?? error) });
		void warm?.close().catch(() => {}).then(() => process.exit(1));
	},
);
