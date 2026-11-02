import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// The instant every "how long ago" beside a conversation reads: when its model provider last answered it. Not
// `updatedAt`, which a land, a conflict or a failure the sandbox records moves to the moment of the press, so a card
// that had sat cold for an hour read "now" the instant somebody tried to land it. A row from a sandbox older than
// `answeredAt` falls back to when its last turn ended (`unfinished.at`), then to `updatedAt`.
export const answeredAt = (agent: Pick<AgentSummary, "answeredAt" | "unfinished" | "updatedAt">): number =>
    agent.answeredAt ?? agent.unfinished?.at ?? agent.updatedAt;
