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
- S4. Exact chunk timing: the shared PowerShell player (`KOKORO_PLAYER_SCRIPT`) reports on stdout when it begins playing each queued line, so Node emits that chunk's `chunk` event at that moment.
- S5. Publishing never breaks or delays speech: listener errors are swallowed; no event bus means no-op.
- S6. Docs: `docs/voice.md` documents the event (channel, schema, phases, fields, SAPI limitation).

## Tasks

- T1 (S1-S6) worker: implement event, player playback markers, loudness envelope, tests, docs. Commit: pending.
- T2 (S1) parent: LED bridge outside this repo (Pi extension + Windows BLE daemon). Not in this repo.

## Log

- L1 (user, 2026-11-10): "vamos con la B.. y otra cosa.. si conectara el dispositivo por usb a la pc, lo podriamos Reprogamar?..." — B = "Luces que siguen la voz": Raúl, Miro and Kokoro have audio in memory, so loudness per phrase can be computed; requires changing Gentle Shell to publish "started / volume / ended".
