import type { AgentSummary, AutomationApproval } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { blocked, turnInFlight } from "../../agents/fleet/agentStatus";
import { queryClient } from "../../../lib/queryPersistence";
import { AGENTS } from "../../../lib/queryKeys";
import { sandboxJsonQuietly } from "../client/sandboxClient";
import { type AcrossRecord, createAcrossStore } from "./acrossSandboxes";

// What every other sandbox's fleet looks like, for the board's All-sandboxes scope and the switcher's counts; polling
// rules live in acrossSandboxes.ts. Every call goes through `sandboxJsonQuietly`, since reaching a sessionless box
// would raise a window-wide Google sign-in for a machine nobody's looking at.

// How often each sandbox is re-read; slow on purpose, since this is ambient awareness, not a live feed.
const POLL_MS = 45_000;

// A read older than this is redone on subscribe or focus; below it, the stored answer is served as-is.
const FRESH_MS = 20_000;

// The three honest answers a card or row can draw: `reading` (never answered yet), `ready` (keeps its populated state
// across polls), `unreachable` (keeps its last count rather than emptying).
export type BoxState = "reading" | "ready" | "unreachable";

export interface BoxFleet extends AcrossRecord {
    readonly state: BoxState;
    readonly agents: readonly AgentSummary[];
    readonly held: readonly AutomationApproval[];
}

const store = createAcrossStore<BoxFleet>({
    pollMs: POLL_MS,
    freshMs: FRESH_MS,
    blank: (sandbox) => ({ sandbox, state: `reading`, agents: [], held: [], readAt: undefined }),
    // Only a box that has never answered shows as reading; every other one keeps what it was.
    reading: (previous) => ({ state: previous === undefined || previous.readAt === undefined ? `reading` : previous.state }),
    unreachable: () => ({ state: `unreachable` }),
    read: async (sandbox) => {
        const body = await sandboxJsonQuietly<{ agents: AgentSummary[]; rev: number; held?: AutomationApproval[] }>(sandbox.id, `/agents`);
        // Also filed under this sandbox's key, so `sandboxQueryPredicate` sweeps it on replacement too.
        queryClient.setQueryData(AGENTS.ofSandbox(sandbox.id), body.agents);
        return { state: `ready`, agents: body.agents, held: body.held ?? [] };
    },
});

export const subscribe = store.subscribe;
export const refreshAcross = store.refresh;

// Every other sandbox in list order, answered or not; unanswered ones render as unknown, never dropped.
export const otherBoxes = store.entries;

// Boxes unreachable on their last attempt; named once so surfaces can't derive it separately and disagree.
export const silentBoxes = computed<readonly BoxFleet[]>(() => otherBoxes.value.filter((box) => box.state === `unreachable`));

// How many agents in one other box want the user: blocked, unread, or a held automation wake. Undefined means
// never-answered; rendering that as `0` would falsely claim nothing is waiting, so surfaces draw a dash.
export const boxAttention = (box: BoxFleet): number | undefined => {
    if (box.readAt === undefined) {
        return undefined;
    }
    const unread = (agent: AgentSummary): boolean => !turnInFlight(agent) && agent.updatedAt > (agent.seenAt ?? 0);
    return box.agents.filter((agent) => blocked(agent) || unread(agent)).length + box.held.length;
};

// `useAgents.markSeen` only writes the roster this browser streams, so it's a no-op for an agent elsewhere; this
// patches that box's own copy, and failures are swallowed the same way the local mark does.
export const markSeenAcross = (sandboxId: string, agentId: string): void => {
    const box = store.get(sandboxId);
    if (box === undefined) {
        return;
    }
    const seenAt = Date.now();
    store.patch(sandboxId, { sandbox: box.sandbox, agents: box.agents.map((agent) => (agent.id === agentId ? { ...agent, seenAt } : agent)) });
    void sandboxJsonQuietly(sandboxId, `/agents/${encodeURIComponent(agentId)}/seen`, { method: `POST` }).catch(() => undefined);
};

// The same count keyed by sandbox id, for the surfaces that hold a row rather than a box (the switcher).
export const attentionByBox = computed<ReadonlyMap<string, number | undefined>>(
    () => new Map(otherBoxes.value.map((box) => [box.sandbox.id, boxAttention(box)])),
);
