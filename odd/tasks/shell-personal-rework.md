# Shell personal rework

Merge upstream origin/main 7ecb826a2 (shell IDE rework) into the personal branch `personal/main`, adopting upstream's fullscreen UI, then re-apply the owner's personal design on top of it as approved in `/home/pablo/proyectos/design/shell-personal-rework/` (01-wide.html, 02-portrait.html; PNGs in `C:\Users\pablo\Pictures\pagub-review\shell-rework\personal-0*.png`).
Worktree: `/home/pablo/proyectos/gentle-shell-worktrees/integrate-main-20261105` (branch `integrate/main-20261105`). Pristine reference: `/home/pablo/proyectos/gentle-shell-worktrees/pristine-main-20261105`. Live branch `personal/main` is never edited directly.

## Specs

- S1. Adopt upstream's rework for the whole fullscreen UI (owner choice "1" to: "Adoptar el rework de upstream para toda la UI fullscreen y soltar el rail personal"). Keep personal features that are not the rail: voice, dev-binary notice, Wellness/Breaks logic.
- S2. "pero me gustaria mantener el diseño o mantener lo mejor posible la idea": the approved mockup is the source of truth for the look.
- S3. Wide rail (>=140 cols): starts with the owner's rail header: `claude-fable-5-1 · low`, `ctx ▰▱▱▱▱▱▱▱ 17% ◇ $0.000`, a dotted rule, `≡ commands   [alt+k]`, `◔ usage      [alt+u]`, then a rose rule. The bottom status bar keeps branch, permission mode and the weekly usage gauge, and drops model/effort/ctx/cost (shown once, in the header).
- S4. Wide rail: the yellow "Breaks" card pinned under the header: Agua/Descanso/Estirar rows with their ↻ reset controls (must stay clickable), Cena countdown, large clock and date.
- S5. Wide rail: upstream's sections (TODOS, JOBS, AGENTS, CHANGES, REVIEW, INTEGRATIONS) drawn as neon rounded cards (rose frame, `▾ TITLE` and count inset in the top border; `▾` stays the collapse control). No tabs row. Last rail row `» hide panel · alt+h` (clickable, alt+h works).
- S6. Narrow/portrait (<140 cols): the owner's top bar (model, ctx, cost; `◔ usage 5h … · week … alt+u`), upstream's one-row work line above the editor (tap opens the panel sheet), `≡ commands · alt+k` in the editor's top border, the yellow Breaks card below the editor, status row with branch and mode.
- S7. "y recorda aplicar el tema que tenemos": colors come from the owner's live Pi theme `sakura-unificado` (`~/.pi/agent/themes/sakura-unificado.json`), card style `neon` (`~/.pi/gentle-ai/card-style.json`), visual customization `headerPlacement: top`, `statusPlacement: right`, `density: minimal`. No hard-coded colors outside theme roles.
- S8. Accepted losses (owner approved the mockup with them): the four rail tabs, the Background card, the narrow Todos card (replaced by the work line), the visible `ctrl+shift+t` hint.

## Tasks

- T1 [S1] Resolve the 21 conflicted files adopting upstream for fullscreen UI, keep personal non-rail features compiling; typecheck + focused tests green; commit the merge. Route: gentle-ai-worker. Commit: b22df5194 (merge) + retired rail test stubs.
- T2 [S3,S7] Rail header + status bar de-duplication. Route: visual-opus (Sonnet 5.5). Commit: 1dcd2a628.
- T3 [S4,S7] Breaks card pinned in the wide rail. Route: visual-opus. Commit: 3415bd3e1.
- T4 [S5,S7] Neon card frames for rail sections + hide panel row. Route: visual-opus. Commit: 0cf0ed8fa.
- T5 [S6,S7] Narrow layout: top bar, commands label in editor border, Breaks below editor. Route: visual-opus. Commit: pending.
- T6 Full suite on integration vs pristine, DESIGN vs AFTER sheet at wide and portrait, fast-forward `personal/main`, push to `personal`, delete stale local `main`, owner restarts Pi. Route: parent.

## Log

- L1 (owner, after seeing the merge conflict options): "1.. pero me gustaria mantener el diseño o mantener lo mejor posible la idea osea [screenshot wide rail] asi.. luego si cambia por ej [commands/usage rows] no tengo problema o por ejemplo segun la res si yo lo veo asi en vertical [screenshot portrait]"
- L2 (owner): "Igual me mostraste la interfaz upstream.. no lo que seria con lo mio" → mockup built by visual-opus (Sonnet 5.5), design/shell-personal-rework.
- L3 (owner, approving the mockup): "ok dale.. y recorda aplicar el tema que tenemos"
- L4 Merge state before T1: 21 files with conflicts; 5 lib files (command-palette-catalog, shell-card, shell-prompt, shell-usage, yolo-session-policy) already had markers removed by an earlier worker that died with its session, unverified and not staged.
