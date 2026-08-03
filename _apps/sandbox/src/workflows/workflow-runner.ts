import { randomUUID } from "node:crypto";
import type { Loop, LoopDocument, Workflow, WorkflowRun, WorkflowRunState, WorkflowStep, WorkflowStepRun } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
// The turn registry's own abort — agent-steering is a leaf (a Map of live turns), so this is not the cycle
// through agent.routes that loop-runner's header warns about.
import { stopTurn } from "../agent/agent-steering.js";
import { runLoop, stopLoop, type TurnFn } from "../loops/loop-runner.js";
import { briefForStep, type Handover, stepConversations } from "./workflow-brief.js";
import { workflowProjection } from "./workflow-state.js";

/* THE SCHEDULER — run a graph of steps, each one a loop, in dependency order.
 *
 * DAEMON-SIDE, for the reason loops are and more so. One turn survives a closed browser on its own; a sequence
 * does not, and a workflow is a sequence of sequences that can run for hours. So the browser watches and
 * nothing else drives.
 *
 * A STEP IS A LOOP AND THE LOOP DOES THE WORK. Everything hard about running an agent unattended — the runaway
 * backstops, the completion check, the transcript, the worktree, the fleet card, surviving a killed daemon —
 * was solved once in loops/ and this file calls it. What is left
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

/* Stop a run: nothing that has not started will start, and the steps in flight are CUT OFF where they are.
 * Returns false when nothing was running.
 *
 * IT ABORTS THE TURNS, and that is a deliberate departure from how a loop's own Stop behaves. A loop asks its
 * iteration to be the last one, on the argument that a step doing good work should get to finish the round it
 * is on — which is right for a loop, whose Stop is pressed by someone watching that one agent. It is wrong
 * here. A workflow's round is an entire agent turn: minutes, sometimes many. Pressing Stop on a run and
 * watching it keep working, keep spending and keep asking questions for the next ten minutes is not a graceful
 * stop, it is a button that appears not to work — which is exactly how it was reported.
 *
 * The turn's own abort is what the user's /agent/stop does, so a stopped step lands the same way as one the
 * user stopped by hand: whatever it had written stays on its branch, and the loop's next iteration never
 * begins because the run's signal has already told it not to.
 */
export const stopWorkflowRun = (runId: string): boolean => {
    const live = running.get(runId);
    live?.abort.abort();
    return live !== undefined;
};

/* CLOSE A RUN NOTHING IS DRIVING — the exit from a record that says `running` while no scheduler is behind it.
 *
 * It happens, and when it does the run is unkillable: `stopWorkflowRun` finds nothing to abort, the route it
 * serves answers "that run is not going", and the ledger goes on reporting a live workflow with a step still
 * marked `running` forever. The board then shows a card with a Stop that cannot work and a step count that
 * will never move. Two ways in, both ordinary: the daemon was replaced mid-run (a sandbox update, an
 * environment approval, a dev swap) and the boot resume had already spent this run's RESUME_MAX; or the
 * process died between a step settling and the run being settled.
 *
 * Marking the steps matters as much as the run. "1 live" on the card is counted off the STEPS, so a run
 * settled with a step left `running` still reads as working — and the diagram would still offer to open a
 * session that ended with the daemon that was running it.
 */
export const abandonRun = async (services: Services, run: WorkflowRun, now: number): Promise<void> => {
    const unfinished = run.steps.filter((step) => step.state === "running" || step.state === "pending").map((step) => step.stepId);
    if (unfinished.length > 0) {
        await services.workflowRuns.markSteps(run.runId, unfinished, "stopped", "Nothing was driving this run when it was stopped.");
    }
    await services.workflowRuns.settle(run.runId, "stopped", now, "Stopped. Nothing was driving this run — the daemon it started under is gone.");
};

/* Open a run record: every step `pending`, every conversation already named. Written before anything starts,
 * so the graph is complete from the first frame the UI sees — a node that only appears once it runs makes
 * "waiting" and "not part of this run" the same picture.
 */
