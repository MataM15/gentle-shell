# Gentle Voice control: audible cues, spoken commands, overlay, wake word

Base: `personal/main` @ `e815d8936`. Worktree `gentle-shell-worktrees/voice-control`, branch `feat/voice-control`. Roadmap agreed with the owner on 2026-11-12 (phases 0-7 below); open owner decision noted in S7.

## Specs

- **S1 — Audible microphone cues.** Owner: "Quiere un sonido claro cuando el micrófono se activa y otro cuando se corta, que se escuche por los parlantes (hoy no lo oye), para saber sin mirar la pantalla si lo está escuchando." Today cues play through WSLg PulseAudio (default sink, 160 ms, 0.25 gain) while replies play through Windows (PowerShell); the log shows every cue `done`, so the route and level are the problem. Cues must play on the same Windows output the reply voice uses, be clearly louder and longer, and open/close must be unmistakably different. Latency stays low (a warm player); PulseAudio remains the fallback when the Windows path is unavailable.
- **S2 — A dictated turn reopens the mic.** Evidence 2026-11-12 18:37-18:43Z (session `01a1cd43…`): owner used Alt+M dictation, the transcript went to the editor, owner sent it with Enter (`input source=interactive spokenSend=false`), so after the reading `mic.reopen skipped reason=no-spoken-turn`. Owner: "Hoy el micrófono no se abrió solo; hay que revisar por qué." A turn whose text came from a dictation counts as spoken for the reopen.
- **S3 — Spanish fixed for dictation.** Owner: "el dictado tomó «sí, siguiente» como inglés y lo transcribió «And they're». Quiere el idioma fijo en español". Parakeet v3 auto-detects language and cannot be forced; measure local alternatives (Spanish-only model, Whisper with forced language) on short and long Spanish phrases and the spoken commands before choosing.
- **S4 — "Gentle Voice off" by voice.** Owner: "decir «Gentle Voice off» para apagar todo (micrófono y lectura en voz alta), sin comandos escritos." Only a whole utterance that is the command counts; the phrase inside a sentence is sent as text. The command is never sent to the model.
- **S5 — Big overlay with a waveform.** Owner: "Quiere una ventana o aviso grande en el centro de la pantalla (idealmente con una onda de audio mientras habla)." A Windows topmost, click-through, semi-transparent window launched by Gentle Shell (PowerShell), showing state (listening / transcribing), the live mic level as a wave, the session that is listening, and the active language. Requires the worker to publish audio levels.
- **S6 — One listener for all sessions.** With many Pi sessions in herdr, one process owns the mic, wake word, cues and overlay; dictation goes to the focused session.
- **S7 — "Gentle Voice on" by voice.** Owner: "decir «Gentle Voice on» para empezar a escuchar". Local keyword spotting (sherpa-onnx KeywordSpotter ships in the installed runtime; a small KWS model must be pinned). Test the owner's pronunciation before committing. Must not hear its own reading. Owner decision (L8): after "off" it stays ASLEEP: mic, readings and dictation off, only the local keyword spotter keeps listening for "Gentle Voice on"; the overlay/status must show the asleep state.
- **S8 — Navigate herdr agents by voice.** Owner: "si el día de mañana, por ejemplo, quiero navegar desde Header mediante vos entre las diferentes agentes que están activos o levantados, me gustaría poder hacerlo". Fixed command list over `herdr agent list/focus`; sending a prompt to another agent asks for confirmation.
- **S9 — Deliberate English mode.** Owner: "más adelante, un modo inglés que se active a propósito para practicar." Switched on and off on purpose only, never auto-detected; the overlay shows it.
- **S10 — Safety rules (all phases).** Owner: "evaluando situaciones también, por ejemplo, que pasaría si estoy hablando y por ejemplo, no sé, algo y se activa, o no se activa, cuestiones de seguridad". Voice never runs free text as a command (fixed list only); nothing destructive or publishing by voice; every activation is visible and audible; false activations close on silence and are logged; Alt+M always works as fallback; audio stays local and is not stored. Development probes stay near-silent (peak at most 20 of 32767).

## Tasks

| ID | Specs | Route | Commit |
|---|---|---|---|
| T1 | S1, S10 | inline (writer guard refused); review review-65c2ada4ac9c2f95 approved | `2930b193d`, follow-up fix in the next commit |
| T2 | S3 | gentle-ai-worker research, scratch only (background) | pending |
| T3 | S2, S4, S10 | gentle-ai-worker | this commit |
| T4 | S5 | after T3 | pending |
| T5 | S6 | after T4 | pending |
| T6 | S7 | after T5 | pending |
| T7 | S8 | after T5 | pending |
| T8 | S9 | after T2 and T5 | pending |

## Log

- L1 (owner, verbatim): "Hagamos una cosa, abrir una sesión nueva, creo que no sé si hay un una ruta ya para el tema para iniciar la sesión ahí que trabajemos el tema del gentle voice bien. Y ahí creo que mejoremos el tema este, por ejemplo, de que puede haber una mediante una notificación grande o algo que estoy hablando. Quizás incluso tipo por que se muestra una onda estaría bueno, no sé si se puede hacer, si lo tendríamos que hacer por afuera, o lo podríamos hacer en el mismo gentle shell, bien. Eso una y otra la función que te digo es, podríamos hacerlo, por ejemplo, un gentle, decir gentle voice on para que me empiece a escuchar, y un gentle voice off en todo caso para apagar bien, pero me gustaría, en vez de tener que manejarlo mediante comando, sino ver la forma de integrarlo, tener la función o la control mediante, el control perdón de la función sería mediante voz."
- L2 (owner context from Obsidian): monitor vertical, does not see when the mic opens/closes; listens through speakers and does not hear the open/close sounds; today the mic did not open by itself; voice control "Gentle Voice on"/"Gentle Voice off".
- L3 (owner): "revisá también el pitido. Quiere un sonido claro cuando el micrófono se activa y otro cuando se corta, que se escuche por los parlantes (hoy no lo oye), para saber sin mirar la pantalla si lo está escuchando."
- L4 (owner, verbatim): "Mirá, si lo planeemos bien, hacerlo tipo hagamos un roadmap, digamos, más o menos, y evaluando situaciones también, por ejemplo, que pasaría si estoy hablando y por ejemplo, no sé, algo y se activa, o no se activa, cuestiones de seguridad, bien tratar de contemplar eso para y construir algo algo que me ayude. También de paso que voy pensando, porque si el día de mañana, por ejemplo, quiero navegar desde Header mediante vos entre las diferentes agentes que están activos o levantados, me gustaría poder hacerlo para ir pensando en adelante en la automatización, digamos."
- L5 (owner): "el dictado tomó «sí, siguiente» como inglés y lo transcribió «And they're». Quiere el idioma fijo en español y, más adelante, un modo inglés que se active a propósito para practicar."
- L6 (owner): "ok dale" — roadmap approved, start.
- L7 (evidence): cues `done` in voice-events.log (route/level problem, not playback failure); S2 root cause traced from the log (dictation + Enter = interactive input).
- L8 (owner, verbatim, answering deaf vs asleep after "Gentle Voice off"): "dormido".
