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
import { createHerdrFocus, VoiceListener } from "../lib/voice-listener.ts";
import { diagnoseVoicePlatform, readVoicePlatformProbe } from "../lib/voice-platform.ts";
import { createWarmVoiceWorker } from "../lib/voice-warm.ts";

const env = process.env;
const dir = resolveVoiceHome(env);
const log = createVoiceLog({ dir });

// One warm worker for the listener's lifetime: the model is verified and loaded
// once, and a recording reuses it. A platform without a pinned runtime gets no
// worker, so dictate is refused and the sessions keep recording themselves.
const diagnosis = diagnoseVoicePlatform(readVoicePlatformProbe());
const target = diagnosis.support === "unsupported" ? undefined : diagnosis.target;
const warm = target ? createWarmVoiceWorker({ target, env }) : undefined;
if (!warm) log("listener.capture-unavailable", { reason: diagnosis.limitations[0] ?? diagnosis.support });

// The cues are played where the microphone is: this process, next to the worker.
const cues = createCuePlayer({ env });
// Focus comes from herdr; a failed lookup focuses nothing, so nothing is
// delivered and the microphone stays closed.
const listener = new VoiceListener({
	dir,
	log,
	cues,
	focus: createHerdrFocus({ env }),
	// The display levels travel with the capture: the listener decides whether
	// they are needed and the warm worker publishes them only then.
	dictation: warm ? ({ onStateChange, endpoint, levels, onLevel }) => warm.session({ onStateChange, endpoint, levels, onLevel }) : undefined,
	// The overlay port goes here once the window exists (T12); until then the
	// listener publishes the levels to the sessions that ask for them and to
	// nobody else.
});

let stopping = false;
const stop = (reason) => {
	if (stopping) return;
	stopping = true;
	// The worker is this process's child, so it goes down with the listener.
	void listener.close(reason)
		.then(() => warm?.close(), () => warm?.close())
		.catch(() => {})
		.then(() => process.exit(0));
};
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop("shutdown"));
// The parent session going away must not leave a microphone owner behind.
process.once("disconnect", () => stop("shutdown"));

listener.listen().then(
	() => log("listener.ready", { pid: process.pid, capture: warm ? "ready" : "unavailable" }),
	(error) => {
		log("listener.start-failed", { reason: String(error?.message ?? error) });
		void warm?.close().catch(() => {}).then(() => process.exit(1));
	},
);
