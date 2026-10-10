# Palette button: clickable command palette entry points

Add mouse entry points to the Gentle Shell command palette (today Alt+K / `/gentle:commands`) in fullscreen mode.
Branch `feat/palette-button`, worktree `/home/pablo/proyectos/gentle-shell-worktrees/palette-button`. Approved mockups: `/mnt/c/Users/pablo/Pictures/pagub-review/palette-icon/v3/` (A3.png, C3.png, contact-sheet-v3.png).

## Specs

- **S1 (A3, rail card actions).** User: "me quedo con A3". In the right rail "✿ Gentle Shell" header card, replace the current `usage · alt+u` row with a dim dotted rule followed by two aligned action rows, as in mockup A3:
  - `☰ commands   [alt+k]`
  - `◔ usage      [alt+u]`
  Labels use the theme accent role, key hints and the rule use the dim role; the icon column and the key column align across both rows. User's complaint about the old row (verbatim): "eso de usage queda horrible".
- **S2 (A3 clicks).** A left click on the `commands` row opens the command palette exactly like Alt+K / `/gentle:commands`. A left click on the `usage` row opens the usage view exactly like Alt+U / `/gentle:usage` (current behavior preserved).
- **S3 (A3 key hints).** Key hints show the actually resolved shortcut (`GENTLE_PI_COMMANDS_KEY`, `GENTLE_PI_SHELL_USAGE_KEY` remaps); when a shortcut is disabled the row shows no key hint. When `visibility.usageCost === false` the usage row is omitted (existing opt-out preserved) and the commands row remains.
- **S4 (C3, editor border label).** User: "A3 siempre visible y C3 solo cuando no está el panel lateral" (agreed: "ok dale"). On the input editor top border, next to the `✿` petal, render `✿ ☰ commands · alt+k` (resolved key; no key hint when disabled) ONLY when the right rail is not visible (`sidebarState(tui)` active && ownsHost false/absent, e.g. terminal < 140 columns or non-fullscreen). When the rail is visible the editor border is unchanged. Spacing: one cell between petal, icon, and label so they do not look cramped (user: "no queda muy alineado ... siento que no queda estetico"). Float card style gets the equivalent treatment in its hint row.
- **S5 (C3 click safety).** User concern (verbatim): "no se si cuando quiera hacer clic en el cuadro de dialogo y accidentalmente cliclee mal pueda abrir ese panel..". Only the `☰ commands` label cells on the border row are clickable; only a clean `click` event (press and release on the same cell, no drag) opens the palette; clicks on the input text rows and drags keep native editor behavior.
- **S6 (no regressions).** Existing behavior preserved: Alt+K, Alt+U, `/gentle:commands`, `/gentle:usage`, rail breakpoint transitions, stale-geometry guards, editor petal/state/scroll labels, foreign-editor ownership refusal.

## Tasks

- **T1** S1, S2, S3, S6 — rail card action rows + per-row hit geometry + tests. Route: `visual-opus` (Sonnet 5.5) WRITE. Commit: f57f33bbb. Done (focused 375/375, `pnpm test` 5730 pass / 0 fail; one earlier run printed `# fail 2`, not identified).
- **T2** S4, S5, S6 — editor border label when rail hidden + click handling + tests. Route: `visual-opus` (Sonnet 5.5) WRITE. Commit: pending (parent). Done: border label + clean-click hit, focused 297/297, `pnpm test` 5741 pass / 0 fail.
- **T3** S1, S4 — rendered check at wide (rail) and narrow (no rail) widths compared against mockups A3/C3; user visual approval. Route: parent + user. Commit: none.

## Log

- **L1** (user, original requests, verbatim): "Entiendo que algunas funciones se utilicen así con barra o sea tipo Comando digamos no Pero no hay una forma de hacerlo más sencillo quizá más interactivo agregándole botones o alguna de esas funciones así Y en todo caso ir configurando clasificando según lo que hace cada 1 de la de los comandos y bueno lo hacemos más interactivo digamos" / "ok dale.. pero mejor utiliza odd.. porque ya veo que por noi hacer una exploracion no te diste cuenta de todo el panorama" / "ah ahi lo vi con alt+k.. pero no se puede agregar un icono que la despliegue?"
- **L2** Mockups: round 1 rejected (redrawn UI, invented footer); round 2 composited on user's screenshot; round 3 approved: "uffff SEXYY, me quedo con A3 y tengo dudas si quedarme con C3 porque no se si cuando quiera hacer clic en el cuadro de dialogo y accidentalmente cliclee mal pueda abrir ese panel..". Resolution agreed: "ok dale" to A3 always visible + C3 only when rail hidden.
- **L3** Exploration evidence: rail header `lib/shell-bar.ts:390` (`renderShellRailHeader`), usage row `:409-418`, hit `shellHeaderUsageHit` `:375`; rail mouse handler `extensions/gentle-shell.ts:1953-1961`; openers `showCommandPalette` `:1365`, `openUsage` `:1722`; key resolvers `lib/command-palette.ts:353-356`, `extensions/gentle-shell.ts:1279-1283`; rail visibility `sidebarState(tui)` `lib/shell-sidebar.ts:49` + `ownsHost()` `lib/shell-sidebar-layout.ts:123`, breakpoint 140 cols; editor border `GentlePromptEditor.render` `extensions/gentle-shell.ts:1053`, `topRule` `lib/shell-prompt.ts:109-119`, float `:195-218`; clean click synthesized by pi-tui (`tui-alt-screen.js:704-723`).
- **L5** T1 result: `☰` measures 2 cells in pi-tui `visibleWidth` (East Asian Wide), so the icon column is 2 cells and `◔` is padded (`◔  usage`). Alternative `≡` (1 cell) pending user decision at T3. The rail usage row no longer shows gauge text; gauges remain in the Limits card.
- **L4** Parent decisions (reported to user): key hints honor remap/disable; `usageCost=false` hides only the usage row; colors from theme roles (accent/dim).
- **L6** T2 result: `framePromptChrome` (`lib/shell-prompt.ts`) paints `✿ ☰ commands · key` (neon top rule / float hint row, span cols 5..24 at default key, narrowed by the parent to cols 5..15 (`☰ commands` only; the key hint is not clickable, per S5); dropped when it cannot leave one rule cell); `GentlePromptEditor` (`extensions/gentle-shell.ts`) shows it per render only in fullscreen with `!(sidebarState.active && ownsHost())`, hidden in regular mode (no mouse), and opens `showCommandPalette` on a `click`/left/row 0/in-span/same-width event; all else falls to native. The whole label incl. key hint is the hit area. Tests: 5 prompt + 6 shell.
