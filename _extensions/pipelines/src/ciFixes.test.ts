import { type AgentSummary, ciFixConversationId, type PipelineRun } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { branchFixes, branchKey, fixesByRun } from "./ciFixes";

const NO_ATTENTION = { plan: false, question: false, permission: false, service: false, capability: false, conflict: false };

const run = (over: Partial<PipelineRun> & { runId: number }): PipelineRun => ({
    repo: `web`,
    host: `github`,
    project: `acme/shop-web`,
    branch: `main`,
    sha: `abc1234`,
    status: `failed`,
    url: `https://github.com/acme/shop-web/actions/runs/${over.runId}`,
    createdAt: over.runId,
    ...over,
});

// The id the daemon files the conversation under, derived the same way the row derives it: transcribing the
// string here would let the two halves of the join drift apart without a test noticing.
const fixAgent = (forRun: PipelineRun, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id: ciFixConversationId(forRun.repo, forRun.runId),
    status: `running`,
    provider: `claude`,
    harness: `native`,
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

test("a run finds the agent whose conversation was derived from it", () => {
    const failed = run({ runId: 41 });
    const other = run({ runId: 42 });
    const fixes = fixesByRun([failed, other], [fixAgent(failed)]);
    expect(fixes.get(failed)?.id).toBe(`ci-fix-web-41`);
    expect(fixes.has(other)).toBe(false);
});

// The roster is the whole fleet; an agent that is not one of this board's fixes must never be joined to a row.
test("an unrelated conversation is not anybody's fix", () => {
    const failed = run({ runId: 41 });
    const stranger: AgentSummary = { ...fixAgent(failed), id: `swift-otter-k9m2` };
    expect(fixesByRun([failed], [stranger]).size).toBe(0);
});

// A run id belongs to one forge project: two repos each running a pipeline 42 must not share an agent.
test("the same run number in another repo is another conversation", () => {
    const web = run({ runId: 42 });
    const api = run({ runId: 42, repo: `api`, host: `gitlab`, project: `acme/shop-api` });
    const fixes = fixesByRun([web, api], [fixAgent(web)]);
    expect(fixes.has(web)).toBe(true);
    expect(fixes.has(api)).toBe(false);
});

/* THE READING THAT KEEPS A BOARD FROM STARTING A SECOND AGENT ON ONE BREAKAGE: the newest red row has no fix
 * of its own, and the one below it, same branch, is already being worked on. */
test("a branch's ongoing fix is carried to the branch's other runs", () => {
    const older = run({ runId: 41, createdAt: 100 });
    const newer = run({ runId: 43, createdAt: 300 });
    const byBranch = branchFixes(fixesByRun([older, newer], [fixAgent(older)]));
    expect(byBranch.get(branchKey(newer))?.run).toBe(older);
});

test("the newest run's agent is the one a branch is represented by", () => {
    const older = run({ runId: 41, createdAt: 100 });
    const newer = run({ runId: 43, createdAt: 300 });
    const byBranch = branchFixes(fixesByRun([older, newer], [fixAgent(older), fixAgent(newer)]));
    expect(byBranch.get(branchKey(older))?.run).toBe(newer);
});

// A fix that landed is done and one that ended produced nothing: neither is a reason to hold another run's
// button back, and a board that said otherwise would be refusing work over an agent nobody can wait for.
test.each([`landed`, `error`, `idle`] as const)("a fix that is over (%s) does not speak for its branch", (status) => {
    const older = run({ runId: 41, createdAt: 100 });
    const newer = run({ runId: 43, createdAt: 300 });
    const byBranch = branchFixes(fixesByRun([older, newer], [fixAgent(older, { status })]));
    expect(byBranch.has(branchKey(newer))).toBe(false);
});

test("branches are told apart within a repo, and repos within a branch name", () => {
    expect(branchKey(run({ runId: 1, branch: `main` }))).not.toBe(branchKey(run({ runId: 2, branch: `release` })));
    expect(branchKey(run({ runId: 1 }))).not.toBe(branchKey(run({ runId: 2, repo: `api` })));
});
