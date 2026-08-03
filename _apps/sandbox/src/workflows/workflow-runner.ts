import { randomUUID } from "node:crypto";
import type { Loop, LoopDocument, Workflow, WorkflowRun, WorkflowRunState, WorkflowStep, WorkflowStepRun } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { runLoop, stopLoop, type TurnFn } from "../loops/loop-runner.js";
import { briefForStep, type Handover, stepConversations } from "./workflow-brief.js";
import { workflowProjection } from "./workflow-state.js";

/* THE SCHEDULER — run a graph of steps, each one a loop, in dependency order.
 *
 * DAEMON-SIDE, for the reason loops are and more so. One turn survives a closed browser on its own; a sequence
 * does not, and a workflow is a sequence of sequences that can run for hours. So the browser watches and
 * nothing else drives.
 *
 * A STEP IS A LOOP AND THE LOOP DOES THE WORK. Everything hard about running an agent unattended — the
 * iteration ceiling, the spend ceiling, the stall detector, the completion check, the transcript, the worktree,
 * the fleet card, surviving a killed daemon — was solved once in loops/ and this file calls it. What is left
 * here is genuinely only the graph: who waits for whom, who is handed what, and what happens to the rest when
 * one of them fails.
 *
 * NO TOPOLOGICAL SORT. Each step is one memoized promise that first awaits its dependencies' promises, so the
 * ordering falls out of the awaits. Fan-out, fan-in and diamonds all work with no special case, a step starts
 * the instant its own dependencies are done rather than when its "layer" is, and the code cannot disagree with
 * the graph because it never builds a second representation of it.
 *
 * FAILURE STOPS A BRANCH, NOT THE RUN. A step whose loop ended in anything but `done` fails, and everything
 * downstream of it is `skipped` — the branch beside it keeps going. That is the useful behaviour and also the
 * honest one: a run that reported eleven failures when one step broke would be telling you eleven times about
 * one problem while hiding the parts that worked.
 */

// A run id short enough that `wf-<runId>-<stepId>` stays inside a conversation id's 64 characters, and random
// enough that two runs of one workflow never collide — a collision here would mean two runs sharing worktrees.
const runIdOf = (): string => randomUUID().slice(0, 8);

// How much of a step's closing text is kept on the record. Enough to hand forward and to read on the node;
// the transcript is where the whole thing lives.
const REPORT_KEPT = 4_000;

// Runs in flight, keyed by run id. A module singleton for the same reason the loop pump's is: the routes, the
// boot resume and the tests all have to see the same set.
const running = new Map<string, { readonly abort: AbortController }>();

export const workflowRunning = (runId: string): boolean => running.has(runId);

/* Ask a run to stop. No step that has not started will start, and the steps in flight stop after their current
 * ITERATION rather than being killed — same split as stopping a loop, and the same reason: a step on iteration
 * 6 doing good work should be allowed to be its own last one. Returns false when nothing was running.
 */
export const stopWorkflowRun = (runId: string): boolean => {
    const live = running.get(runId);
    live?.abort.abort();
    return live !== undefined;
};

/* Open a run record: every step `pending`, every conversation already named. Written before anything starts,
 * so the graph is complete from the first frame the UI sees — a node that only appears once it runs makes
 * "waiting" and "not part of this run" the same picture.
 */
export const openRun = (workflow: Workflow, now: number): WorkflowRun => {
    const runId = runIdOf();
    const conversations = stepConversations(runId, workflow.steps);
    return {
        runId,
        workflow,
        state: "running",
        startedAt: now,
        resumed: 0,
        steps: workflow.steps.map((step): WorkflowStepRun => ({
            stepId: step.id,
            state: "pending",
            conversationId: conversations.get(step.id) ?? "",
            iterations: 0,
        })),
    };
};

