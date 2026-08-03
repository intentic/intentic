import { type Workflow, type WorkflowRun, WorkflowRunSchema, WorkflowRunsListSchema, WorkflowsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import type { FleetLane } from "./agentStatus";

/* WORKFLOW RUNS, FOR THE SURFACES THAT ARE NOT THE WORKFLOWS PAGE — the fleet board and the chat composer.
 *
 * WHY THE BOARD NEEDS THIS AT ALL. A run's steps are ordinary conversations and already appear as cards; what
 * had no card was the RUN. So a five-step workflow arrived as five unrelated agents that happened to start
 * together, with nothing on the board to stop, to open, or to read a total off — the run existed only inside
 * the workflows extension, one navigation away from where the user actually watches work happen. This is the
 * missing row, and it is deliberately a row of its own rather than a sixth agent: a run has no transcript, no
 * worktree and no turn, and pretending otherwise would put Land and Archive on a thing that has neither.
 *
 * THE POLL IS THE EXTENSION'S, FOR THE EXTENSION'S REASON. Steps finish minutes apart and no event announces
 * one, so a live run is polled and an idle workspace costs nothing. The window is a touch wider than the
 * extension's: this is a background row on a board, not the page you opened to watch.
 */

const LIVE_POLL_MS = 6_000;

// Shared by every caller, because vue-query keys the cache by them: the board and the composer each build
// their own query objects and land on ONE fetch and one poll between them.
const runsKey = [`workflow-runs`] as const;
const designsKey = [`workflows`] as const;

/* WHERE A RUN SITS ON THE BOARD — the same three lanes as an agent, decided from the run's own state, so a
 * board sorted by "what needs me / what is moving / what is done" keeps meaning what it says.
 *
 * A run that ran out of money or died is ATTENTION and not finished, and that is the whole reason this is not
 * `state === "running" ? active : finished`: `overspent` and `error` are the two outcomes a person has to do
 * something about, and filing them under Finished is how a $30 ceiling hit at 2am is discovered on Thursday.
 */
export const laneOfRun = (run: WorkflowRun): FleetLane => {
    if (run.state === `failed` || run.state === `overspent` || run.state === `error`) {
        return `attention`;
    }
    return run.state === `running` ? `active` : `finished`;
};

// The conversations this run has ALIVE right now — what "open the workflow" puts on screen. Steps that share a
// conversation (a `continue` handoff) collapse to one, which is the same thing the graph draws as one card.
export const liveConversations = (run: WorkflowRun): string[] => [
    ...new Set(run.steps.filter((step) => step.state === `running`).map((step) => step.conversationId)),
];

/* What the run's card says it is doing: the titles of the steps in flight. Not the step COUNT — "2 of 5" is
 * already on the card and answers a different question — because the useful line on a live run is which part
 * of the design is burning money at this moment.
 */
export const runningTitles = (run: WorkflowRun): string[] =>
    run.steps
        .filter((step) => step.state === `running`)
        .map((step) => run.workflow.steps.find((design) => design.id === step.stepId)?.title ?? step.stepId);

export const spentOn = (run: WorkflowRun): number => run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0);

export function useWorkflowRuns() {
    const queryClient = useQueryClient();
    const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey: runsKey });

    // Every run the ledger holds, newest first. Polled only while something is going — see the header.
    const { query: runsQuery } = useSandboxQuery<WorkflowRun[]>({
        queryKey: runsKey,
        queryFn: async () => WorkflowRunsListSchema.parse(await sandboxJson(`/workflows/runs`)).runs,
        refetchInterval: (current) => (current.state.data?.some((run) => run.state === `running`) === true ? LIVE_POLL_MS : false),
    });

    // The saved designs, for the composer's picker. Not polled: a design changes when somebody edits it in the
    // designer, and a stale row here costs a picker entry rather than a wrong run — the daemon reads the
    // design itself when the run starts.
    const { query: designsQuery } = useSandboxQuery<Workflow[]>({
        queryKey: designsKey,
        queryFn: async () => WorkflowsListSchema.parse(await sandboxJson(`/workflows`)).workflows,
    });

    /* Start a run, pointed at a request. Resolves with the run as the daemon opened it — every step already
     * recorded `pending` — so the caller can put its conversations on screen without waiting for the poll to
     * come round, which is the difference between "it started" and a board that looks unchanged for six
     * seconds after you pressed the button.
     */
    const start = useMutation({
        mutationFn: async ({ id, request }: { id: string; request?: string }): Promise<WorkflowRun> =>
            WorkflowRunSchema.parse(
                await sandboxJson(`/workflows/${encodeURIComponent(id)}/run`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify(request === undefined ? {} : { request }),
                }),
            ),
        onSuccess: invalidate,
    });

    /* Ask a run to stop. No step that has not started will start, and the steps in flight stop after their
     * current ITERATION — the same split as stopping a loop, and the reason the card says so rather than
     * flipping to a stopped state the daemon has not reached yet. Killing the work outright is Stop on each
     * step's own card, which is one click away from here now that the run opens its sessions.
     */
    const stop = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/stop`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        // Every run the ledger holds, newest first — the caller decides which of them its surface draws.
        runs: computed<WorkflowRun[]>(() => runsQuery.data.value ?? []),
        designs: computed<Workflow[]>(() => designsQuery.data.value ?? []),
        start,
        stop,
    };
}
