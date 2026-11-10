# Voice speech events

Publish reply-reading lifecycle and per-chunk loudness on the Pi extension event bus so other extensions (for example a BLE LED bridge) can sync to the spoken voice.
Branch `feat/voice-speech-events`. Additive: no existing event, payload, or behavior changes.

## Specs

- S1. User request (L1): "vamos con la B" — option B: lights that follow the voice. The package publishes "started / loudness / ended" while a reply is read aloud.
- S2. Channel `gentle-ai:voice-speech` on `pi.events`, payload schema `gentle-pi.voice-speech/v1`:
  - `{ schema, phase: "start", engine }` right before the reading starts (where `voiceLog("reading.start")` is today).
  - `{ schema, phase: "chunk", engine, frameMs: 50, durationMs, levels: number[] }` when a chunk actually starts playing on the host (not when it is queued). `levels` are per-50 ms RMS loudness values normalized to 0..1 (1 = the chunk's peak frame, or an absolute scale; document which).
  - `{ schema, phase: "end", engine, outcome }` after the reading resolves, is skipped (Esc), cancelled, or fails. Exactly one `end` per `start`.
- S3. Engines with WAV bytes in Node (Kokoro, Miro/Piper, Raúl/OneCore) emit `chunk` events. Windows SAPI has no bytes in Node: it emits only `start`/`end` (consumers fall back to a breathing effect).
- S4. Exact chunk timing: the shared PowerShell player (`KOKORO_PLAYER_SCRIPT`) reports on stdout when it begins playing each queued line, so Node emits that chunk's `chunk` event at that moment. The player is fed one chunk at a time, because WSL delivers a player's input and output over one relay that withholds the report while chunk bytes are still pending (L2).
- S5. Publishing never breaks or delays speech: listener errors are swallowed; no event bus means no-op.
- S6. Docs: `docs/voice.md` documents the event (channel, schema, phases, fields, SAPI limitation).
- S7. Reply volume (L3): `GENTLE_PI_VOICE_VOLUME` turns only the reply down, from 0 to 1 with 1 by default; anything that is not a number from 0 to 1 reads as 1. Kokoro, Miro and Raúl scale the PCM samples of each WAV before the player gets it, so `levels` stay normalized per chunk; the Windows voice sets `$synth.Volume` to `round(volume*100)` and sends it only when the volume is below 1.

## Tasks

- T1 (S1-S6) worker: implement event, player playback markers, loudness envelope, tests, docs. Commit: `30c52938f` (done).
- T2 (S1) parent: LED bridge outside this repo (Pi extension + Windows BLE daemon). Not in this repo.
- T3 (S4) worker: feed the player one chunk at a time (`createPlayerFeed` replaces the queue-everything sink), so its playback marker is never held back by pending input, and each chunk is still measured on the bytes the player receives. Tests cover the order, the release, an unmeasurable chunk and the failure paths. Real path, four 4 s chunks, before: second event 4.1 s after its audio, two events 3 ms apart; after: 0, 3, 10 and 17 ms against the player's own clock.
- T4 (S7) worker: reply volume through `GENTLE_PI_VOICE_VOLUME`, in the three WAV engines and the Windows voice. Commit: this one.

## Log

- L1 (user, 2026-11-10): "vamos con la B.. y otra cosa.. si conectara el dispositivo por usb a la pc, lo podriamos Reprogamar?..." — B = "Luces que siguen la voz": Raúl, Miro and Kokoro have audio in memory, so loudness per phrase can be computed; requires changing Gentle Shell to publish "started / volume / ended".
- L2 (user, 2026-11-10, after trying T1): "Sí, pero sigue sin corresponder, digamos, cuando vos hablas o lo que estás dictando, con el mismo en el que parpadean las luces." — the events trail the audio. Root cause: each chunk event reached consumers one chunk late, because the player's stdout was not pumped while its stdin still had chunk bytes to deliver. T3.
- L3 (user, 2026-11-10): "bajarle un poquito la voz a lo que dicen los parlantes Bajarle un 20 un 20% quizás" — reply volume below full. T4.