/* A slot limiter, not a queue: `maxParallel` steps may be inside their loop at once and the rest wait here.
 *
 * The cap is on the LOOP, deliberately, and not on the whole step promise — a step spends most of its life
 * awaiting dependencies, and counting that as occupancy would let a wide graph deadlock itself, every slot held
 * by a step waiting for one that cannot get a slot.
 */
const slots = (limit: number) => {
    let free = limit;
    const waiting: (() => void)[] = [];
    return {
        take: async (): Promise<void> => {
            if (free > 0) {
                free -= 1;
                return;
            }
            await new Promise<void>((resolve) => waiting.push(resolve));
        },
        give: (): void => {
            const next = waiting.shift();
            if (next === undefined) {
                free += 1;
                return;
            }
            next();
        },
    };
};

// How a step turned out, as the steps after it need to read it. `ok` is the only thing the graph branches on;
// the rest is what gets handed forward.
interface StepOutcome {
    readonly ok: boolean;
    readonly document: LoopDocument | undefined;
    readonly report: string;
}

const BLOCKED: StepOutcome = { ok: false, document: undefined, report: "" };

// The loop that runs one step. Everything but the prompt comes straight off the step — a step IS a loop
// declaration plus a place in the graph, and this is where that stops being a metaphor.
const loopForStep = (step: WorkflowStep, workflow: Workflow, conversationId: string, prompt: string): Loop => ({
    conversationId,
    goal: step.goal,
    prompt,
    context: step.context,
    output: step.output,
    checks: step.checks,
    maxIterations: step.maxIterations,
    ...(step.maxSpendUsd !== undefined ? { maxSpendUsd: step.maxSpendUsd } : {}),
    stallLimit: step.stallLimit,
    isolated: workflow.isolated,
    ...(step.agent !== undefined ? { agent: step.agent } : {}),
    ...(step.harness !== undefined ? { harness: step.harness } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}),
});

/* Drive one run to completion. Resolves when the run ends, however it ends; it never rejects, for the reason
 * runLoop does not — every caller is fire-and-forget and a run that failed has a state to say so with.
 *
 * `run` is the record as it stands, which on a resume already holds finished steps. Those are replayed from
 * the record rather than re-run: see `recorded` below.
 */
