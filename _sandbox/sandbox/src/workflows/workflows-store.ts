import {
    type Workflow,
    type WorkflowRun,
    WorkflowRunSchema,
    type WorkflowStepRun,
    type WorkflowStepState,
    WorkflowSchema,
    type WorkflowRunState,
} from "@intentic/sandbox-contract";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

// Two files: `workflows.json` is a manifest the user edits by hand; `workflow-runs.json` is an append-mostly ledger the
// scheduler writes many times per step, bounded and never user-edited. Kept apart so a step write can't clobber a
// design; a deleted workflow's run stays readable since it snapshots its own definition.

// Ended runs the ledger remembers, newest first; a still-running record is never a retention candidate.
const RUNS_KEPT = 50;

export interface WorkflowsStore {
    readonly list: () => Promise<Workflow[]>;
    readonly get: (id: string) => Promise<Workflow | undefined>;
    // Atomic create-or-update: create never overwrites, update never invents a missing design.
    readonly save: (workflow: Workflow, create: boolean) => Promise<"saved" | "conflict" | "missing">;
    // True when a workflow of that id existed and was removed.
    readonly remove: (id: string) => Promise<boolean>;
}

export const fileWorkflowsStore = (path: string): WorkflowsStore => {
    const file = jsonFile<Workflow[]>(path, {
        parse: (raw) => z.array(WorkflowSchema).safeParse(raw).data,
        fallback: () => [],
    });
    return {
        list: () => file.read(),
        get: async (id) => (await file.read()).find((workflow) => workflow.id === id),
        save: async (workflow, create) => {
            let outcome: "saved" | "conflict" | "missing" = "saved";
            await file.update((workflows) => {
                const index = workflows.findIndex((entry) => entry.id === workflow.id);
                if (create && index !== -1) {
                    outcome = "conflict";
                    return workflows;
                }
                if (!create && index === -1) {
                    outcome = "missing";
                    return workflows;
                }
                return create ? [...workflows, workflow] : workflows.map((entry, at) => (at === index ? workflow : entry));
            });
            return outcome;
        },
        remove: async (id) => {
            const before = (await file.read()).length;
            const after = await file.update((workflows) => workflows.filter((workflow) => workflow.id !== id));
            return after.length < before;
        },
    };
};

// Every field optional: the scheduler writes this at three different moments (start, end, skip) and each knows a
// different subset. Omitting doesn't clear a key; only writing over it does.
export type StepPatch = Partial<Omit<WorkflowStepRun, "stepId">>;

export interface WorkflowRunsStore {
    // Newest-started first, the order the list route and UI use.
    readonly list: () => Promise<WorkflowRun[]>;
    readonly get: (runId: string) => Promise<WorkflowRun | undefined>;
    // Opens a run with every step already `pending`, so the graph is complete in the first frame.
    readonly start: (run: WorkflowRun) => Promise<WorkflowRun>;
    readonly patchStep: (runId: string, stepId: string, patch: StepPatch) => Promise<void>;
    // Sets several steps to one state in a single write, e.g. everything downstream of a failure becoming skipped.
    readonly markSteps: (runId: string, stepIds: readonly string[], state: WorkflowStepState, detail?: string) => Promise<void>;
    readonly settle: (runId: string, state: WorkflowRunState, now: number, detail?: string) => Promise<void>;
    // Archives or restores a run without deleting it (unlike `forget`); `undefined` clears the archive stamp.
    readonly setArchived: (runId: string, at: number | undefined) => Promise<void>;
    // Drops a run from the ledger outright; its conversations, branches and transcripts are untouched.
    readonly forget: (runId: string) => Promise<void>;
    // Counts one boot resume against the run, so a repeatedly-crashing step can't be resurrected forever.
    readonly countResume: (runId: string) => Promise<WorkflowRun | undefined>;
}

export const fileWorkflowRunsStore = (path: string): WorkflowRunsStore => {
    const file = jsonFile<WorkflowRun[]>(path, {
        parse: (raw) => z.array(WorkflowRunSchema).safeParse(raw).data,
        fallback: () => [],
    });
    // Find this run, replace it; a run not found is a no-op, not an error, since a scheduler may still be writing to
    // one that already rolled off the ledger.
    const amend = async (runId: string, change: (run: WorkflowRun) => WorkflowRun): Promise<void> => {
        await file.update((runs) => {
            const existing = runs.find((run) => run.runId === runId);
            return existing === undefined ? runs : runs.map((run) => (run === existing ? change(existing) : run));
        });
    };
    const amendSteps = (runId: string, change: (step: WorkflowStepRun) => WorkflowStepRun): Promise<void> =>
        amend(runId, (run) => ({ ...run, steps: run.steps.map(change) }));

    const artifacts = join(dirname(path), "workflow-runs");
    const retained = (runs: readonly WorkflowRun[]): { readonly kept: WorkflowRun[]; readonly evicted: WorkflowRun[] } => {
        const running = runs.filter((run) => run.state === "running");
        const ended = runs.filter((run) => run.state !== "running").slice(0, RUNS_KEPT);
        const kept = [...running, ...ended].toSorted((a, b) => b.startedAt - a.startedAt);
        const ids = new Set(kept.map((run) => run.runId));
        return { kept, evicted: runs.filter((run) => !ids.has(run.runId)) };
    };
    const dropArtifacts = (runs: readonly WorkflowRun[]): Promise<unknown> =>
        Promise.all(runs.map((run) => rm(join(artifacts, run.runId), { recursive: true, force: true })));

    return {
        list: async () => (await file.read()).toSorted((a, b) => b.startedAt - a.startedAt),
        get: async (runId) => (await file.read()).find((run) => run.runId === runId),
        start: async (run) => {
            let evicted: WorkflowRun[] = [];
            await file.update((runs) => {
                const next = retained([run, ...runs]);
                evicted = next.evicted;
                return next.kept;
            });
            await dropArtifacts(evicted);
            return run;
        },
        patchStep: (runId, stepId, patch) => amendSteps(runId, (step) => (step.stepId === stepId ? { ...step, ...patch } : step)),
        markSteps: (runId, stepIds, state, detail) => {
            const wanted = new Set(stepIds);
            return amendSteps(runId, (step) => (wanted.has(step.stepId) ? { ...step, state, ...(detail !== undefined ? { detail } : {}) } : step));
        },
        settle: async (runId, state, now, detail) => {
            let evicted: WorkflowRun[] = [];
            await file.update((runs) => {
                const changed = runs.map((run) =>
                    run.runId === runId ? { ...run, state, endedAt: now, ...(detail !== undefined ? { detail } : {}) } : run,
                );
                const next = retained(changed);
                evicted = next.evicted;
                return next.kept;
            });
            await dropArtifacts(evicted);
        },
        setArchived: (runId, at) => amend(runId, ({ archivedAt: _was, ...run }) => (at === undefined ? run : { ...run, archivedAt: at })),
        forget: async (runId) => {
            await file.update((runs) => runs.filter((run) => run.runId !== runId));
            await rm(join(artifacts, runId), { recursive: true, force: true });
        },
        countResume: async (runId) => {
            await amend(runId, (run) => ({ ...run, resumed: run.resumed + 1 }));
            return (await file.read()).find((run) => run.runId === runId);
        },
    };
};
