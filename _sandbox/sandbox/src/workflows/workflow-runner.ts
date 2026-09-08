import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    Loop,
    LoopDocument,
    LoopState,
    RepoBase,
    Workflow,
    WorkflowRun,
    WorkflowRunState,
    WorkflowStep,
    WorkflowStepRun,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { stopTurn } from "../agent/anchors/agent-steering.js";
import { resumeLoops, runLoop, stopLoop, type TurnFn } from "../loops/loop-runner.js";
import { resolvedBranches } from "./handover-branches.js";
import { briefForStep, type Handover, stepConversations } from "./workflow-brief.js";
import { workflowProjection } from "./workflow-state.js";
import { stateRelPath } from "../workspace/layout/state-paths.js";

// Scheduler: runs a graph of steps, each a loop, in dependency order; daemon-side since a workflow can run for hours
// past a closed browser. No topological sort: each step is a memoized promise awaiting its dependencies. A step's
// failure skips everything downstream of it; the rest of the graph keeps going.

// Short enough that `wf-<runId>-<stepId>` fits 64 chars; random enough that two runs never collide.
const runIdOf = (): string => randomUUID().slice(0, 8);

// How much closing text stays inline; the full response is in shared state, handed on by path.
const REPORT_KEPT = 4_000;
// Under artifacts/, the durable-output class a run's full response belongs to.
const WORKFLOW_REPORTS_DIR = stateRelPath(".intentic/records/artifacts/", "workflow-runs");

const reportPreview = (report: string): string => {
    if (report.length <= REPORT_KEPT) {
        return report;
    }
    const half = REPORT_KEPT / 2;
    return `${report.slice(0, half)}\n\n[… full response saved as a workflow artifact …]\n\n${report.slice(-half)}`;
};

const persistReport = async (root: string, runId: string, stepId: string, report: string): Promise<string | undefined> => {
    if (report === "") {
        return undefined;
    }
    const relative = `${WORKFLOW_REPORTS_DIR}/${runId}/${stepId}.md`;
    await mkdir(join(root, WORKFLOW_REPORTS_DIR, runId), { recursive: true });
    await writeFile(join(root, relative), report);
    return relative;
};

// Runs in flight, keyed by run id; a module singleton so routes, boot resume and tests see the same set.
const running = new Map<string, { readonly abort: AbortController }>();

export const workflowRunning = (runId: string): boolean => running.has(runId);

// Stops nothing not yet started and cuts off in-flight steps immediately, unlike a loop's Stop, which finishes the
// current iteration: a workflow round is a whole agent turn. Returns false when nothing was running.
export const stopWorkflowRun = (runId: string): boolean => {
    const live = running.get(runId);
    live?.abort.abort();
    return live !== undefined;
};

// Closes a run left `running` with no scheduler behind it (the daemon that drove it is gone). Marks unfinished steps
// `stopped` too: "live" is counted off the steps, not the run, so settling only the run would still read as working.
export const abandonRun = async (services: Services, run: WorkflowRun, now: number): Promise<void> => {
    const unfinished = run.steps.filter((step) => step.state === "running" || step.state === "pending").map((step) => step.stepId);
    if (unfinished.length > 0) {
        await services.workflowRuns.markSteps(run.runId, unfinished, "stopped", "Nothing was driving this run when it was stopped.");
    }
    await services.workflowRuns.settle(run.runId, "stopped", now, "Stopped. Nothing was driving this run: the daemon it started under is gone.");
};