export const runWorkflow = async (services: Services, run: WorkflowRun, fn: TurnFn): Promise<void> => {
    const { runId, workflow } = run;
    if (running.has(runId)) {
        return;
    }
    const abort = new AbortController();
    running.set(runId, { abort });

    const byId = new Map(workflow.steps.map((step) => [step.id, step]));
    const position = new Map(workflow.steps.map((step, index) => [step.id, index + 1]));
    const recorded = new Map(run.steps.map((step) => [step.stepId, step]));
    const gate = slots(workflow.maxParallel);
    const outcomes = new Map<string, Promise<StepOutcome>>();
    // The run's running total, shared across parallel steps. Read before a step starts and never mid-step: a
    // ceiling that could interrupt a turn would leave a tree half-edited, which costs more than the turn did.
    let spentUsd = run.steps.reduce((total, step) => total + (step.costUsd ?? 0), 0);
    let ceiling: { readonly state: WorkflowRunState; readonly detail: string } | undefined;

    const close = (stepId: string, state: WorkflowStepRun["state"], detail: string): Promise<void> =>
        services.workflowRuns.patchStep(runId, stepId, { state, endedAt: Date.now(), detail });

    const execute = async (step: WorkflowStep, conversationId: string, handovers: readonly Handover[]): Promise<StepOutcome> => {
        const index = position.get(step.id) ?? 1;
        const prompt = briefForStep(workflow, step, index, handovers);
        /* Tell the fleet card what this conversation is now part of, BEFORE the loop starts — the card exists
         * from the loop's first iteration, and a card that says nothing for the first minute of a four-minute
         * step is a card that says nothing. A `continue` step overwrites its predecessor's entry, which is
         * right: one conversation, and the name of what it is doing has moved on. */
        workflowProjection.set(conversationId, { runId, name: workflow.name, step: step.title, index, total: workflow.steps.length });
        await services.workflowRuns.patchStep(runId, step.id, { state: "running", startedAt: Date.now() });
        /* A fresh loop record per step, even for one that shares its predecessor's conversation. The loops
         * manifest is keyed by conversation and holds the LATEST loop on it, so a continued step replaces the
         * row of the step it continued — right for a per-conversation view, and lossless for the user, because
         * the run record below is what carries each step's own history. */
        const record = await services.loops.start(loopForStep(step, workflow, conversationId, prompt), Date.now());
        /* Stopping the RUN has to reach a loop that is already turning, and the loop pump's own signal is
         * private to it — `stopLoop` is the door. The listener covers a stop that arrives during the step; the
         * check right after covers one that landed in the instant between the guard above and here, which is
         * safe to do because runLoop registers the conversation synchronously before its first await. */
        const relay = (): void => void stopLoop(conversationId);
        abort.signal.addEventListener("abort", relay, { once: true });
        const settling = runLoop(services, record, fn);
        if (abort.signal.aborted) {
            relay();
        }
        const settlement = await settling.finally(() => abort.signal.removeEventListener("abort", relay));
        const ok = settlement.state === "done";
        const report = settlement.report.slice(-REPORT_KEPT);
        await services.workflowRuns.patchStep(runId, step.id, {
            state: ok ? "done" : settlement.state === "stopped" ? "stopped" : "failed",
            endedAt: Date.now(),
            iterations: settlement.iterations,
            costUsd: settlement.costUsd,
            loopState: settlement.state,
            ...(settlement.detail !== undefined ? { detail: settlement.detail } : {}),
            ...(settlement.document !== undefined ? { document: settlement.document } : {}),
            ...(report !== "" ? { report } : {}),
        });
        spentUsd += settlement.costUsd;
        return { ok, document: settlement.document, report };
    };

    const outcomeOf = (step: WorkflowStep): Promise<StepOutcome> => {
        const started = outcomes.get(step.id);
        if (started !== undefined) {
            return started;
        }
        const promise = (async (): Promise<StepOutcome> => {
            /* A step that already finished in a previous life of this run is replayed off the record, not
             * re-run. This is what makes a resume worth having: the eight-minute analysis step that succeeded
             * before the container was rebuilt is not paid for twice, and the step after it is handed exactly
             * what it would have been handed. A step that was mid-flight is NOT replayed — its loop's history
             * was cut off at the same instant, and resuming from a half-known position means reasoning about a
             * tree nobody saw. It starts over. */
            const before = recorded.get(step.id);
            if (before?.state === "done") {
                return { ok: true, document: before.document, report: before.report ?? "" };
            }
            const upstream = await Promise.all(
                step.needs
                    .map((need) => byId.get(need))
                    .filter((parent): parent is WorkflowStep => parent !== undefined)
                    .map(async (parent) => ({ parent, outcome: await outcomeOf(parent) })),
            );
            /* The stop is asked about BEFORE the upstream verdict, and the order is the whole difference
             * between two readings of the same board. A step whose predecessor was cut off mid-iteration is,
             * strictly, a step whose predecessor did not finish — but reporting it that way turns "you pressed
             * Stop" into a cascade of failures the user has to trace back to find out they caused it. Stopped
             * beats skipped whenever both are true. */
            if (abort.signal.aborted) {
                await close(step.id, "stopped", "The run was stopped before this step started.");
                return BLOCKED;
            }
            const blocked = upstream.filter((entry) => !entry.outcome.ok);
            if (blocked.length > 0) {
                await close(step.id, "skipped", `Did not run: ${blocked.map((entry) => `"${entry.parent.title}"`).join(", ")} did not finish.`);
                return BLOCKED;
            }
            /* The run's spend ceiling, checked HERE — before a step starts, with every upstream cost already
             * counted. This is the one guard a per-step ceiling cannot give: eight steps each under their own
             * $2 cap is a $16 run, and the second number is the one a person actually cares about. */
            if (workflow.maxSpendUsd !== undefined && spentUsd >= workflow.maxSpendUsd) {
                ceiling = {
                    state: "overspent",
                    detail: `Spent $${spentUsd.toFixed(2)} of the $${workflow.maxSpendUsd.toFixed(2)} ceiling before every step had run.`,
                };
                await close(step.id, "skipped", "Did not run: the workflow reached its spend ceiling.");
                return BLOCKED;
            }
            const conversationId = before?.conversationId ?? "";
            // The branch is named only when this step CANNOT simply look at the work: an isolated run puts each
            // fresh session in its own worktree off main, while a step that shares its predecessor's
            // conversation is already standing in the tree that branch describes.
            const handoverFrom = (entry: { parent: WorkflowStep; outcome: StepOutcome }): Handover => {
                const parentConversation = recorded.get(entry.parent.id)?.conversationId;
                const separate = workflow.isolated && parentConversation !== undefined && parentConversation !== conversationId;
                return {
                    title: entry.parent.title,
                    document: entry.outcome.document,
                    report: entry.outcome.report,
                    ...(separate ? { branch: `agent/${parentConversation}` } : {}),
                };
            };
            const handovers: Handover[] = upstream.map(handoverFrom);
            await gate.take();
            try {
                return await execute(step, conversationId, handovers);
            } finally {
                gate.give();
            }
        })();
        outcomes.set(step.id, promise);
        return promise;
    };

    try {
        const settled = await Promise.all(workflow.steps.map((step) => outcomeOf(step)));
        const failed = settled.filter((outcome) => !outcome.ok).length;
        const state: WorkflowRunState = ceiling?.state ?? (abort.signal.aborted ? "stopped" : failed === 0 ? "done" : "failed");
        const detail =
            ceiling?.detail ??
            (failed === 0
                ? undefined
                : `${failed} of ${workflow.steps.length} steps did not finish. Open the ones marked failed — the ones marked skipped were waiting on them.`);
        await services.workflowRuns.settle(runId, state, Date.now(), detail);
    } catch (error) {
        // Only the scheduler's own machinery reaches here — a store write that could not land. A step's failure
        // is a step outcome and never gets this far.
        services.logger.error({ err: error, runId }, "workflow run failed");
        await services.workflowRuns
            .settle(runId, "error", Date.now(), error instanceof Error ? error.message : "the run failed")
            .catch(() => undefined);
    } finally {
        running.delete(runId);
    }
};

