import {
    type Workflow,
    workflowFaults,
    workflowRunFaults,
    type WorkflowRun,
    workflowsContract,
    type WorkflowSummary,
} from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import { archiveAgents } from "../agents/archive.js";
import { operatorHere } from "../auth/operator.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { abandonRun, openRun, runWorkflow, stopWorkflowRun, workflowRunning } from "./workflow-runner.js";
import { runConversations } from "./workflow-state.js";

/* The workflow routes. The manifest half is an ordinary CRUD store; the run half acks and walks away, because
 * a run outlives its request by minutes or hours and there is nothing useful for a handler to await.
 */
export const createWorkflowsRoutes = (services: Services) => {
    const i = implement(workflowsContract).$context<OrpcContext>();
    // The run the archive routes are addressing, or the reason they cannot. Both are moves on an ENDED run and
    // both would corrupt a live one, archiving pulls the worktrees out from under turns that are still writing
    // to them, so the guard is the pair's, not each route's.
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
            /* Joined here rather than stored joined: the ledger is keyed by run and a workflow's runs are
             * whichever runs snapshotted it, which stays true after the workflow is edited or deleted. The gate's
             * credential rides along for an OPERATOR only, minted here if the gate has none yet (a design saved
             * before the door store existed), and never for a viewer or a program's read token. */
            const operator = operatorHere(services, context);
            const withRuns = async (workflow: Workflow): Promise<WorkflowSummary> => ({
                ...workflow,
                runs: runs.filter((run) => run.workflow.id === workflow.id),
                ...(operator && workflow.gate !== undefined ? { gateToken: await services.doorTokens.ensure("gate", workflow.id) } : {}),
            });
            return { workflows: await Promise.all(workflows.map(withRuns)) };
        }),
        save: i.save.handler(async ({ input }) => {
            /* The same sentences the designer shows while you type, enforced here, a rule the daemon holds
             * privately is a rule the user meets as a failed save with no idea which node is wrong. Refused
             * rather than saved-and-broken because a workflow that cannot run is not a draft, it is a trap: the
             * failure would arrive an hour later, halfway through a run, having already spent money. */
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
            /* The gate's credential lives with the door, not in the design: minted the first time a gate is
             * saved, KEPT across every later save (the designer re-posts the whole workflow on every edit, and
             * a gate whose URL changed each time somebody renamed a step would be one every pipeline had to be
             * re-taught), and dropped the moment the design stops declaring a gate. Returned rather than the
             * input echoed, because the designer has no other way to learn the URL it has to hand the pipeline. */
            if (workflow.gate === undefined) {
                await services.doorTokens.remove("gate", workflow.id);
                return workflow;
            }
            return { ...workflow, gateToken: await services.doorTokens.ensure("gate", workflow.id) };
        }),
        // A fresh credential for the gate, the old one retired in the same write; every wired pipeline is re-taught.
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
        // Deliberately does not stop a run of it that is in flight, and does not delete its history: a run
        // snapshotted its definition when it started, so it stays readable and stays stoppable.
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
            // Re-checked at run time, not only at save time: a manifest can be hand-edited, and the run is
            // where the money gets spent.
            const faults = [...workflowFaults(workflow), ...workflowRunFaults(workflow, input.request)];
            if (faults.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: faults.join(" ") });
            }
            const repos = await services.agentWorktrees.snapshot();
            if (repos.length === 0) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "The workspace has no committed repository snapshot to run from." });
            }
            const run = await services.workflowRuns.start(openRun(workflow, repos, Date.now(), input.request));
            // Detached, like every other route that starts a turn: the first step alone can take minutes.
            void runWorkflow(services, run, streamAgent);
            return run;
        }),
        runs: i.runs.handler(async () => ({ runs: await services.workflowRuns.list() })),
        /* Stop a run, and END it whatever state it is in, the one thing this route used to refuse to do.
         *
         * It answered "that run is not going" whenever the scheduler had no abort handle, which is exactly the
         * case where the user needs it most: a record still marked `running` that nothing is driving, because
         * the daemon it started under was replaced. The run then had a Stop that could not work, a step count
         * frozen at 0/5 and no way off the board at all. So a missing handle is not an error, it is the signal
         * to close the record instead (abandonRun).
         *
         * NOT_FOUND is kept for a run id that names nothing, that one really is a bad request.
         */
        stopRun: i.stopRun.handler(async ({ input }) => {
            const run = await services.workflowRuns.get(input.runId);
            if (run === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "No run with that id." });
            }
            // In flight: abort it and let the scheduler write the outcome, which it is in the middle of doing.
            if (stopWorkflowRun(input.runId)) {
                return { ok: true as const };
            }
            // Already over: pressing Stop on it is a no-op rather than a complaint about timing.
            if (run.state === "running") {
                await abandonRun(services, run, Date.now());
            }
            return { ok: true as const };
        }),
        /* File a run away, WITH ITS SESSIONS. The board's exit for a run it has finished with, an `attention`
         * lane holding a failed run from two hours ago has no other way to empty, since nothing about a run
         * ever transitions once it has ended.
         *
         * The steps go first and the run's own marker last, so a teardown that throws leaves a run still ON the
         * board with some of its checkouts reclaimed, rather than a run the board has archived whose sessions
         * are loose on it, archiveAgents already drops a failing agent from its batch and keeps the rest.
         *
         * Refuses while the run is going: that is what Stop is for, and archiving a live run would pull the
         * worktrees out from under turns that are still writing to them.
         */
        archiveRun: i.archiveRun.handler(async ({ input }) => {
            const run = await endedRun(input.runId);
            await archiveAgents(services, runConversations(run), Date.now());
            await services.workflowRuns.setArchived(input.runId, Date.now());
            return { ok: true as const };
        }),
        // Back onto the board, run and sessions together. No worktree restore for the steps, the next turn's
        // ensure() rebuilds a checkout from the branch, exactly as `agents.unarchive` relies on.
        unarchiveRun: i.unarchiveRun.handler(async ({ input }) => {
            const run = await endedRun(input.runId);
            await services.agents.clearArchived(runConversations(run));
            await services.workflowRuns.setArchived(input.runId, undefined);
            return { ok: true as const };
        }),
    };
};
