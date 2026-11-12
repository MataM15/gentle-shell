#!/usr/bin/env node
// The one voice listener for every Pi session (S6,
// odd/notes/voice-listener-design.md). Slice A owns the process, the lock and
// the socket; it opens no microphone and loads no model yet. Sessions start it
// through lib/voice-listener-client.ts and never spawn a second one.
import { createVoiceLog } from "../lib/voice-diagnostics.ts";
import { resolveVoiceHome } from "../lib/voice-install.ts";
import { createHerdrFocus, VoiceListener } from "../lib/voice-listener.ts";

const dir = resolveVoiceHome(process.env);
const log = createVoiceLog({ dir });
// Focus comes from herdr; a failed lookup focuses nothing, so nothing is
// delivered and the microphone stays closed.
const listener = new VoiceListener({ dir, log, focus: createHerdrFocus({ env: process.env }) });

let stopping = false;
const stop = (reason) => {
	if (stopping) return;
	stopping = true;
	void listener.close(reason).then(
		() => process.exit(0),
		() => process.exit(1),
	);
};
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop("shutdown"));
// The parent session going away must not leave a microphone owner behind.
process.once("disconnect", () => stop("shutdown"));

listener.listen().then(
	() => log("listener.ready", { pid: process.pid }),
	(error) => {
		log("listener.start-failed", { reason: String(error?.message ?? error) });
		process.exit(1);
	},
);
