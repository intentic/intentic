import { type Workflow, type WorkflowRun, WorkflowRunSchema, WorkflowRunsListSchema, WorkflowsListSchema } from "@intentic/sandbox-contract";
import { useMutation, useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { blocked, type FleetLane } from "./agentStatus";
import type { FleetAgent } from "./useAgents";

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
export const laneOfRun = (run: WorkflowRun, needsYou = false): FleetLane => {
    // A step waiting on a question, a permission or a conflict puts the RUN in Attention, because the step's
    // own card is not on the board any more — it is inside this one (see boardLanes). A container that hides
    // its contents inherits their claim on the user; without this a run could sit in Active, saying it was
    // working, while the thing it was actually doing was waiting for an answer nobody could see.
    if (needsYou || run.state === `failed` || run.state === `overspent` || run.state === `error`) {
        return `attention`;
    }
    return run.state === `running` ? `active` : `finished`;
};

/* Which runs have a step waiting on the user, by run id — the input to the rule above, and the reason it is
 * computed from the FLEET rather than from the run record: "blocked" is a live fact about a conversation
 * (a question on screen, a permission prompt), and the ledger only knows what the scheduler wrote.
 */
export const runsNeedingYou = (fleet: readonly FleetAgent[]): Set<string> =>
    new Set(fleet.flatMap((agent) => (blocked(agent) && agent.workflow !== undefined ? [agent.workflow.runId] : [])));

/* A STEP IS NEVER A CARD OF ITS OWN — the one rule behind the grouping, asked by every surface that lists
 * conversations: the fleet board's lanes, the board's archive, and the popped-out rail.
 *
 * It is answered from the LEDGER, not from which runs a surface happens to be drawing, and that is the whole
 * correction. Gating on "is the run's row on screen right now" meant every reason a row was not — a filter
 * narrowing the board, a finished run past the lane's window, the archive being open — released that run's
 * conversations as loose cards. So one job reported itself as five agents the moment you typed into the
 * filter, and stopping or dismissing a run scattered its steps across the lanes.
 *
 * The ledger holding the run is the honest test, because a run in the ledger always HAS a row somewhere: on
 * the board while it is live, in the archive once it is filed away. A run that has rolled off the end
 * (RUNS_KEPT, or an emptied archive) has no row anywhere, and its conversations go back to being the ordinary
 * agents they are — hiding work that nothing else is showing is the one outcome worse than showing it twice.
 */
export const runIdsInLedger = (runs: readonly WorkflowRun[]): Set<string> => new Set(runs.map((run) => run.runId));

export const insideRun = (agent: FleetAgent, ledger: ReadonlySet<string>): boolean =>
    agent.workflow !== undefined && ledger.has(agent.workflow.runId);

/* WHETHER A RUN ANSWERS THE QUERY, since its steps can no longer answer for themselves. A filtered board used
 * to drop the run rows and list the matching steps instead, which is the grouping coming apart at exactly the
 * moment the user is looking for something; now the run is what a hit surfaces as.
 *
 * Three ways to match, in the order they cost: the run's NAME, the REQUEST it was pointed at (the sentence the
 * user typed, which is the most likely thing they remember), and any of its STEPS — asked through the board's
 * own agent predicate, so a step found by the daemon's transcript search counts exactly as it would have when
 * the step had a card.
 */
export const runMatches = (run: WorkflowRun, needle: string, fleet: readonly FleetAgent[], agentMatches: (agent: FleetAgent) => boolean): boolean =>
    run.workflow.name.toLowerCase().includes(needle) ||
    run.request?.toLowerCase().includes(needle) === true ||
    fleet.some((agent) => agent.workflow?.runId === run.runId && agentMatches(agent));

/* The runs a lane holds, for the two surfaces that draw lanes — the fleet board and the chat rail, which are
 * the same list at two widths and must not disagree about where a run belongs.
 *
 * Finished is capped for the reason the agents' own Finished lane is: that lane confirms what just completed,
 * and the run HISTORY is the workflows page, which keeps the last fifty and draws each as the graph it was.
 * The cap is the CALLER'S, because a capped run now takes its steps into hiding with it — so the surface that
 * lifts the window for its agents (a filter, the "N earlier" row) has to lift it here in the same breath, and
 * count what is left behind into the row that offers it back.
 */
export const runsInLane = (runs: readonly WorkflowRun[], lane: FleetLane, window: number, needing: ReadonlySet<string>): WorkflowRun[] => {
    const inLane = runs.filter((run) => laneOfRun(run, needing.has(run.runId)) === lane);
    return lane === `finished` ? inLane.slice(0, window) : inLane;
};

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

    /* Ask a run to stop. No step that has not started will start, and the steps in flight are CUT OFF where
     * they are — their turns aborted exactly as /agent/stop aborts one, so whatever they had written stays on
     * their branches and each step settles as `stopped`.
     *
     * NOT the graceful "finish the round you are on" that stopping a LOOP performs, and the difference is the
     * unit: a loop's iteration is a round somebody is watching, a workflow step's is an entire agent turn.
     * Waiting for one meant a stopped run kept working, kept spending and kept asking questions for minutes
     * after the press — indistinguishable from a button that does nothing, which is how it was reported.
     */
    const stop = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/stop`, { method: `POST` }),
        onSuccess: invalidate,
    });

    /* Take an ended run off the board, WITH ITS SESSIONS. The lane's own exit, and the reason it needs one:
     * nothing about a run transitions once it is over, so a failed run sits in Attention until fifty more have
     * rolled it off the ledger.
     *
     * IT IS THE AGENT CARD'S ARCHIVE, applied to a whole graph, and it is what makes a run behave like the
     * single session it stands in for. It used to drop the record alone, which read as tidy and was not: the
     * steps have no cards of their own, so the press that said "I am done with this job" was the press that
     * scattered its conversations across the lanes. Lossless on the same terms as an agent's — branches,
     * transcripts and counters all stay, and Restore in the archive puts run and sessions back together —
     * which is why, like the agent card's, it does not stop to ask.
     */
    const archive = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/archive`, { method: `POST` }),
        onSuccess: invalidate,
    });

    const unarchive = useMutation({
        mutationFn: (runId: string) => sandboxJson(`/workflows/runs/${encodeURIComponent(runId)}/unarchive`, { method: `POST` }),
        onSuccess: invalidate,
    });

    return {
        // Every run the ledger holds, newest first, archived ones included — the caller decides which of them
        // its surface draws, and the archive is a surface.
        runs: computed<WorkflowRun[]>(() => runsQuery.data.value ?? []),
        designs: computed<Workflow[]>(() => designsQuery.data.value ?? []),
        start,
        stop,
        archive,
        unarchive,
    };
}
