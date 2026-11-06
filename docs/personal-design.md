# Personal design contract

This branch (`personal/main`) is upstream Gentle Shell plus the owner's personal look. Read this before every upstream merge; the update runbook (`safe-gentle-update`, section 9, step 4b) requires it.

## Principle

The owner, verbatim: "me gusta el diseño que tenemos, el estilo ... habría que tratar de mantenerlo"; functionality and performance improvements from upstream are welcome.

- Visuals and layout: the owner's look wins.
- Functionality and performance: upstream wins.
- Where upstream now does what a personal patch did, adopt upstream's code and configure it to the owner's look.
- Before resolving conflicts, show the owner one keep / adopt / change table for every upstream change to the screen. Search upstream by behavior and files, not by keyword (upstream calls speech-bubble-like boxes "conversation cards").

## The owner's setup

| Setting | Value | Where |
|---|---|---|
| Pi theme | `sakura-unificado` | `~/.pi/agent/settings.json`, `~/.pi/agent/themes/sakura-unificado.json` |
| Card style | `neon` | `~/.pi/gentle-ai/card-style.json` |
| Layout | header on top (draws the IDE chrome: title row above, status bar below), Status on the right, density `minimal` | `~/.pi/gentle-ai/visual-customization.json` |
| Background | transparent: a terminal background image shows through | Windows Terminal and herdr |
| Assistant bubbles | J.A.R.V.I.S. speech bubbles with a tail | personal extension `~/.pi/agent/extensions/assistant-bubbles.ts` |

## Personal pieces and the tests that pin them

| Piece | Behavior | Tests |
|---|---|---|
| No petals | No `✿`, `🌹`, `🌸` or ASCII rose anywhere: chrome, banner, cards, usage view, prompt | `tests/shell-no-petals.test.ts` |
| Rail header | `model · effort · agent profile`, `ctx` gauge and cost, `≡ commands [alt+k]`, `◔ usage [alt+u]`, clickable | `tests/shell-personal-rail.test.ts` |
| Breaks | Yellow card pinned under the header: Agua, Descanso, Estirar with clickable `↻` resets, Cena countdown, big clock and date | `tests/shell-personal-rail.test.ts`, `tests/shell-wellness.test.ts` |
| Tabs | Activity (Agents, Jobs, Todos), Sessions (Otras sesiones), Resources (Limits), Status (Changes, Review, Stats, Integrations); click to switch | `tests/shell-personal-rail.test.ts` |
| Cards | Rail sections as the transparent surface's conversation cards in the active style (neon): mixed-case amber title with its detail after a dot (`▾ Agents · 1 running · 1 waiting`), the same in every tab including Otras sesiones and Limits; a click on the title row or `▾` folds; a blank row between cards at every density | `tests/shell-personal-cards.test.ts`, `tests/shell-sidebar-tabs.test.ts` |
| Transparent rail | The default surface paints nothing in the rail (pinned header, Breaks, tabs, cards, gaps) so the terminal background image shows through; `tinted` stays available | `tests/shell-personal-cards.test.ts`, `tests/shell-sidebar-tabs.test.ts` |
| Limits | One block per provider in Resources; one Claude block (no duplicate `claude-bridge`) | `tests/shell-usage.test.ts`, `tests/shell-usage-card.test.ts` |
| Otras sesiones | Other live sessions: name, age, agent count, inactive count, last seen | `tests/shell-session-state*.test.ts` |
| Hide panel | `» hide panel · alt+h` as the last rail row | `tests/shell-personal-rail.test.ts` |
| Folded rail | With the rail folded (alt+h, `« panel`) at full width: a framed editor with `≡ commands · alt+k` at the left and `« panel · alt+h` at the right of its top border; below it the Sesión card (path and branch, ctx, memory line, YOLO line, model · effort · profile, cost, `◔ usage`, `Permissions`) beside the Breaks card with its `↻` resets and clock. No top header, bottom status row, standalone Breaks or YOLO line repeats it; the Todos card stays hidden | `tests/shell-folded-band.test.ts`, `tests/gentle-shell.test.ts` (`S18`) |
| Narrow layout | Top bar with model, ctx, cost and usage; work line above the editor (a tap opens the panel sheet); the rose framed editor box with `≡ commands · alt+k` at the left of its top border and `[ Panel ]` at the right only when it fits whole (neon style; float keeps the panel rule); Breaks below the editor; cards shown down to 43 columns | `tests/shell-narrow-editor.test.ts`, `tests/shell-personal-prompt.test.ts`, `tests/gentle-shell.test.ts` (`S19`) |
| Dead code gate | `pnpm run check:unused` fails on new unused imports or locals | `tests/check-unused.test.ts` |

Accepted losses: the Background card (Agents and Jobs cover it) and the visible `ctrl+shift+t` hint.

## History

The feature document `odd/tasks/shell-personal-rework.md` records every decision, with the owner's words, from the 2026-11-05 merge of upstream's shell IDE rework.
