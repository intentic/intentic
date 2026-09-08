import {
    type Workflow,
    workflowFaults,
    workflowRunFaults,
    type WorkflowRun,
    workflowsContract,
    type WorkflowSummary,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { archiveAgents } from "../agents/registry/archive.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { abandonRun, openRun, runWorkflow, stopWorkflowRun, workflowRunning } from "./workflow-runner.js";
import { runConversations } from "./workflow-state.js";

// Workflow routes: the manifest half is ordinary CRUD; the run half acks and walks away, since a run outlives its
// request by minutes or hours.
export const createWorkflowsRoutes = (services: Services) => {
    const i = implement(workflowsContract).$context<OrpcContext>();
    // Run the archive routes address, or the reason they can't; both archive and unarchive are moves on an ended run
    // only, since archiving a live one would pull worktrees out from under turns still writing to them.
    const endedRun = async (runId: string): Promise<WorkflowRun> => {
        const run = await services.workflowRuns.get(runId);
        if (run === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "No run with that id." });
        }
        if (workflowRunning(runId)) {
            throw new ORPCError("BAD_REQUEST", { message: "That run is still going, stop it first." });
        }
        return run;
    };
    return {
        list: i.list.handler(async ({ context }) => {
            const [workflows, runs] = await Promise.all([services.workflows.list(), services.workflowRuns.list()]);
            // Gate token rides along for an operator only, minted if the gate has none yet.
            const operator = operatorHere(services, context);
            const withRuns = async (workflow: Workflow): Promise<WorkflowSummary> => ({
                ...workflow,
                runs: runs.filter((run) => run.workflow.id === workflow.id),
                ...(operator && workflow.gate !== undefined ? { gateToken: await services.doorTokens.ensure("gate", workflow.id) } : {}),
            });
            return { workflows: await Promise.all(workflows.map(withRuns)) };
        }),
        save: i.save.handler(async ({ input }) => {
            // Same rule the designer shows while typing; refused rather than saved-and-broken.
            const faults = workflowFaults(input.workflow);
            if (faults.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: faults.join(" ") });
            }
            const { workflow } = input;
            const saved = await services.workflows.save(workflow, input.create);
            if (saved === "conflict") {
                throw new ORPCError("CONFLICT", { message: "A workflow with that id already exists. Reopen the list and try again." });
            }
            if (saved === "missing") {
                throw new ORPCError("NOT_FOUND", { message: "That workflow no longer exists. Reopen the list before saving." });
            }
            // Gate token lives with the door: minted once, kept across saves so a step rename doesn't change the
            // pipeline's URL, dropped once the design drops the gate. Returned since the designer has no other way to
            // learn it.
            if (workflow.gate === undefined) {
                await services.doorTokens.remove("gate", workflow.id);
                return workflow;
            }
            return { ...workflow, gateToken: await services.doorTokens.ensure("gate", workflow.id) };
        }),
        // Mints a fresh gate credential and retires the old one in the same write; every wired pipeline must be
        // re-taught.
        rotateGateToken: i.rotateGateToken.handler(async ({ input }) => {
            const workflow = await services.workflows.get(input.id);
            if (workflow === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "No workflow with that id." });
            }
            if (workflow.gate === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "That workflow declares no gate, so there is no token to rotate." });
            }
            return { token: await services.doorTokens.rotate("gate", workflow.id) };
        }),
        // Does not stop an in-flight run or delete its history: a run snapshots its own definition, so it stays
        // readable and stoppable after the workflow is gone.
        remove: i.remove.handler(async ({ input }) => {
            await services.workflows.remove(input.id);
            await services.doorTokens.remove("gate", input.id);
            return { ok: true as const };
        }),
        run: i.run.handler(async ({ input }) => {
            const workflow = await services.workflows.get(input.id);
            if (workflow === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "No workflow with that id." });
            }
            // Re-checked at run time: a manifest can be hand-edited, and this is where the money is spent.
            const faults = [...workflowFaults(workflow), ...workflowRunFaults(workflow, input.request)];
            if (faults.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: faults.join(" ") });
            }
            const repos = await services.agentWorktrees.snapshot();
            if (repos.length === 0) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "The workspace has no committed repository snapshot to run from." });
            }
            const run = await services.workflowRuns.start(openRun(workflow, repos, Date.now(), input.request));
            // Detached, like every route that starts a turn: the first step alone can take minutes.
            void runWorkflow(services, run, streamAgent);
            return run;
        }),
        runs: i.runs.handler(async () => ({ runs: await services.workflowRuns.list() })),
        // Stops a run whatever state it's in: a missing abort handle (the daemon is gone) closes the record instead of
        // refusing, exactly when Stop is needed most. NOT_FOUND is kept only for a run id that names nothing.
        stopRun: i.stopRun.handler(async ({ input }) => {
            const run = await services.workflowRuns.get(input.runId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "No run with that id." });
            }
            // In flight: abort it and let the scheduler write the outcome itself.
            if (stopWorkflowRun(input.runId)) {
                return { ok: true as const };
            }
            // Already over: pressing Stop on it is a no-op, not an error about timing.
            if (run.state === "running") {
                await abandonRun(services, run, Date.now());
            }
            return { ok: true as const };
        }),
        // Archives a run with its sessions, the board's only way to clear a finished run from a lane. Steps are
        // archived before the run's own marker, so a throw mid-teardown can't leave a live session on an archived run.
        archiveRun: i.archiveRun.handler(async ({ input }) => {
            const run = await endedRun(input.runId);
            await archiveAgents(services, runConversations(run), Date.now());
            await services.workflowRuns.setArchived(input.runId, Date.now());
            return { ok: true as const };
        }),
        // Restores the run and its sessions together; no worktree restore for the steps, since the next turn's ensure()
        // rebuilds a checkout from the branch, same as agents.unarchive.
        unarchiveRun: i.unarchiveRun.handler(async ({ input }) => {
            const run = await endedRun(input.runId);
            await services.agents.clearArchived(runConversations(run));
            await services.workflowRuns.setArchived(input.runId, undefined);
            return { ok: true as const };
        }),
    };
};
