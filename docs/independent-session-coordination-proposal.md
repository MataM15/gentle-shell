# Independent sessions: a portable coordination proposal

## Proposed outcome

For [#1979](https://github.com/Gentleman-Programming/gentle-shell/issues/1979), adopt a minimum portable playbook: discover independent sessions, assign bounded lanes, route questions to the authorized decision-maker, and verify fresh evidence before completion. This is a **documentation-only proposal**, not an active skill or runtime protocol. No adapter is shipped; no daemon, store, approval subsystem, personal configuration, or automatic grants are added.

## Quick path

1. Agree a sanitized shared brief: goal, coordinator, lane owners, stable session IDs, verified worktrees/branches, exact allowed surfaces, baseline, dependencies, proof, and delivery boundaries.
2. Publish native subject/state; discover peers and consult their metadata. Resolve unknown ownership before edits; a directory is not an exclusive ownership claim.
3. Assign one correlated task per lane. Use managed children when native parent notifications are needed; independent sessions require an explicit, separately validated transport.
4. Record questions, authorized answers and follow-ups. Park dependencies visibly; escalate human-only decisions instead of inventing permission.
5. Reconcile after interruption or baseline changes; verify latest-assignment evidence and remaining delivery. Close only an explicitly authorized, owned, finished, inactive, clean lane with no pending work.

## Ownership and authority

| Boundary | Rule |
|---|---|
| Identity | Full stable session routing ID identifies the recipient; Initial/Current aliases, human names, pane IDs and workspace labels are display or transport hints, not authority. Rebind after session replacement. |
| Workspace | Verify canonical Pi cwd, Git common directory, linked-worktree membership, actual branch, dirty state and exact allowed surfaces before assignment and on resume. Shell `cd` does not change Pi's session cwd. |
| Ownership | Explicit lane assignment defines edit ownership, not cwd or registration. Discover possible overlap; no-match searches and incomplete catalogs never prove absence of another writer. Preserve unrelated changes. |
| Coordinator | May answer only within existing scope and delegated authority. An owner cannot grant authority they do not hold. Uncertain permissions, product choices, destructive actions or delivery decisions go to the human. |
| Consent | Task transport, edit permission, review consent, review verdict, commit, push, merge and completion are separate decisions. A delegation grant is not a review or delivery grant. |
| Safety | Never parse terminal dialogs to decide consent or autoapprove grants. No automatic grant or closure; never delete worktrees, branches or reports as coordination cleanup. |

## Native foundation versus optional adapters

See [Gentle Shell orchestration and background jobs](gentle-shell.md) and [discovery, publication and consultation](gentle-agents-activity.md).

| Capability | Native today | Optional proposal / limitation |
|---|---|---|
| Discover identity/context | `orchestrator_session_id`, `orchestrator_list`; stable IDs, recorded scope, Initial/Current aliases and curated state | No extra native registry. Labels/pane locations cannot replace routing IDs; reachability/coverage can be unknown. |
| Read public context | `orchestrator_consult` metadata: `published_snapshot`, `ownerReply: false`, `authority: none` | A snapshot is not an owner response or grant. Opt-in helper reasoning gives advice, not an owner decision. |
| Notify independent peers | `orchestrator_send_message`: explicit interactive human consent, bounded notification/ACK | ACK means accepted for delivery, not read or completion. No native correlated owner-question/answer protocol, offline queue or automatic retry. |
| Coordinate managed children | Native parent queries/replies correlate requests; timeout/disconnect/stop settle once. Background results notify/wake their live parent | These are owned child tasks, not independent sessions. Query timeout is not an answer or permission. |
| Control independent terminal sessions | No Herdr adapter declared supported here | Herdr may provide task transport after version-specific validation; do not assume automatic parent wakeup or native child settlement. |
| Preserve reports | Native curated snapshots already carry bounded public status | Optional authorized durable reports are evidence artifacts, not an extra native session registry or approval database. |

Publish before work beyond small direct tasks and refresh at task changes/completion, not per tool/token. Native subject-only publication does not refresh old state timestamps. A state object replaces the snapshot; retain all intended public fields. Example native input (public, no private prompts):

```json
{"subject":"Catalog lane","state":{"objective":"Define catalog labels","progress":"A1 assigned; next: resolve Q1 before edits","decisions":"No delivery authorized","blockers":"NEEDS Q1 owner answer"}}
```

Consult by full `recipient_session_id`. Native `recordedAt` and scope `resolvedAt` are historical; a heartbeat does not refresh them. Use metadata first; request an actual owner decision only when needed. Do not route a free-form question through metadata mode or treat helper reasoning as consent.

## Optional Herdr launch handshake

**Conceptual, version-specific recipe; not live-validated compatibility or support.** Inspect the installed Herdr/Pi command contract in an isolated runtime before translating this recipe into executable CLI flags. These are named operations, not copy/paste shell commands; workspace/pane/agent selectors and structured-input syntax vary by version.

| Step | Operation and required observation |
|---|---|
| 1 | Create an explicit Herdr workspace with worktree-cwd `/workspace/demo-worktrees/catalog` (an existing, authorized linked worktree). Do not use a default workspace or infer isolation from its name. |
| 2 | Read back the canonical cwd and actual pane ID; compare Git common directory, branch and allowed surfaces with the brief. Record workspace ID, pane ID and stable session ID separately. |
| 3 | Start Pi in that verified pane **WITHOUT an initial task prompt**. Observe agent registration/readiness; a terminal prompt alone is not proof of registered agent readiness. |
| 4 | Only after readiness, use the installed `herdr agent prompt` operation with a structured assignment envelope: `{"recipient_session_id":"11111111-1111-4111-8111-111111111111","assignment_id":"A1","task":"Define catalog labels","cwd":"/workspace/demo-worktrees/catalog","branch":"task/catalog","allowed_surfaces":["src/catalog.ts","tests/catalog.test.ts"],"request_id":"T-A1","baseline":"fixture-v1"}`. Bind it to the verified Herdr agent/pane selector. |
| 5 | Observe acceptance and then working for that target/assignment; preserve the receipt and observation time. ACK/working/idle are not task completion. Require a correlated report and checked effects. |

Failure handoff (exact illustrative envelope; change only observed values):

```json
{"status":"transport_unknown","assignment_id":"A1","request_id":"T-A1","recipient_session_id":"11111111-1111-4111-8111-111111111111","workspace_id":"workspace-catalog","pane_id":"pane-7","expected_cwd":"/workspace/demo-worktrees/catalog","observed_cwd":null,"stage":"readiness","observed_at":"2030-01-01T09:00:00Z","receipt":null,"reason":"No registered ready agent observed within the authorized deadline","next":"Stop dispatch; reconcile identity/cwd/receipt before any explicit retry","effects":"unknown"}
```

Missing/wrong cwd, registration, receipt or working evidence stops dispatch at that stage. If a prompt may already have been admitted, do not blindly resend or create a duplicate assignment: inspect current identity, receipt and work first, then obtain an explicit retry decision if needed. A failed observation is not proof of no effects. Do not guess a callback from terminal state.

## Two-lane example: assignment to evidence-backed done

**All IDs, paths, times, baselines and evidence below are sanitized fictional fixtures, not observed execution.** These envelope fields are proposed playbook records, not new native tool arguments. They may travel in an explicitly authorized message or report; a model-created `ANSWER` is not a runtime grant.

Shared brief, verified at assignment:

| Item | Exact example |
|---|---|
| Goal / authority | Document catalog labels; coordinator may choose existing labels and request corrections. Human alone decides product expansion and delivery. Editing only is authorized; review, commit, push and merge are not. |
| Coordinator | `00000000-0000-4000-8000-000000000000` (C); coordinates both lanes, owns neither lane's edits. |
| Lane A / display | `11111111-1111-4111-8111-111111111111` (A); Current alias `Catalog lane`, pane `pane-7`. |
| Lane B / display | `22222222-2222-4222-8222-222222222222` (B); Current alias `Guide lane`, pane `pane-8`. |
| Linked worktrees | A: `/workspace/demo-worktrees/catalog`, branch `task/catalog`; B: `/workspace/demo-worktrees/guide`, branch `task/guide`; both verified against common dir `/workspace/demo/.git`. |
| Allowed surfaces | A: `src/catalog.ts`, `tests/catalog.test.ts`; B: `docs/catalog.md`. No cross-lane edits or writes to the shared base checkout. |
| Baseline / proof | Both start from verified `fixture-v1`, clean. A proof: `pnpm exec tsx --test tests/catalog.test.ts`, actual effects and output log. B proof: document inspection against the accepted A output and exact allowed diff. Test recipe is fictional, not this repository's validation command. |
| Dependency / reports | B depends on coordinator-verified A labels, not a blind merge. Reports are authorized messages; durable copies require a separately approved location/writer, never an implicit shared writable directory. |

The sequence below is exact: each line names its sender, recipient, timestamp, assignment/follow-up and request correlation. Every report also carries the brief's stable session ID, verified cwd/branch, baseline and allowed surfaces; labels alone never select recipients.

```text
2030-01-01T09:01:00Z C -> A ASSIGN A1 request=T-A1 baseline=fixture-v1: define labels; edits/proof only.
2030-01-01T09:01:01Z C -> B ASSIGN B1 request=T-B1 baseline=fixture-v1: document accepted A labels; wait for A proof.
2030-01-01T09:02:00Z A -> C NEEDS A1 request=Q1: use existing label "standard" or "basic"? No edits until answered.
2030-01-01T09:02:01Z B -> C WAIT_DEPENDENCY B1 request=W1 depends_on=A1: intentionally parked; Q1 remains NEEDS.
2030-01-01T09:03:00Z C -> A ANSWER A1 request=Q1 answer_id=D1: "standard"; within existing labels/authority; no new grants.
2030-01-01T09:04:00Z A -> C DONE A1 request=T-A1 report=R-A1 baseline=fixture-v1: effects=standard exported; proof=1/1 pass, exit=0, log=L-A1; delivery=not authorized.
2030-01-01T09:05:00Z C -> A FOLLOW_UP A2 supersedes=A1 follow_up=F1 request=T-A2: add missing fallback case; same surfaces/authority.
2030-01-01T09:05:01Z C -> B FOLLOW_UP B2 supersedes=B1 follow_up=F2 request=T-B2: depend on A2; remain parked until proof verified.
2030-01-01T09:06:00Z A -> C DONE A2 follow_up=F1 request=T-A2 report=R-A2 baseline=fixture-v1: effects=standard + fallback; proof=2/2 pass, exit=0, log=L-A2; delivery=not authorized.
2030-01-01T09:07:00Z C -> B ANSWER B2 request=W1 answer_id=D2: A2 effects/diff/log verified; accepted labels fixture-v2 available read-only; resume B2, no merge authorized.
2030-01-01T09:08:00Z B -> C NEEDS B2 request=Q2: may guide promise a new premium tier? blocked human-only product decision; unaffected edits may continue.
2030-01-01T09:09:00Z C -> HUMAN ESCALATE B2 request=Q2: choose existing labels only OR approve separate product scope; recommend existing labels only.
2030-01-01T09:10:00Z HUMAN -> C ANSWER B2 request=Q2 answer_id=H1: existing labels only; no scope expansion/delivery.
2030-01-01T09:10:01Z C -> B ANSWER B2 request=Q2 answer_id=D3 source=H1: existing labels only; existing edit scope unchanged.
2030-01-01T09:11:00Z B -> C DONE B2 follow_up=F2 request=T-B2 report=R-B2 baseline=fixture-v1 dependency=fixture-v2: effects=standard/fallback documented, no premium; proof=diff + content checked, no executable test claimed; delivery=not authorized.
```

C checks the actual expected export/fallback and allowed diff, reads `L-A2` for command, cwd, tested revision, count and exit status, and inspects B's document against the accepted A effects. A claimed exit=0 or empty diff alone is not proof. Record any unavailable evidence as unknown; request it instead of accepting `DONE`. Fixture-v2 means accepted read-only A output, not a change to B's Git baseline or automatic permission to merge branches.

### Freshness and state rules

| Record or observation | Interpretation / counterexample |
|---|---|
| ASSIGN / FOLLOW_UP | Timestamp, assignment ID, request ID, sender/recipient IDs, scope and baseline are mandatory. Follow-ups also carry follow-up ID and superseded assignment. Latest assignment invalidates older DONE: `R-A1` cannot satisfy `A2`; `R-B2` cannot satisfy a later `B3`. |
| NEEDS / ANSWER | Question ID and answer reference must match the current assignment (or explicitly reconcile a preserved dependency question like W1). Reject wrong recipient, unrelated/old question or unverified decision source. Snapshot `decisions`, helper advice and ACK are not authorized answers. |
| WAIT_DEPENDENCY | Preserve dependency ID, reason, owner and resume condition. Intentional parking is not DONE and must not hide NEEDS/blocked. W1 is explicitly carried from B1 to B2; it is not silently answered on a stale assignment. |
| DONE | A report candidate, not coordinator acceptance. Timestamp and report ID must bind latest assignment/follow-up/request, baseline, effects, test exit/log or non-test proof, remaining risks and delivery. Partial/stale/incomplete evidence stays unknown or needs follow-up. |
| Transport status | ACK, working and idle say nothing about correctness, edit ownership, human consent or completion. A busy owner can still expose an old snapshot. |

Optional durable reports use these same timestamped correlation records, supersede rather than erase history, and stay inside separately authorized report surfaces. They are not needed for native discovery and confer no grant. Never store private prompts, credentials, internal instructions or personal model/trust/database/grant preferences in the brief or reports.

## Dependency parking, interruption and resumption

- Park only the dependent work, publishing `WAIT_DEPENDENCY` and any distinct NEEDS/human block. Name the baseline change or verified artifact that resumes it; continue unrelated authorized work if safe. Do not consume a missing/stale dependency as success.
- When the dependency/baseline changes, recheck ownership and effects, issue a correlated follow-up if the assignment changed, and rerun invalidated proof. Old test logs cannot validate a newly edited tree.
- External waits use a supported host background wait with an explicit bounded condition/deadline; record job ID, expected event and timeout outcome, then end the turn or do safe independent work. Do not prescribe blocking polling, guess callbacks or assume Herdr will wake C. Without a validated event path, hand off a pending wait and schedule explicit reconciliation.

Interruption example: C stops after A2 dispatch and before consuming `R-A2`. On resumption C does **not** replay `T-A2` or trust `R-A1`:

1. Reconcile current C/A/B session identities and activations, canonical Pi cwd, worktree/common-dir/branch, actual dirty state, lane ownership and pending requests/jobs. Session replacement requires explicit rebind, not alias matching.
2. Read latest assignments A2/B2 and reports, source timestamps and receipt status. Missing, stale or incomplete data is unknown, not inactivity, failure, refusal or completion.
3. Verify `R-A2` effects/log at the reported revision. Preserve W1, Q2 and any unknown transport result; resume B2 only after D2 and handle Q2 through H1. If the baseline changed during interruption, publish a new follow-up and rerun invalidated proof before accepting done.
4. Reconcile pending review/delivery separately; report the next action and human decisions. Never reconstruct consent from a terminal screenshot, snapshot or old helper suggestion.

## Completion is not closure or delivery

`R-A2` and `R-B2` can establish scoped work done only after evidence review; their modified worktrees still have uncommitted changes and no review/delivery grants. C reports both scoped outcomes and remaining review/commit/push/merge decisions; it does not mark the initiative delivered or close their sessions automatically.

Closure requires **explicit authorization** and independently verified ownership, finished latest work, inactivity and clean state, with no queued, pending, review or delivery work. An idle pane or clean worktree alone is insufficient. Pending human decisions or dependency waits keep the lane open/parked. Recheck immediately before any authorized closure; closure never includes deletion of worktrees, branches or reports.

## Lessons from the personal reference adapter

These findings concern the personal Herdr adapter, **not demonstrated defects in gentle-shell**. They motivate portable requirements, not importing its scripts or owner-specific grants.

| Observed gap | Portable lesson / verification boundary |
|---|---|
| Approval records used an unbracketed UTC prefix, while the signal waiter recognized only bracketed coordinator records. Handled signals could remain pending. | Use one canonical record format across every writer/reader and preserve documented legacy input on resume. Offline regressions reproduced the mismatch and verified that handled signals disappear while fresh signals still surface. This is not a claim about native transport ACK handling. |
| Automatic approvals were recorded only in lane-owned reports, despite an instruction requiring a separate coordinator log. | Keep decision audit evidence independent of reports a lane may replace. The correction records both approval paths in a coordinator-owned log with a status copy, and refuses confirmation when the audit sink cannot be opened. UI submission and logging are not atomic; post-submission I/O failures require reconciliation. |
| The delivery playbook prescribed idle-triggered Enter and terminal text delivery, conflicting with the verified launcher; its repeated-review advice also conflicted with the skill's stop rule. | Maintain one authoritative operational contract across launcher, watcher and playbook. Align structured follow-ups, bounded waits and escalation rules; reject shortcuts that contradict the approved contract. Documentation checks establish consistency, not live model compliance. |

The corrected personal adapter passed 53 offline lane tests using fake Herdr/Git, plus Bash syntax checks. An independent read-only review found no blockers. Live interoperability and injected post-submission I/O failures were not tested; these results do not establish a supported adapter.

A stale consent-expiry instruction was also updated: [#1982](https://github.com/Gentleman-Programming/gentle-shell/pull/1982) had already removed the pending-consent response deadline upstream. This was local documentation drift, not a new upstream defect; single-use and session/candidate checks still apply.

## Evidence limits and issue situation

Parent-provided investigation snapshot, not a fresh network check: #1979 is open with no implementation PR found; [#1996](https://github.com/Gentleman-Programming/gentle-shell/issues/1996) was addressed by merged [#1998](https://github.com/Gentleman-Programming/gentle-shell/pull/1998), and Initial/Current aliases plus prework publication are already documented locally. [#1701](https://github.com/Gentleman-Programming/gentle-shell/issues/1701) supplied the merged discovery foundation. [#1702](https://github.com/Gentleman-Programming/gentle-shell/issues/1702) remains open for correlated owner decisions; its existing publication/consultation slice is not that complete protocol.

Local documentation supports the native distinctions above; it does not prove live Herdr/Pi interoperability. Missing native runtime is a separate future unit: correlated independent-owner requests/answers, admission/authority rules, settlement and recovery. This proposal does not implement it or disguise messages/reports as that runtime.

The focused docs-contract test checks structure, local links, correlation examples and counterexamples. It is **structural proof, not model obedience or live proof**. No fresh live validation was performed; no adapter is declared supported.

## Focused acceptance checklist and next steps

- [ ] S1: Review proposed outcome, quick path and exact ownership/authority boundaries; no activation or extra registry.
- [ ] S2: Verify native versus optional matrix, snapshot/helper limitations and managed-child versus independent notification semantics.
- [ ] S3: Review sanitized two-lane correlation, human-only block, authorized answer, follow-up freshness, actual effects/log proof and remaining delivery.
- [ ] S4: Review launch/readiness handshake, unknown/failure handoff, no duplicate dispatch and stable ID versus pane/cwd verification.
- [ ] S5: Exercise parking, baseline invalidation, interruption/reconciliation and explicit clean/inactive/no-pending closure rules without deletion.
- [ ] S6: Run `node --experimental-strip-types --test tests/independent-session-coordination-proposal.test.ts`; treat success only as a docs contract.

Next: maintainer reviews this proposal for #1979. Separately authorize an isolated runtime exercise using recorded installed Herdr/Pi versions and native consent UI; test readiness, wrong cwd, ambiguous transport, question correlation, interruption and baseline invalidation before claiming any adapter supported. Scope missing native runtime independently. Do not install, launch, change personal configuration or grant delivery merely because this proposal is accepted.