// Opens a run record with every step `pending` and every conversation already named, written before anything starts so
// the graph is complete in the first frame the UI sees.
export const openRun = (workflow: Workflow, repos: readonly RepoBase[], now: number, request?: string): WorkflowRun => {
    const runId = runIdOf();
    const conversations = stepConversations(runId, workflow.steps);
    return {
        runId,
        workflow,
        repos: [...repos],
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

// Slot limiter, not a queue: `maxParallel` steps may be inside their loop at once, the rest wait. The cap is on the
// loop, not the whole step promise, since counting time spent awaiting dependencies could deadlock a wide graph.
const slots = (limit: number) => {
    let free = limit;
    const waiting: { readonly resolve: (taken: boolean) => void; readonly signal?: AbortSignal; readonly aborted?: () => void }[] = [];
    return {
        take: async (signal?: AbortSignal): Promise<boolean> => {
            if (signal?.aborted === true) {
                return false;
            }
            if (free > 0) {
                free -= 1;
                return true;
            }
            return await new Promise<boolean>((resolve) => {
                const entry: { resolve: (taken: boolean) => void; signal?: AbortSignal; aborted?: () => void } = { resolve };
                if (signal !== undefined) {
                    entry.signal = signal;
                    entry.aborted = () => {
                        const index = waiting.indexOf(entry);
                        if (index !== -1) {
                            waiting.splice(index, 1);
                            resolve(false);
                        }
                    };
                    signal.addEventListener("abort", entry.aborted, { once: true });
                }
                waiting.push(entry);
            });
        },
        give: (): void => {
            const next = waiting.shift();
            if (next === undefined) {
                free += 1;
                return;
            }
            if (next.signal !== undefined && next.aborted !== undefined) {
                next.signal.removeEventListener("abort", next.aborted);
            }
            next.resolve(true);
        },
    };
};

// Sandbox-wide cap across all workflow graphs, independent of each graph's maxParallel.
const WORKFLOW_RUNS_MAX = 4;
const workflowSlots = slots(WORKFLOW_RUNS_MAX);

// How a step turned out, for the steps after it; `ok` is the only field the graph branches on, the rest is handed
// forward.
interface StepOutcome {
    readonly ok: boolean;
    readonly document: LoopDocument | undefined;
    readonly report: string;
    readonly reportPath: string | undefined;
    readonly loopState: LoopState | undefined;
}

const BLOCKED: StepOutcome = { ok: false, document: undefined, report: "", reportPath: undefined, loopState: undefined };

// Backstops, not settings: generous, since only a step that has stopped doing real work should ever hit them.
const STEP_ROUNDS_MAX = 20;
const STEP_IDLE_ROUNDS = 3;

// Builds the loop for one step; everything but the prompt and goal comes off the step. Nothing to produce or check gets
// a ceiling of 1 turn, already finished when the turn ends; the model is never told the ceiling.
const loopForStep = (step: WorkflowStep, repos: readonly RepoBase[], conversationId: string, prompt: string, goal: string): Loop => ({
    conversationId,
    goal,
    prompt,
    context: step.context,
    output: step.output,
    checks: step.checks,
    maxIterations: step.output.kind === "none" && step.checks.length === 0 ? 1 : STEP_ROUNDS_MAX,
    stallLimit: STEP_IDLE_ROUNDS,
    ...(step.maxSpendUsd !== undefined ? { maxSpendUsd: step.maxSpendUsd } : {}),
    // Always: a workflow step is an isolated session, with no way to ask for anything else (WorkflowSchema).
    isolated: true,
    ...(step.agent !== undefined ? { agent: step.agent } : {}),
    ...(step.harness !== undefined ? { harness: step.harness } : {}),
    ...(step.account !== undefined ? { account: step.account } : {}),
    ...(step.model !== undefined ? { model: step.model } : {}),
    ...(step.actsAs !== undefined ? { actsAs: step.actsAs } : {}),
    worktreeBase: [...repos],
    // A candidate branch is a workflow input until chosen: auto-land must never merge it in early.
    autoLand: false,
});

// Drives one run to completion; resolves however the run ends and never rejects, since every caller is fire-and-forget.
// Finished steps from a resume replay off the record instead of re-running.
export const runWorkflow = async (services: Services, run: WorkflowRun, fn: TurnFn): Promise<void> => {
    const { runId, workflow } = run;
    if (running.has(runId)) {
        return;
    }
    const abort = new AbortController();
    running.set(runId, { abort });
    const acquired = await workflowSlots.take(abort.signal);
    if (!acquired) {
        await abandonRun(services, run, Date.now());
        running.delete(runId);
        return;
    }

    const byId = new Map(workflow.steps.map((step) => [step.id, step]));
    const position = new Map(workflow.steps.map((step, index) => [step.id, index + 1]));
    const recorded = new Map(run.steps.map((step) => [step.stepId, step]));
    const gate = slots(workflow.maxParallel);
    const outcomes = new Map<string, Promise<StepOutcome>>();

    const close = (stepId: string, state: WorkflowStepRun["state"], detail: string): Promise<void> =>
        services.workflowRuns.patchStep(runId, stepId, { state, endedAt: Date.now(), detail });

    const execute = async (step: WorkflowStep, conversationId: string, handovers: readonly Handover[]): Promise<StepOutcome> => {
        const index = position.get(step.id) ?? 1;
        const prompt = briefForStep(step, handovers, run.request);
        // Falls back to the run's request, same fallback the prompt uses; a run leaving both empty is refused earlier.
        const goal = step.goal ?? run.request ?? "";
        // Set before the loop starts, so the fleet card is never blank; a `continue` step overwrites its predecessor.
        workflowProjection.set(conversationId, { runId, name: workflow.name, step: step.title, index, total: workflow.steps.length });
        await services.workflowRuns.patchStep(runId, step.id, { state: "running", startedAt: Date.now() });
        // Fresh loop record per step: the manifest keeps only the latest per conversation.
        const record = await services.loops.start(loopForStep(step, run.repos, conversationId, prompt, goal), Date.now());
        // Two doors: `stopLoop` ends the loop, `stopTurn` aborts the turn in flight, since an iteration here is a whole
        // turn. The check right after catches a stop landing in the gap before this point.
        const relay = (): void => {
            void stopLoop(conversationId);
            if (stopTurn(conversationId)) {
                services.agents.stopping(conversationId, "stopped");
            }
        };
        abort.signal.addEventListener("abort", relay, { once: true });
        const settling = runLoop(services, record, fn);
        if (abort.signal.aborted) {
            relay();
        }
        const settlement = await settling.finally(() => abort.signal.removeEventListener("abort", relay));
        const ok = settlement.state === "done";
        const reportPath = await persistReport(services.workspace.root, runId, step.id, settlement.report);
        const report = reportPreview(settlement.report);
        await services.workflowRuns.patchStep(runId, step.id, {
            state: ok ? "done" : settlement.state === "stopped" ? "stopped" : "failed",
            endedAt: Date.now(),
            iterations: settlement.iterations,
            costUsd: settlement.costUsd,
            loopState: settlement.state,
            ...(settlement.detail !== undefined ? { detail: settlement.detail } : {}),
            ...(settlement.document !== undefined ? { document: settlement.document } : {}),
            ...(report !== "" ? { report } : {}),
            ...(reportPath !== undefined ? { reportPath } : {}),
        });
        return { ok, document: settlement.document, report, reportPath, loopState: settlement.state };
    };

    const outcomeOf = (step: WorkflowStep): Promise<StepOutcome> => {
        const started = outcomes.get(step.id);
        if (started !== undefined) {
            return started;
        }
        const promise = (async (): Promise<StepOutcome> => {
            // A step already `done` from a previous life of this run replays off the record rather than re-running; a
            // step that was mid-flight when the daemon died starts over, its loop history stopped at the same instant.
            const before = recorded.get(step.id);
            if (before?.state === "done") {
                return {
                    ok: true,
                    document: before.document,
                    report: before.report ?? "",
                    reportPath: before.reportPath,
                    loopState: before.loopState,
                };
            }
            const upstream = await Promise.all(
                step.needs
                    .map((need) => byId.get(need))
                    .filter((parent): parent is WorkflowStep => parent !== undefined)
                    .map(async (parent) => ({ parent, outcome: await outcomeOf(parent) })),
            );
            // Stop is checked before the upstream verdict: a step whose predecessor was cut off by Stop would otherwise
            // report as a chain of failures instead of one stop. Stopped beats skipped whenever both are true.
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
            // Branch is named only when the step can't just look at the work: a fresh session gets its own worktree; a
            // continuing step already stands in it. Resolved before naming, since unresolved can name nothing.
            const handoverFrom = async (entry: { parent: WorkflowStep; outcome: StepOutcome }): Promise<Handover> => {
                const parentConversation = recorded.get(entry.parent.id)?.conversationId;
                const separate = parentConversation !== undefined && parentConversation !== conversationId;
                const branches = separate ? await resolvedBranches(services.workspace.root, run.repos, `agent/${parentConversation}`) : undefined;
                return {
                    title: entry.parent.title,
                    document: entry.outcome.document,
                    report: entry.outcome.report,
                    ...(entry.outcome.reportPath !== undefined ? { reportPath: entry.outcome.reportPath } : {}),
                    ...(branches !== undefined ? { branches } : {}),
                };
            };
            const handovers: Handover[] = await Promise.all(upstream.map(handoverFrom));
            await gate.take();
            try {
                // Checked again past the parallelism gate: a stopped run could otherwise let a queued step start
                // anyway. No turn is wasted, runLoop checks its own stop first; this only keeps bookkeeping honest.
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
        const overspent = settled.some((outcome) => outcome.loopState === "overspent");
        const state: WorkflowRunState = abort.signal.aborted ? "stopped" : overspent ? "overspent" : failed === 0 ? "done" : "failed";
        const detail =
            failed === 0
                ? undefined
                : `${failed} of ${workflow.steps.length} steps did not finish. Open the ones marked failed, the ones marked skipped were waiting on them.`;
        await services.workflowRuns.settle(runId, state, Date.now(), detail);
    } catch (error) {
        // Only the scheduler's own machinery reaches here; a step's own failure is a step outcome, not an exception.
        services.logger.error({ err: error, runId }, "workflow run failed");
        await services.workflowRuns
            .settle(runId, "error", Date.now(), error instanceof Error ? error.message : "the run failed")
            .catch(() => undefined);
    } finally {
        workflowSlots.give();
        running.delete(runId);
    }
};

// A run still `running` here is one the daemon died under; container recreation is the main way that happens. Past
// RESUME_MAX tries, the run settles as `error` instead of coming back forever.
const RESUME_MAX = 2;

const resumeWorkflowRuns = async (services: Services, fn: TurnFn, candidates?: readonly WorkflowRun[]): Promise<string[]> => {
    const resumed: string[] = [];
    for (const run of candidates ?? (await services.workflowRuns.list())) {
        if (run.state !== "running" || running.has(run.runId)) {
            continue;
        }
        const counted = await services.workflowRuns.countResume(run.runId);
        if (counted === undefined) {
            continue;
        }
        if (counted.resumed > RESUME_MAX) {
            const conversations = new Set(counted.steps.map((step) => step.conversationId));
            await Promise.all(
                [...conversations].map(async (conversationId) => {
                    const loop = await services.loops.get(conversationId);
                    if (loop?.state === "running") {
                        await services.loops.settle(
                            conversationId,
                            "error",
                            Date.now(),
                            `Its workflow was abandoned after ${counted.resumed} daemon restarts.`,
                        );
                    }
                }),
            );
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

// One boot coordinator for both journals: workflow steps are loops, so launching the two recovery passes separately
// would give one loop two drivers. Conversations owned by a running workflow are claimed first.
export const resumeWorkflowExecution = async (services: Services, fn: TurnFn): Promise<void> => {
    const runs = (await services.workflowRuns.list()).filter((run) => run.state === "running");
    const owned = new Set(runs.flatMap((run) => run.steps.map((step) => step.conversationId)));
    await Promise.all([resumeWorkflowRuns(services, fn, runs), resumeLoops(services, fn, owned)]);
};
