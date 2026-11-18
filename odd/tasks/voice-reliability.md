# Voice reliability

Fix the Gentle Voice failures the owner reported on 2026-11-18: captures that never take the microphone, dictations that are lost, the command listener ("el mini") not staying up, and the worker holding memory with voice off.
Branch `feat/voice-control` (worktree `gentle-shell-worktrees/voice-control`), fast-forwarded to `personal/main` 949ff936d before the first write. Never run the full `pnpm test`; the live checkout is only fast-forwarded with the owner's approval.

## Specs

- **S1** "A veces no me toma el micrófono": a dictation or conversation capture does not fail because the command spotter and the capture hand the microphone to each other, and command spotting does not fail right after it restarts.
- **S2** "a veces se corta": a dictation that finished transcribing is never thrown away for lack of a delivery target.
- **S3** "usualmente no se queda levantado el mini [...] que es para que se quede escuchando": the command listener stays up "Mientras haya una sesión de Pi abierta" (owner decision, L2); it no longer closes after 10 minutes with voice off, it closes only when no session is left, and a listener that dies is started again without a manual voice action.
- **S4** "a veces creo que se queda ocupando espacio": the dictation model is unloaded "apenas apagás la voz" (owner decision, L2) while command spotting keeps working.
- **S5** "a veces funciona raro lo de Gentle Voice On y lo de... gentle voice [off]": the spoken on and off commands keep working after voice has been off for more than 10 minutes and right after a turn or a capture ends.

## Tasks

- [x] T1a (S1) Record which native capture error ends a capture, as a fixed code, in the voice event log (`capture.native`). The worker prints one fixed line on stderr and the warm worker reads it, so the stdout frames stay exactly as they are and an old listener with a new worker (or the reverse) keeps working. Worker. Commit: 31f39b4ac.
- [ ] T1b (S1, S5) Fix the handoff failure once `capture.native` names it in real use. Blocked on T1a being integrated live. Commit: pending.
- [x] T2 (S2) When no delivery target resolves, deliver the finished transcript to the session that started the capture; a transcript a session receives is always inserted. Worker. Commit: the one after 31f39b4ac (`fix(voice): hand a finished dictation back to its session`).
- [ ] T3 (S3, S5) Listener lifetime tied to connected sessions; clients restart a dead listener. Inline. Commit: pending.
- [ ] T4 (S4) Unload the dictation model when voice goes off, spotting stays. Inline. Commit: pending.
- [ ] T5 (S4) Measure worker memory over repeated captures and long spotting; fix only what the measurement names. Inline. Commit: pending.

## Log

- **L1** (owner, 2026-11-18, original request, verbatim): "Escúchame, está funcionando mal el tema del audio. A veces no me toma el micrófono, a veces se corta, han habido varias fallas. Y otro tema es que a veces creo que se queda ocupando espacio, no sé si necesario o que otra función, no sé, a veces funciona raro lo de Gentle Voice On y lo de... Y bueno, gentle voice, que no lo quiero decir porque creo que apaga lo que estoy diciendo ahora. O sea, usualmente no se queda levantado el mini. El mini. La mini IA este, el mini. Bueno, sí, que dejamos instalado en local, digamos, que es para que se quede escuchando. Anda medio medio."
- **L2** (owner decisions, 2026-11-18): "¿Arranco con los arreglos de voz?" -> "Sí, los 5 en ese orden (recomendado)". "¿Cuándo tiene que quedar escuchando el mini?" -> "Mientras haya una sesión de Pi abierta (recomendado)". "¿Qué hago con el modelo grande de dictado (unos 1.200 MB)?" -> "Descargarlo apenas apagás la voz".
- **L3** (evidence, 2026-11-18, `~/.pi/gentle-ai/voice/voice-events.log` and `.1`, two days): 30 `kws.failed` (29 `capture`, 1 `worker-exited`), 15 within 0.1 s of `kws.recovered`, 10 right after `turn.sent` or `capture.end`; recovery 2 to 7 s, once 29 s. 38 `capture.begin`: 26 `capture.end` (22 delivered, 2 elsewhere, 1 dropped after 57.8 s with `transcript.undelivered clients=1`), 9 `capture.failed` (3 `capture` in 1.1 to 1.5 s, 6 `no-speech`), 1 cancelled, 1 closed. 4 `listener.exit`, all `idle`.
- **L5** (2026-11-18): a stand-alone silent probe of the native capture runtime was denied twice by the permission guard, because the runtime is installed under the Gentle config home. Not worked around. T1 split into T1a (record the native code through the product itself) and T1b (fix, after evidence).
- **L4** (measurement, 2026-11-18, live worker pid 669793): 178 MB resident before the first transcription, 1,260 MB after it, flat over 5 samples in 25 s while spotting. The earlier 2.1 GB after 58 minutes (2026-11-17) is not explained yet.
