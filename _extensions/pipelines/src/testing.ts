import type { AgentSummary, PipelineRun } from "@intentic/sandbox-contract";

// The board's fixtures, one per seam, for every suite in this package: the fleet's card and a pipeline run. Each literal
// names every field its type requires, so an override only ever narrows one.

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
