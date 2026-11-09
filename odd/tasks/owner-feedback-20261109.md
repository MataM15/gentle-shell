# Owner feedback after the 2026-11-09 upstream merge

Base: `personal/main` @ `a0c0ac61a` (upstream main `f4cc69a33` merged). Personal design contract: `docs/personal-design.md` (owner's look wins for visuals; upstream wins for functionality). Owner runs card style `neon` (`~/.pi/gentle-ai/card-style.json`) in a 98x95 terminal (narrow layout is the main view).

## Specs

- **S1 — Alt+M dictation stops on silence.** Owner: "cuando aprieto Alt M, bien, y me quedo callado, si escuchando y no se para nunca." Alt+M dictation (paste mode, `/gentle:voice` conversation off) must end by itself after silence, like conversation turns do, instead of recording until the 120 s cap. Cause found: `lib/voice-command.ts:1140` passes `CONVERSATION_ENDPOINT` only when `current.send`; paste dictation gets no endpoint, so the worker builds no `Endpointer`.
- **S2 — Conversation mode uses the Alt+M cues.** Owner: "los sonidos también no corresponden a los sonidos que utilizamos nosotros para el por ejemplo el barra Gentle Voice ... no son los mismos sonidos. De todo modo me gustan los sonidos que tenemos así de esta manera, bien, cuando aprieto Alt M, teniendo lo apagado la opción de voice. Para que en todo caso implementen estos sonidos en el otro." Owner clarified the differing moment: "Al empezar o terminar de escucharme" (mic open/close of a conversation turn). The open/close sounds heard in `/gentle:voice` conversation turns must be the same sounds heard with Alt+M dictation.
- **S3 — The commands menu lists every current command.** Owner: "tenemos, por ejemplo, todo lo representado todos los comandos actualizados en la barra nosotros de commands" (with a screenshot of the rail header `≡ commands [alt+k]`). The palette opened by `≡ commands` / alt+k must offer every user-facing registered command of the updated shell, not only the curated 23 (`lib/command-palette-catalog.ts`). Keep the upstream exclusion of banner commands (#1664) and retired SDD commands.
- **S4 — The palette's esc is clickable.** Owner: "cuando abro ese command creo que el escape que aparece ahí no es cliqueable para hacer todo que sea o agregarle la opción para que sea se pueda interactuar con el mouse con el click". A left click on the `esc` hint of the commands palette closes it, with hover feedback like the panel sheet's `esc back` (`lib/shell-panel.ts:156-167`).
- **S5 — Rail: profile tier in the header (G2).** Show the configured tier (`Fast`/`Standard`) in the rail header model row: `model · effort · Fast · profile`, wide and narrow, neon style, no petals.
- **S6 — Rail: 5h usage window beside usage (G3).** Show the 5-hour usage window gauge beside `◔ usage` in the rail header, keeping the weekly one.
- **S7 — Narrow panel reaches Otras sesiones and Limits (N).** At widths without the rail (owner's 98 columns), the `[ Panel ]` sheet (`lib/shell-panel.ts:149`) also offers the Otras sesiones and Limits sections.
- **S8 — Keep the personal design.** Owner: "Recorda adaptarlo a nuestro estilo o diseño en todo caso". Every change follows `docs/personal-design.md`; all personal design tests stay green; new visible pieces get a row in its table with their test.

## Tasks

| ID | Specs | Route | Worktree / branch | Commit |
|---|---|---|---|---|
| T1 | S1, S2, S8 | gentle-ai-worker | `gentle-shell-worktrees/voice-dictation-fixes` · `feat/voice-dictation-fixes` | `16aecbffd` (S1 done; S2 traced, diagnostics added) |
| T2 | S3, S4, S8 | gentle-ai-worker | `gentle-shell-worktrees/palette-commands-esc` · `feat/palette-commands-esc` | `91d130a51` (S3, S4 done; 36 entries + registry gate) |
| T3 | S5, S6, S7, S8 | visual (Sonnet 5.5) | `gentle-shell-worktrees/rail-upstream-gaps` · `feat/rail-upstream-gaps` | `c20c30c62` (S5-S7); sheet-wide cards pending |
| T4 | S8 | parent | integrate T1-T3 on `personal/main` after owner OK | pending |

## Log

- L1 (owner, verbatim): "Mira, un par de cosas. Por ejemplo, una es que cuando aprieto Alt M, bien, y me quedo callado, si escuchando y no se para nunca. Y otra que los sonidos también no corresponden a los sonidos que utilizamos nosotros para el por ejemplo el barra Gentle Voice. Bien, que viste que lo prendemos, bueno no se corresponde, no son los mismos sonidos. De todo modo me gustan los sonidos que tenemos así de esta manera, bien, cuando aprieto Alt M, teniendo lo apagado la opción de voice. Para que en todo caso implementen estos sonidos en el otro. Y otra cosa más que te iba a decir. Ah, tenemos, por ejemplo, todo lo representado todos los comandos actualizados en la barra nosotros de commands. Ahora te paso una captura para que veas a que me refiero. [Image#1] bien y otra cosa recordar que que por ejemplo yo cuando abro ese command creo que el escape que aparece ahí no es cliqueable para hacer todo que sea o agregarle la opción para que sea se pueda interactuar con el mouse con el click bien? Y por las dudas ya que estamos, ten en cuenta que acabamos de actualizar Gentle Shell. Así que fíjate cómo lo vas a aplicar a todo esto que te estoy diciendo."
- L2 (owner): "Fíjate que por ejemplo bueno lo que viene Astream O sea lo que es Canon del de Gendel Shell que se muestra en el sidebar fíjate si no si lo podemos adaptar o integrar a nuestro sidebar a nuestro diseño ojo sin perder el diseño o ver ahí de qué manera lo podemos combinar" → owner selected G2, G3 and N (S5-S7); G1 declined.
- L3 (owner): "Recorda adaptarlo a nuestro estilo o diseño en todo caso".
- L4 (owner answer): cue difference happens "Al empezar o terminar de escucharme".
- L5 (evidence): `~/.pi/gentle-ai/voice/voice-events.log` shows Alt+M `open`/`close` cues `done` in session `01a1c21f…`; code map says both modes call `lib/voice-cues.ts` `CUES` through `lib/voice-command.ts:464`, so the conversation-mode difference is unexplained by static reading (hypotheses: cue overlaps the spoken reply tail, warm-session path, or another sound). The live Pi still runs pre-merge `992a71c7c`.
- L6 (owner answers after the T3 sheet): "Sí, todas como cards neón" for every `[ Panel ]` sheet section (S7 extended: Todos, Agents, Changes, Integrations too, transparent surface); "No, dejalo sin tier" (no tier configured on profile claude-nan); "Sí, integrá" T1-T3 into personal/main after a full-suite run on the combination.
