# Voice: English robot voice, per-language rate, no plain Spanish fallback

Replies are read by a robot-filtered OneCore voice in both languages: Raúl for Spanish, David for English.
Branch `feat/voice-english-robot`. The user dislikes the plain Spanish voices (Miro, Kokoro es) and wants English practice with a slower male voice.

## Specs

- S1. English replies (`guessReplyLanguage` = "en") are read by OneCore "Microsoft David" with the same robot effect as Raúl (`processRobotVoice`). Spanish (and undecided) replies keep "Microsoft Raul". User: "david" (chosen after hearing David and Mark samples with the robot effect).
- S2. The plain Spanish voices never read a reply: Miro and Kokoro-es are removed from the Spanish fallback. If the robot voice fails before any audio, it is retried once; if it fails again the reading ends with outcome "error" (no other voice). User: "o me hablas con la voz que estamos configurando para inglés o me hablas con la otra voz, no dejes la voz esa de español porque no me gusta."
- S3. Per-language speech rate multipliers: `GENTLE_PI_VOICE_RATE_ES` and `GENTLE_PI_VOICE_RATE_EN` (number, 0.5..2, default 1; anything else reads as 1), applied to the OneCore voice through `SpeakingRate` (or SSML prosody). User: "no deberíamos aplicar el mismo multiplicador, por ejemplo, para la voz en español que para en inglés." and wants English slower ("slow, slow").
- S4. The voice log records which voice actually spoke and why a fallback/retry happened: `reading.start`/`reading.end` (or a `speech.voice` / `speech.fallback` line) include the voice name and the failure code (unavailable, no-voice, failed, timeout). The speech event `engine` field names the voice that spoke, not the composite chain id.
- S5. Docs: `docs/voice.md` documents the per-language voices, the new env vars, the retry rule, and the log fields; fix the stale line saying Esc on a reading ends it (Esc skips and reopens the mic after a spoken turn).

## Tasks

- T1 (S1-S5) worker. Commit: 6a2ff44b8.

## Log

- L1 (user, 2026-11-10): "I would like to listen in the English voice and uh maybe we can use a other voice uh like uh male ... English voice with the same effect that uh that has apply in Spanish voice" / "we must apply a multiplier to make the voice speak ... slow, slow, slow"
- L2 (user): "O sea, no deberíamos aplicar el mismo multiplicador, por ejemplo, para la voz en español que para en inglés."
- L3 (user): "¿por qué ahora me hablaste con la voz de español y no me hablaste con la de Jarvis, que es la que tiene el filtro ... o me hablas con la voz que estamos configurando para inglés o me hablas con la otra voz, no dejes la voz esa de español porque no me gusta."
- L4 (user): "david"
- L5 (parent evidence): Installed OneCore voices: Microsoft David (en-US, Male), Zira (en-US, Female), Sabina (es-MX, Female), Raul (es-MX, Male), Mark (en-US, Male). Esc mic reopen works after spoken turns (mic.reopen result=opened after outcome=skipped); not reopened after a typed turn by design. Not a bug.
