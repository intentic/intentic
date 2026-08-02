import { type Workflow, workflowFaults, workflowsContract, type WorkflowSummary } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { openRun, runWorkflow, stopWorkflowRun } from "./workflow-runner.js";

/* The workflow routes. The manifest half is an ordinary CRUD store; the run half acks and walks away, because
 * a run outlives its request by minutes or hours and there is nothing useful for a handler to await.
 */
export const createWorkflowsRoutes = (services: Services) => {
    const i = implement(workflowsContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async () => {
            const [workflows, runs] = await Promise.all([services.workflows.list(), services.workflowRuns.list()]);
            // Joined here rather than stored joined: the ledger is keyed by run and a workflow's runs are
            // whichever runs snapshotted it, which stays true after the workflow is edited or deleted.
            const withRuns = (workflow: Workflow): WorkflowSummary => ({ ...workflow, runs: runs.filter((run) => run.workflow.id === workflow.id) });
            return { workflows: workflows.map(withRuns) };
        }),
        save: i.save.handler(async ({ input }) => {
            /* The same sentences the designer shows while you type, enforced here — a rule the daemon holds
             * privately is a rule the user meets as a failed save with no idea which node is wrong. Refused
             * rather than saved-and-broken because a workflow that cannot run is not a draft, it is a trap: the
             * failure would arrive an hour later, halfway through a run, having already spent money. */
            const faults = workflowFaults(input);
            if (faults.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: faults.join(" ") });
            }
            await services.workflows.upsert(input);
            return input;
        }),
        // Deliberately does not stop a run of it that is in flight, and does not delete its history: a run
        // snapshotted its definition when it started, so it stays readable and stays stoppable.
        remove: i.remove.handler(async ({ input }) => {
            await services.workflows.remove(input.id);
            return { ok: true as const };
        }),
        run: i.run.handler(async ({ input }) => {
            const workflow = await services.workflows.get(input.id);
            if (workflow === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "No workflow with that id." });
            }
            // Re-checked at run time, not only at save time: a manifest can be hand-edited, and the run is
            // where the money gets spent.
            const faults = workflowFaults(workflow);
            if (faults.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: faults.join(" ") });
            }
            const run = await services.workflowRuns.start(openRun(workflow, Date.now()));
            // Detached, like every other route that starts a turn: the first step alone can take minutes.
            void runWorkflow(services, run, streamAgent);
            return run;
        }),
        runs: i.runs.handler(async () => ({ runs: await services.workflowRuns.list() })),
        stopRun: i.stopRun.handler(async ({ input }) => {
            if (!stopWorkflowRun(input.runId)) {
                // Saying so beats an `ok` that means nothing: the usual cause is that it already ended, which
                // the run now shows.
                throw new ORPCError("NOT_FOUND", { message: "That run is not going." });
            }
            return { ok: true as const };
        }),
    };
};
