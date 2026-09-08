import { type Workflow, type WorkflowRun, WorkflowRunSchema, WorkflowRunsListSchema, WorkflowsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { WORKFLOW_DESIGNS, WORKFLOW_RUNS } from "../../../lib/queryKeys";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { blocked, type FleetLane } from "./agentStatus";
import type { FleetAgent } from "./useAgents-fleet";

// Workflow runs for surfaces other than the workflows page: the fleet board and chat composer. A run gets its own
// row, not a sixth agent, since it has no transcript, worktree or turn. Pushed via the daemon's `workflow-runs`
// file-change key (core's, not the extension's, so the board still renders when workflows is off), never polled.

// Shared keys so every caller lands on one cached fetch; the daemon's push invalidates by these exact names.
const runsKey = WORKFLOW_RUNS.every;
const designsKey = WORKFLOW_DESIGNS.every;

// Same three lanes as an agent, decided from the run's own state. `overspent`/`error` count as attention, not
// finished, since those need a person's action.
export const laneOfRun = (run: WorkflowRun, needsYou = false): FleetLane => {
    // A step waiting on input puts the run, not the step, in Attention: the step's card isn't on the board.
    if (needsYou || run.state === `failed` || run.state === `overspent` || run.state === `error`) {
        return `attention`;
    }
    return run.state === `running` ? `active` : `finished`;
};

// Run ids with a step waiting on the user. Computed from the fleet, not the ledger: "blocked" is a live fact about
// a conversation the run record doesn't carry.
export const runsNeedingYou = (fleet: readonly FleetAgent[]): Set<string> =>
    new Set(fleet.flatMap((agent) => (blocked(agent) && agent.workflow !== undefined ? [agent.workflow.runId] : [])));

// A step is never its own card while its run is in the ledger: on the board while live, in the archive once
// filed. A run rolled off the ledger releases its steps back to being ordinary agents.
export const runIdsInLedger = (runs: readonly WorkflowRun[]): Set<string> => new Set(runs.map((run) => run.runId));

export const insideRun = (agent: FleetAgent, ledger: ReadonlySet<string>): boolean =>
    agent.workflow !== undefined && ledger.has(agent.workflow.runId);

// Whether a run answers a search, since its steps can't answer for themselves. Matches on the run's name, its
// request text, or any step via the board's own agent predicate.
export const runMatches = (run: WorkflowRun, needle: string, fleet: readonly FleetAgent[], agentMatches: (agent: FleetAgent) => boolean): boolean =>
    run.workflow.name.toLowerCase().includes(needle) ||
    run.request?.toLowerCase().includes(needle) === true ||
    fleet.some((agent) => agent.workflow?.runId === run.runId && agentMatches(agent));

// Runs in a lane, shared by the board and rail. Finished is capped by the caller: a capped run hides its steps
// too, so the caller must widen the window here along with its own.
export const runsInLane = (runs: readonly WorkflowRun[], lane: FleetLane, window: number, needing: ReadonlySet<string>): WorkflowRun[] => {
    const inLane = runs.filter((run) => laneOfRun(run, needing.has(run.runId)) === lane);
    return lane === `finished` ? inLane.slice(0, window) : inLane;
};

// Titles of steps currently running, not the step count already shown on the card; answers what part of the
// design is spending money now.
export const runningTitles = (run: WorkflowRun): string[] =>
    run.steps
        .filter((step) => step.state === `running`)
        .map((step) => run.workflow.steps.find((design) => design.id === step.stepId)?.title ?? step.stepId);

export const spentOn = (run: WorkflowRun): number => run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0);

export function useWorkflowRuns() {
    const queryClient = useQueryClient();
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: runsKey });

    // Every run the ledger holds, newest first; kept fresh by the ledger's file-change push.
    const { query: runsQuery } = useSandboxQuery<WorkflowRun[]>({
        queryKey: runsKey,
        queryFn: async () => WorkflowRunsListSchema.parse(await sandboxJson(`/workflows/runs`)).runs,
    });

    // Saved designs for the composer's picker; not polled, a stale entry costs a picker row, not a wrong run.
    const { query: designsQuery } = useSandboxQuery<Workflow[]>({
        queryKey: designsKey,
        queryFn: async () => WorkflowsListSchema.parse(await sandboxJson(`/workflows`)).workflows,
    });

    // Starts a run; resolves with the run as opened, its steps already `pending`. Seeds the runs cache (not just
    // invalidates), so followers see it before the refetch lands.
    const start = useMutation({
        mutationFn: async ({ id, request }: { id: string; request?: string }): Promise<WorkflowRun> =>
            WorkflowRunSchema.parse(
                await sandboxJson(`/workflows/${encodeURIComponent(id)}/run`, jsonBody(`POST`, request === undefined ? {} : { request })),
            ),
        onSuccess: (run) => {
            queryClient.setQueryData<WorkflowRun[]>(runsKey, (held) => [run, ...(held ?? []).filter((entry) => entry.runId !== run.runId)]);
            return invalidate();
        },
    });

    // Stops a run: unstarted steps never start; running steps are aborted like /agent/stop and settle `stopped`.
    // Unlike stopping a loop, this aborts the step's whole turn rather than waiting for the round to finish.
    const stop = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/stop`, { method: `POST` }),
        onSuccess: invalidate,
    });

    // Archives an ended run with its sessions (a step has no card of its own to archive separately). Lossless, like
    // an agent's archive; restore brings run and sessions back together.
    const archive = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/archive`, { method: `POST` }),
        onSuccess: invalidate,
    });

    const unarchive = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/unarchive`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        // Every run the ledger holds, newest first, archived included; the caller decides what draws it.
        runs: computed<WorkflowRun[]>(() => runsQuery.data.value ?? []),
        designs: computed<Workflow[]>(() => designsQuery.data.value ?? []),
        start,
        stop,
        archive,
        unarchive,
    };
}
