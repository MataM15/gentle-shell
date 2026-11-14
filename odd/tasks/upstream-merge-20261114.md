Upstream merge 2026-11-14: bring Gentle Shell upstream main (f4cc69a33 -> 3dc902975, 329 commits) into personal/main (4322a6113, 216 personal commits) in the integration worktree, keeping the owner's design.
Live checkout /home/pablo/proyectos/gentle-shell stays untouched until the final fast-forward. Backup: ~/.local/state/pi-herdr-backups/20261114T160220Z-pre-update-shell-ai-engram/.
Merge analysis evidence: /tmp/gpr6PSOv/shell-merge-evidence/ (conflict diffs, upstream patches per file).

## Specs

- S1. Design principle (owner, 2026-11-05): "me gusta el diseño que tenemos ... habría que tratar de mantenerlo". The owner's look wins for visuals and layout; upstream wins for functionality and performance. docs/personal-design.md is the design contract; its tests must pass.
- S2. Working label: adopt upstream 8166e3e36 time-based wave and 80 ms repaint applied to the owner's flower-free text scan (`workingFrameOf`); never petals.
- S3. Limits: keep the personal all-provider Limits refresh in the rail, including the Claude OAuth usage fetch. Adopt upstream's Desktop usage RPC unchanged, as upstream defines it (lib/desktop-rpc-usage.ts, lib/desktop-usage-service.ts and docs/desktop-rpc.md stay upstream's): Desktop reconciliation of Anthropic refreshability is out of scope.
- S4. Session start: keep the personal session and voice resets; adopt upstream 676ffb4e9 (NaN rail shows the selected thinking level, retired quotas filtered) and do not restore the removed adaptive-reasoning notice.
- S5. Skill registry: adopt upstream's disk-only registry and session-local effective prompt; keep the personal stale-watcher generation/timer/notify safety.
- S6. Owner decision on long agent answers, verbatim choice: "Desplegada se ve completa (Recomendado)" — "Mantengo el recorte para ahorrar contexto, pero al desplegar ves todo". Context and collapsed card stay capped; the expanded card shows the full answer.
- S7. Owner decision on the design canvas focus, verbatim choice: "Ancho completo y las demás atenuadas (Recomendado)" — "Tomo el tamaño nuevo de upstream pero mantengo tu fondo atenuado". Adopt upstream's split canvas modules and full-width focus sizing; other boards stay dimmed (not hidden) while one is focused.
- S8. Canvas: keep the personal behavior that a world re-layout while focused (for example the system board appearing) re-centers the focused board; port its test to upstream's module fixtures.
- S9. All other upstream visible changes are adopted (canvas icon rail, shortcuts, movable boards, minimap, all sizes, export, quality tab, i18n; review forecast and reviewer progress cards in flower-free chrome; Pi 1.5.2 editor fixes; job notices across sessions; permission wording; profile edits retained).
- S10. Remaining conflicts: lib/agents-runner.ts takes upstream's import; lib/shell-usage.ts unions the personal sanitized account failures with upstream's NaN advisory; tests keep the personal no-flower and S18-S21 assertions while adopting upstream's isolation and cadence tests.
- S11. Before fast-forward: full suite passes (failures also present on pristine upstream are pre-existing), personal design tests pass, a before/after render of the owner's rail goes to the owner, and the owner approves the fast-forward.

## Tasks

- T1. S2-S6, S10: resolve non-canvas conflicts (gentle-shell.ts, skill-registry.ts, agents-runner.ts, shell-usage.ts, gentle-agents.ts expanded view, tests). Route: gentle-ai-worker. Commit: merge commit.
- T2. S7-S9: resolve canvas conflicts (assets/design-canvas/**, tests/design-canvas-*.test.ts). Route: visual (Sonnet 5.5). Commit: merge commit.
- T3. S11: full suite, pristine comparison, personal design tests, before/after render. Route: parent.
- T4. S11: owner approval, merge commit, fast-forward personal/main, restart. Route: parent.

## Log

- L1 (owner, 2026-11-14, verbatim): "escuchame ya que estamos fijémonos de actualizar gentle shell gentle i engram bien y bueno siempre como hacemos de verde porque va a ese pide zinc bien todo eso en todo caso luego de actualizar bueno primero ojo lo que siempre te digo de ver de hacer el respaldo bueno vos fíjate como cómo se hace bien y para que una vez actualizado se mantenga por lo menos la interfaz y lo que siempre hacemos que comparamos a ver las mejoras que trae lo que tenemos nosotros las mejoras que tenemos nosotros en local"
- L2: owner chose main for Gentle AI and Shell, latest stable for Engram, binary and Engram DB backups, and to wait for the voice fixes before the Shell merge. Done: backup verified, Gentle AI 4.5.0 (f2f7d7b16) installed and synced, Engram 3.7.2 running. gentle-engram 0.8.0 waits for pnpm minimumReleaseAge (after 21:23 Córdoba).
- L4: T1 worker stopped: reconciling Desktop RPC with the personal Claude fetch needs upstream-owned files and would contradict upstream's documented Desktop contract. That clause was the parent's inference, not an owner request, so S3 now adopts upstream Desktop RPC unchanged and keeps the personal rail Limits. Worktree lacked node_modules; parent installs with `pnpm install --frozen-lockfile --ignore-scripts` (skips the postinstall that installs a package-local gentle-ai).
- L3: voice fixes landed in personal/main 4322a6113. Trial merge: 9 conflicted files. Owner decisions S6 and S7 recorded verbatim above.
