import { fnvDigest, latestFixAttempt } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { fixStance } from "@intentic/sandbox-contract/state/fix-stance";
import type { Finding, FindingAgent, FindingLane, FindingSeverity, Snapshot } from "../wire.js";
import type { State } from "./state.js";

/* WHAT THE VIEW, THE BADGE AND THE AGENT'S TOOL READ: the last round's findings joined with the agent on each and the
   owner's snoozes. The agent is found the way the Pipelines board finds its fix agents, by the id derived from what it
   answers (`fixBase`), never by a store of who started what: the roster is the record. A finding an automation woke on
   is joined by the conversation that wake opened instead, when no press started one. */

/** The conversation id every attempt at a finding derives from: two FNV digests of its id, so a finding never needs a
 *  table to find its agent, and attempt 2 onward is `<base>_<n>` (the contract's fixAttemptId). */
export const fixBase = (findingId: string): string => `health-${fnvDigest(findingId)}${fnvDigest(`health:${findingId}`)}`;

const LANE_ORDER = { fix: 0, step: 1, decide: 2, setup: 3, watch: 4 } satisfies Record<FindingLane, number>;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } satisfies Record<FindingSeverity, number>;

const agentOf = (finding: Finding, roster: readonly AgentSummary[], state: State): FindingAgent | undefined => {
    const latest = latestFixAttempt(fixBase(finding.id), roster);
    const wokenId = state.woken[finding.id];
    const woken = wokenId === undefined ? undefined : roster.find((agent) => agent.id === wokenId);
    const agent = latest?.agent ?? woken;
    if (agent === undefined) {
        return undefined;
    }
    const stance = fixStance(agent);
    return {
        conversationId: agent.id,
        attempt: latest?.attempt ?? 1,
        stance: stance.kind,
        label: stance.label,
        hint: stance.hint,
        ownerStep: state.ownerSteps[agent.id],
    };
};

// Whichever snooze ends later: PostHog's own (a health issue's, an alert's) or the owner's here.
const snoozeOf = (finding: Finding, state: State): number | undefined => {
    const here = state.snoozed[finding.id];
    if (finding.snoozedUntil === undefined) {
        return here;
    }
    return here === undefined ? finding.snoozedUntil : Math.max(here, finding.snoozedUntil);
};

const byWeight = (left: Finding, right: Finding): number =>
    LANE_ORDER[left.lane] - LANE_ORDER[right.lane] ||
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
    Number(right.cameBack === true) - Number(left.cameBack === true) ||
    (right.lastSeen ?? right.since ?? 0) - (left.lastSeen ?? left.since ?? 0);

/** The snapshot for the connections on the Capabilities page now; a removed connection's rows are not shown. */
export const snapshotOf = (state: State, roster: readonly AgentSummary[], connections: readonly string[]): Snapshot => {
    const live = new Set(connections);
    const findings = Object.entries(state.findings)
        .filter(([connection]) => live.has(connection))
        .flatMap(([, held]) => held)
        .map((finding) => ({ ...finding, agent: agentOf(finding, roster, state), snoozedUntil: snoozeOf(finding, state) }))
        .toSorted(byWeight);
    return {
        connections: connections.map((id) => state.connections[id] ?? { id, host: ``, problems: [], wired: false }),
        findings,
    };
};

/** One finding of the snapshot by id, joined like the rest. */
export const findingIn = (state: State, roster: readonly AgentSummary[], id: string): Finding | undefined => {
    const held = Object.values(state.findings)
        .flat()
        .find((finding) => finding.id === id);
    return held === undefined ? undefined : { ...held, agent: agentOf(held, roster, state), snoozedUntil: snoozeOf(held, state) };
};
