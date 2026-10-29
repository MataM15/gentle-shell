import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const proposalPath = join(root, "docs/independent-session-coordination-proposal.md");
const proposal = () => readFileSync(proposalPath, "utf8");

test("independent coordination is a passive proposal with an outcome and quick path", () => {
	const doc = proposal();
	assert.match(doc, /^# Independent sessions: a portable coordination proposal/m);
	assert.match(doc, /documentation-only proposal/);
	assert.match(doc, /No adapter is shipped/);
	assert.match(doc, /## Proposed outcome[\s\S]*## Quick path[\s\S]*## Ownership and authority/);
	assert.match(doc, /https:\/\/github\.com\/Gentleman-Programming\/gentle-shell\/issues\/1979/);
});

test("local Markdown links resolve and the proposal stays bounded and sanitized", () => {
	const doc = proposal();
	const localLinks = [...doc.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
		.map((match) => match[1]).filter((link) => !/^https?:/.test(link));
	assert.ok(localLinks.length >= 2);
	for (const link of localLinks) {
		const target = resolve(dirname(proposalPath), link.split("#")[0]);
		assert.ok(target.startsWith(root + sep), `Link remains in repository: ${link}`);
		assert.ok(statSync(target).isFile(), `Local link resolves: ${link}`);
	}
	assert.ok(doc.split("\n").length <= 250);
	assert.doesNotMatch(doc, /\/home\/|~\/|\.env\b|BEGIN .*PRIVATE KEY/);
	assert.match(doc, /sanitized fictional fixtures, not observed execution/);
});

test("native snapshots, helper advice, notifications and independent transport have distinct authority", () => {
	const doc = proposal();
	for (const tool of ["orchestrator_session_id", "orchestrator_list", "orchestrator_consult"]) {
		assert.ok(doc.includes(tool));
	}
	assert.match(doc, /ownerReply: false.*,.*authority: none/);
	assert.match(doc, /snapshot is not an owner response or grant/);
	assert.match(doc, /advice, not an owner decision/);
	assert.match(doc, /timeout\/disconnect\/stop settle once/);
	assert.match(doc, /do not assume automatic parent wakeup or native child settlement/);
	assert.match(doc, /No native correlated owner-question\/answer protocol/);
	assert.match(doc, /heartbeat does not refresh them/);
	assert.match(doc, /Task transport, edit permission, review consent, review verdict, commit, push, merge and completion are separate decisions/);
});

test("Herdr recipe requires ordered readiness, correlated dispatch and exact unknown handoff", () => {
	const doc = proposal();
	const launch = doc.split("## Optional Herdr launch handshake")[1].split("## Two-lane example")[0];
	assert.match(launch, /Conceptual, version-specific recipe; not live-validated compatibility or support/);
	assert.match(launch, /Create an explicit Herdr workspace[\s\S]*Read back the canonical cwd and actual pane ID[\s\S]*WITHOUT an initial task prompt[\s\S]*Observe agent registration\/readiness[\s\S]*herdr agent prompt[\s\S]*Observe acceptance and then working/);
	assert.match(launch, /ACK\/working\/idle are not task completion/);
	assert.match(launch, /do not blindly resend or create a duplicate assignment/);
	const envelopes = [...launch.matchAll(/```json\n([^`]+)\n```/g)].map((match) => JSON.parse(match[1]));
	assert.equal(envelopes.length, 1);
	assert.equal(envelopes[0].status, "transport_unknown");
	assert.equal(envelopes[0].assignment_id, "A1");
	assert.equal(envelopes[0].request_id, "T-A1");
	assert.equal(envelopes[0].observed_cwd, null);
	assert.equal(envelopes[0].receipt, null);
	assert.equal(envelopes[0].effects, "unknown");
	assert.match(envelopes[0].next, /Stop dispatch; reconcile/);
});

test("two linked lanes carry chronological assignments, questions, answers, follow-ups and proof", () => {
	const doc = proposal();
	const flow = doc.match(/```text\n([^`]+)\n```/);
	assert.ok(flow);
	const lines = flow[1].trim().split("\n");
	const times = lines.map((line) => Date.parse(line.split(" ")[0]));
	assert.ok(times.every((time, index) => Number.isFinite(time) && (index === 0 || time > times[index - 1])));
	assert.match(flow[1], /ASSIGN A1 request=T-A1[\s\S]*NEEDS A1 request=Q1[\s\S]*ANSWER A1 request=Q1 answer_id=D1[\s\S]*DONE A1 request=T-A1[\s\S]*FOLLOW_UP A2 supersedes=A1 follow_up=F1 request=T-A2[\s\S]*DONE A2 follow_up=F1 request=T-A2/);
	assert.match(flow[1], /ASSIGN B1[\s\S]*WAIT_DEPENDENCY B1 request=W1 depends_on=A1[\s\S]*FOLLOW_UP B2 supersedes=B1[\s\S]*ANSWER B2 request=W1[\s\S]*NEEDS B2 request=Q2[\s\S]*ESCALATE B2 request=Q2[\s\S]*HUMAN -> C ANSWER B2 request=Q2 answer_id=H1[\s\S]*source=H1[\s\S]*DONE B2 follow_up=F2 request=T-B2/);
	assert.match(flow[1], /proof=2\/2 pass, exit=0, log=L-A2/);
	assert.match(doc, /both verified against common dir/);
	assert.match(doc, /A: `src\/catalog.ts`, `tests\/catalog.test.ts`; B: `docs\/catalog.md`/);
	assert.match(doc, /claimed exit=0 or empty diff alone is not proof/);
	assert.match(doc, /Latest assignment invalidates older DONE/);
	assert.match(doc, /`R-A1` cannot satisfy `A2`/);
	assert.match(doc, /Reports are authorized messages; durable copies require a separately approved location\/writer/);
});

test("parking and recovery preserve unknowns, human blocks and invalidated proof", () => {
	const doc = proposal();
	assert.match(doc, /Intentional parking is not DONE and must not hide NEEDS\/blocked/);
	assert.match(doc, /External waits use a supported host background wait with an explicit bounded condition\/deadline/);
	assert.match(doc, /Do not prescribe blocking polling, guess callbacks/);
	assert.match(doc, /Reconcile current C\/A\/B session identities[\s\S]*latest assignments A2\/B2[\s\S]*Missing, stale or incomplete data is unknown[\s\S]*rerun invalidated proof/);
	assert.match(doc, /Uncertain permissions, product choices, destructive actions or delivery decisions go to the human/);
	assert.match(doc, /Never parse terminal dialogs to decide consent or autoapprove grants/);
	assert.match(doc, /Closure requires \*\*explicit authorization\*\*[\s\S]*ownership, finished latest work, inactivity and clean state, with no queued, pending, review or delivery work/);
	assert.match(doc, /closure never includes deletion of worktrees, branches or reports/);
});

test("personal adapter lessons preserve provenance and verification limits", () => {
	const lessons = proposal().split("## Lessons from the personal reference adapter")[1]
		.split("## Evidence limits and issue situation")[0];
	assert.match(lessons, /not demonstrated defects in gentle-shell/);
	assert.match(lessons, /one canonical record format across every writer\/reader/);
	assert.match(lessons, /handled signals disappear while fresh signals still surface/);
	assert.match(lessons, /not a claim about native transport ACK handling/);
	assert.match(lessons, /decision audit evidence independent of reports a lane may replace/);
	assert.match(lessons, /UI submission and logging are not atomic/);
	assert.match(lessons, /one authoritative operational contract across launcher, watcher and playbook/);
	assert.match(lessons, /53 offline lane tests using fake Herdr\/Git/);
	assert.match(lessons, /Live interoperability and injected post-submission I\/O failures were not tested/);
	assert.match(lessons, /local documentation drift, not a new upstream defect/);
	assert.match(lessons, /https:\/\/github.com\/Gentleman-Programming\/gentle-shell\/pull\/1982/);
});

test("evidence limits and acceptance do not claim runtime or model-obedience proof", () => {
	const doc = proposal();
	assert.match(doc, /Parent-provided investigation snapshot, not a fresh network check/);
	assert.match(doc, /#1979 is open with no implementation PR found/);
	assert.match(doc, /remains open for correlated owner decisions/);
	assert.match(doc, /structural proof, not model obedience or live proof/);
	assert.match(doc, /No fresh live validation was performed/);
	assert.match(doc, /installed Herdr\/Pi versions[\s\S]*before claiming any adapter supported/);
	assert.deepEqual([...doc.matchAll(/- \[ \] (S\d):/g)].map((match) => match[1]), ["S1", "S2", "S3", "S4", "S5", "S6"]);
});
