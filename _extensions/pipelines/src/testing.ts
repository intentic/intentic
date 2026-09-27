import type { AgentSummary, Finding, PipelineRun, PushCheck, Red } from "@intentic/sandbox-contract";

// The board's fixtures, one per seam, for every suite in this package: the fleet's card, a pipeline run, and what the
// pre-push hook files. Each literal names every field its type requires, so an override only ever narrows one.

const NO_ATTENTION: AgentSummary["attention"] = {
    plan: false,
    question: false,
    permission: false,
    capability: false,
    credential: false,
    conflict: false,
};

export const agentCard = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

export const pipelineRun = (over: Partial<PipelineRun> & { runId: number }): PipelineRun => ({
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

export const finding = (id: string, over: Partial<Finding> = {}): Finding => ({ id, source: id, recheckable: true, text: `${id} says so`, ...over });

export const pushCheck = (id: string, at: number, findings: Finding[], over: Partial<PushCheck> = {}): PushCheck => ({
    project: `web`,
    id,
    at,
    branch: `main`,
    head: `${id}0000000000`,
    commits: 1,
    findings,
    ...over,
});

export const pushRed = (scope: string, findings: Finding[], over: Partial<Red> = {}): Red => ({
    source: `push`,
    scope,
    since: 1_000,
    findings,
    decisions: [],
    ...over,
});

// Each project's push red as the daemon files it from `pushes`: everything they found, oldest push first and each once,
// less what was since `settled` (resolved or dismissed). Derived, so a suite never transcribes what is owed by hand.
export const owing = (pushes: readonly PushCheck[], settled: readonly string[] = []): Red[] => {
    const byProject = new Map<string, Finding[]>();
    for (const each of pushes.toReversed()) {
        const owed = byProject.get(each.project) ?? [];
        byProject.set(each.project, owed);
        owed.push(...each.findings.filter((found) => !settled.includes(found.id) && !owed.some((known) => known.id === found.id)));
    }
    return [...byProject].filter(([, owed]) => owed.length > 0).map(([scope, owed]) => pushRed(scope, owed));
};
