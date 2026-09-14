import type { AgentSummary } from "@intentic/sandbox-contract";

// "Waiting for you": the agents whose next move is the owner's, each as one sentence and a tone. Pure over the fleet
// list; the page decides what a press does.

export interface WaitingRow {
    readonly id: string;
    readonly title: string;
    readonly line: string;
    readonly tone: "info" | "warning" | "danger";
}

// The order a person should meet them in: a question blocks a running assistant, a held draft waits, a misfit and a
// failure are errands.
const RANK: Partial<Record<AgentSummary["status"], number>> = { awaiting: 0, ready: 1, conflict: 2, error: 3, interrupted: 3 };

const LINE: Partial<Record<AgentSummary["status"], { readonly line: string; readonly tone: WaitingRow["tone"] }>> = {
    awaiting: { line: `Asked you a question.`, tone: `info` },
    ready: { line: `Finished. Its changes wait for you to accept them.`, tone: `info` },
    conflict: { line: `Its changes no longer fit the project since you edited it. Ask it to redo them.`, tone: `warning` },
    error: { line: `Stopped with a problem.`, tone: `danger` },
    interrupted: { line: `Was interrupted before it finished.`, tone: `danger` },
};

export const waitingRows = (agents: readonly AgentSummary[]): WaitingRow[] =>
    agents
        .filter((agent) => agent.archivedAt === undefined && RANK[agent.status] !== undefined)
        .toSorted((left, right) => (RANK[left.status] ?? 9) - (RANK[right.status] ?? 9) || right.updatedAt - left.updatedAt)
        .map((agent) => {
            const words = LINE[agent.status]!;
            return { id: agent.id, title: agent.title ?? `An assistant`, line: words.line, tone: words.tone };
        });
