import type { SubagentStatus } from "@intentic/sandbox-contract";
import { listSubagentSessions, subagentRunning } from "../agent/subagents/subagents.js";
import { armedWatcherCount } from "../agent/verification/watchers.js";
import type { Services } from "../composition.js";
import { liveRunOf } from "../conversations/actor/conversation-holdings.js";
import { runningWorkflows } from "../workflows/workflow-runner.js";

// IS THE SANDBOX BUSY? ONE ANSWER, ASKED FOR A PURPOSE (2026-10-05). Four places each kept their own: the automatic
// update waited for turns, lands, running subagents and workflows; idle-stop for turns, live subagents and armed
// watches; the device rebuild for turns only, so it could cut a land or a workflow step the update waited out; the
// host's keeper signal counted live sessions. What differs now is the purpose, and each difference is stated below.

export type WorkKind = "turn" | "land" | "subagent" | "parked-subagent" | "workflow" | "watch";

export interface WorkItem {
    readonly kind: WorkKind;
    // By the name the board or the run shows it under.
    readonly name: string;
}

// - restart: this container restarts (an automatic update, a device rebuild, the host's keeper mending a broken
//   tunnel). It cuts a turn, a land, a running subagent and a workflow's step. A parked subagent (pending, blocked on a
//   question, paused on a spent allowance) waits across a restart as it waits anyway, and an armed watch is journalled
//   and restored at boot (restoreWatchers), so neither holds it.
// - idle-stop: the machine stops until somebody visits. Everything a restart cuts, plus what only this daemon's own
//   clock moves on: a parked subagent's booked re-run or its start when memory frees, and an armed watch's next check.
//   Stopping under either is how it silently never happens.
export type WorkPurpose = "restart" | "idle-stop";

const RESTART: ReadonlySet<WorkKind> = new Set<WorkKind>(["turn", "land", "subagent", "workflow"]);
const WAITS_FOR: Readonly<Record<WorkPurpose, ReadonlySet<WorkKind>>> = {
    restart: RESTART,
    "idle-stop": new Set<WorkKind>([...RESTART, "parked-subagent", "watch"]),
};

export type WorkingNowDeps = Pick<Services, "agents" | "conversations">;

// A turn by any of the three marks the actors keep for one, each of which one of the earlier definitions read alone: its
// live run (the update, the rebuild), its running phase (the keeper), a registered turn (idle-stop).
const turnLive = (conversations: WorkingNowDeps["conversations"], id: string): boolean =>
    liveRunOf(conversations, id) !== undefined || conversations.running(id) || conversations.turnActive(id);

// Everything in flight, by kind, read off the actors and the runners at one moment.
export interface WorkSnapshot {
    readonly turns: readonly string[];
    readonly lands: readonly string[];
    readonly subagents: readonly { readonly status: SubagentStatus; readonly name: string }[];
    readonly workflows: readonly string[];
    readonly watches: number;
}

export const snapshotOf = ({ agents, conversations }: WorkingNowDeps): WorkSnapshot => {
    const named = agents.list().map((agent) => ({ id: agent.id, name: agent.title ?? agent.id }));
    return {
        turns: named.filter(({ id }) => turnLive(conversations, id)).map(({ name }) => name),
        lands: named.filter(({ id }) => conversations.landing(id)).map(({ name }) => name),
        subagents: listSubagentSessions(conversations).map((session) => ({
            status: session.status,
            name: session.description ?? session.agentType ?? "a subagent",
        })),
        workflows: runningWorkflows().map((run) => run.name),
        watches: armedWatcherCount(),
    };
};

/** What in `snapshot` a moment of `purpose` waits for. */
export const workOf = (snapshot: WorkSnapshot, purpose: WorkPurpose): WorkItem[] => {
    const subagentKind = (status: SubagentStatus): WorkKind | undefined =>
        status === "running" ? "subagent" : subagentRunning({ status }) ? "parked-subagent" : undefined;
    const items: WorkItem[] = [
        ...snapshot.turns.map((name) => ({ kind: "turn" as const, name })),
        ...snapshot.lands.map((name) => ({ kind: "land" as const, name })),
        ...snapshot.subagents.flatMap(({ status, name }) => {
            const kind = subagentKind(status);
            return kind === undefined ? [] : [{ kind, name }];
        }),
        ...snapshot.workflows.map((name) => ({ kind: "workflow" as const, name })),
        ...Array.from({ length: snapshot.watches }, () => ({ kind: "watch" as const, name: "an armed watch" })),
    ];
    const waits = WAITS_FOR[purpose];
    return items.filter((item) => waits.has(item.kind));
};

/** What is mid-flight that `purpose` must wait for, each item once per thing (a turn that is also landing is two). */
export const workingNow = (deps: WorkingNowDeps, purpose: WorkPurpose): WorkItem[] => workOf(snapshotOf(deps), purpose);

/** The same, by name, each name once: what a card or a countdown says it is waiting on. */
export const workingNames = (deps: WorkingNowDeps, purpose: WorkPurpose): string[] => [...new Set(workingNow(deps, purpose).map((item) => item.name))];