export const openRun = (workflow: Workflow, now: number, request?: string): WorkflowRun => {
    const runId = runIdOf();
    const conversations = stepConversations(runId, workflow.steps);
    return {
        runId,
        workflow,
        ...(request !== undefined && request.trim() !== "" ? { request: request.trim() } : {}),
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

/* THE BACKSTOPS, and they are backstops rather than settings — which is why they are constants here instead of
 * three fields on every step. A step runs like any other agent session: until it is done, or until you stop
 * it. What these bound is the failure nobody chose — an agent that re-reads the same three files, restates the
 * same plan and declares more work remains, forever, on a workflow that was started and walked away from.
 *
 * Generous, deliberately: they must never be what ENDS a step doing real work, only what ends one that has
 * stopped doing any. The idle-round count is the one that actually fires in practice (a round that changed
 * nothing in the tree is the shape a stuck agent has), and three of those in a row is not a bad patch.
 */
const STEP_ROUNDS_MAX = 20;
const STEP_IDLE_ROUNDS = 3;

/* The loop that runs one step. Everything but the prompt, the goal and the backstops comes straight off the
 * step — a step IS a loop declaration plus a place in the graph, and this is where that stops being a metaphor.
 *
 * `goal` is passed in because a step may not have one: absent, the run's own request is what the step is
 * measured against (WorkflowStepSchema), which is the ordinary case for a design written as a shape. Resolving
 * it at the call site keeps the fallback in one place with the prompt's.
 *
 * THE ORDINARY STEP IS ONE TURN, and the ceiling says so rather than implying twenty. A step with nothing to
 * produce and nothing to check is finished when its turn is finished — loop-stop's `readDocument` answers
 * `done` for a `none` output, so iteration 1 was always the only one. Recording 20 anyway put "Iteration 1 of
 * at most 20" in the prompt and a ceiling on the loops manifest that no step could ever approach: a number
 * describing machinery rather than the job.
 */
const loopForStep = (step: WorkflowStep, conversationId: string, prompt: string, goal: string): Loop => ({
    conversationId,
    goal,
    prompt,
    context: step.context,
    output: step.output,
    checks: step.checks,
    maxIterations: step.output.kind === "none" && step.checks.length === 0 ? 1 : STEP_ROUNDS_MAX,
    stallLimit: STEP_IDLE_ROUNDS,
    // Always. A workflow step is an isolated agent session, and there is no longer a way to ask for anything
    // else (see WorkflowSchema).
    isolated: true,
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

    const close = (stepId: string, state: WorkflowStepRun["state"], detail: string): Promise<void> =>
        services.workflowRuns.patchStep(runId, stepId, { state, endedAt: Date.now(), detail });

    const execute = async (step: WorkflowStep, conversationId: string, handovers: readonly Handover[]): Promise<StepOutcome> => {
        const index = position.get(step.id) ?? 1;
        const prompt = briefForStep(workflow, step, index, handovers, run.request);
        /* The step's own goal, or the run's request when it declares none — the same fallback the prompt makes
         * one line above, and the reason a design can be a shape at all. `??` rather than a check: a run that
         * would leave both empty never gets this far (workflowRunFaults refuses it at the door), so there is no
         * third case to write and nothing here that could hand the loop an empty bar. */
        const goal = step.goal ?? run.request ?? "";
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
        const record = await services.loops.start(loopForStep(step, conversationId, prompt, goal), Date.now());
        /* Stopping the RUN has to reach a loop that is already turning, and the loop pump's own signal is
         * private to it — `stopLoop` is the door. The listener covers a stop that arrives during the step; the
         * check right after covers one that landed in the instant between the guard above and here, which is
         * safe to do because runLoop registers the conversation synchronously before its first await.
         *
         * BOTH DOORS, and the second is the one that makes Stop mean anything. `stopLoop` ends the LOOP — no
         * further iteration — while the iteration already in flight runs to completion, and an iteration here
         * is a whole agent turn. So a run stopped at minute one went on thinking, spending and (this is what
         * gave it away) asking the user questions until its turn happened to end. `stopTurn` is the abort
         * behind /agent/stop: the turn is cut off where it stands and the step settles as stopped, which is
         * what a person means when they press Stop on a run. `stopping` publishes it to the fleet card
         * immediately, ahead of the unwind, so the board stops claiming the step is working. */
        const relay = (): void => {
            void stopLoop(conversationId);
            if (stopTurn(conversationId)) {
                services.agents.stopping(conversationId);
            }
        };
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
            const conversationId = before?.conversationId ?? "";
            // The branch is named only when this step CANNOT simply look at the work: every fresh session is
            // in its own worktree off main, while a step that shares its predecessor's conversation is already
            // standing in the tree that branch describes.
            const handoverFrom = (entry: { parent: WorkflowStep; outcome: StepOutcome }): Handover => {
                const parentConversation = recorded.get(entry.parent.id)?.conversationId;
                const separate = parentConversation !== undefined && parentConversation !== conversationId;
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
                /* ASKED AGAIN ON THE FAR SIDE OF THE SLOT, and it is not the same question as the one above.
                 *
                 * A wide graph QUEUES here: `maxParallel` is two by default, so a fan-out of six leaves four
                 * steps waiting, and a step waits as long as the steps ahead of it take — a whole agent turn
                 * each. A run stopped anywhere in that window found the guard above long since passed, and the
                 * step walked into `execute` anyway: published to the fleet card, written `running` in the
                 * ledger, a loop record opened on its conversation.
                 *
                 * NO TURN WAS EVER WASTED — runLoop asks its own stop signal before it calls one, and the relay
                 * inside `execute` reaches it first — so this is bookkeeping rather than money. It is
                 * bookkeeping two surfaces read, which is why it is worth a second guard: a step flickering
                 * into `running` after the user pressed Stop is the one thing a stop must never look like, and
                 * a loops manifest carrying a row for a step that ran no iteration is a lie about what
                 * happened. Settling it as never-started says the true thing instead.
                 */
                if (abort.signal.aborted) {
                    await close(step.id, "stopped", "The run was stopped before this step started.");
                    return BLOCKED;
                }
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
        const state: WorkflowRunState = abort.signal.aborted ? "stopped" : failed === 0 ? "done" : "failed";
        const detail =
            failed === 0
                ? undefined
                : `${failed} of ${workflow.steps.length} steps did not finish. Open the ones marked failed — the ones marked skipped were waiting on them.`;
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