/* THE BOOT PASS — every run the daemon died under, picked back up.
 *
 * The ledger is its own journal, exactly as the loops manifest is: a run still marked `running` when this runs
 * is by construction one no `settle` ever reached. It matters more here than anywhere else in the sandbox,
 * because a run is the longest-lived thing in it and the container is recreated on every sandbox update, every
 * environment approval and every dev swap — so intentic's own flows are the main thing that kills a run.
 *
 * The resume counter is what keeps it safe. A run whose step reliably takes the daemon with it would otherwise
 * come back on every boot forever; past RESUME_MAX it is settled as `error` and left alone, with the record
 * saying exactly that.
 */
const RESUME_MAX = 2;

export const resumeWorkflowRuns = async (services: Services, fn: TurnFn): Promise<string[]> => {
    const resumed: string[] = [];
    for (const run of await services.workflowRuns.list()) {
        if (run.state !== "running" || running.has(run.runId)) {
            continue;
        }
        const counted = await services.workflowRuns.countResume(run.runId);
        if (counted === undefined) {
            continue;
        }
        if (counted.resumed > RESUME_MAX) {
            await services.workflowRuns.settle(
                run.runId,
                "error",
                Date.now(),
                `Abandoned after the daemon died under this run ${counted.resumed} times.`,
            );
            services.logger.warn({ runId: run.runId }, "workflow: abandoned after repeated daemon deaths");
            continue;
        }
        resumed.push(run.runId);
        void runWorkflow(services, counted, fn);
    }
    return resumed;
};
