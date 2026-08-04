import {
    type Workflow,
    type WorkflowRun,
    WorkflowRunSchema,
    type WorkflowStepRun,
    type WorkflowStepState,
    WorkflowSchema,
    type WorkflowRunState,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* TWO FILES, because the two halves have nothing in common but a name.
 *
 * `.intentic/workflows.json` is a MANIFEST — a handful of designs the user authors and edits, the same shape
 * and lifecycle as automations.json, changing at human speed.
 *
 * `.intentic/workflow-runs.json` is a LEDGER — append-mostly, written several times per step by the scheduler,
 * bounded by count and never edited by a person. Keeping it out of the manifest is what stops a run's fourth
 * step-state write from rewriting the user's designs, and what lets a run of a since-deleted workflow stay
 * readable (it snapshotted its definition; see WorkflowRunSchema.workflow).
 */

// How many runs the ledger remembers, newest first. A run is a deliberate act and carries a full workflow
// snapshot, so these are kilobytes each rather than bytes — generous, but not unbounded.
const RUNS_KEPT = 50;

export interface WorkflowsStore {
    readonly list: () => Promise<Workflow[]>;
    readonly get: (id: string) => Promise<Workflow | undefined>;
    // Upsert by id. An edit does NOT touch run history — history lives in the run ledger, keyed by run, and a
    // run that already snapshotted this workflow is unaffected by what the design becomes next.
    readonly upsert: (workflow: Workflow) => Promise<void>;
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
        upsert: async (workflow) => {
            await file.update((workflows) => {
                const index = workflows.findIndex((entry) => entry.id === workflow.id);
                return index === -1 ? [...workflows, workflow] : workflows.map((entry, at) => (at === index ? workflow : entry));
            });
        },
        remove: async (id) => {
            const before = (await file.read()).length;
            const after = await file.update((workflows) => workflows.filter((workflow) => workflow.id !== id));
            return after.length < before;
        },
    };
};

// What one step-state write changes. Every field is optional because the scheduler writes this at three
// different moments — the step starting, the step ending, a step being skipped — and each knows a different
// subset. Omitting is not the same as clearing: an absent key leaves what was there.
export type StepPatch = Partial<Omit<WorkflowStepRun, "stepId">>;

export interface WorkflowRunsStore {
    // Newest-started first, the order the list route serves and the UI renders.
    readonly list: () => Promise<WorkflowRun[]>;
    readonly get: (runId: string) => Promise<WorkflowRun | undefined>;
    // Open a run with every step already recorded `pending`, so the graph is complete from the first frame.
    readonly start: (run: WorkflowRun) => Promise<WorkflowRun>;
    readonly patchStep: (runId: string, stepId: string, patch: StepPatch) => Promise<void>;
    // Set several steps to one state at once — what "everything downstream of the failure is skipped" is, and
    // one write rather than one per node.
    readonly markSteps: (runId: string, stepIds: readonly string[], state: WorkflowStepState, detail?: string) => Promise<void>;
    readonly settle: (runId: string, state: WorkflowRunState, now: number, detail?: string) => Promise<void>;
    /* File an ended run away, or bring it back — `now` stamps the archive, `undefined` clears it. The run stays
     * in the ledger either way, which is the difference between this and `forget` below: an archived run is
     * still the thing that stands for its steps' conversations, and a record that had gone could not be
     * restored or draw the row the archive lists them under.
     */
    readonly setArchived: (runId: string, at: number | undefined) => Promise<void>;
    /* Drop a run from the ledger outright — what emptying the archive does to the runs in it, alongside the
     * agents it deletes.
     *
     * A run record is a SCHEDULING artifact (which step ran where, and how it ended); the work itself is the
     * steps' conversations, their branches and their transcripts, which this does not touch. Purging deletes
     * those separately and for its own reasons — this is only the row that pointed at them. The ledger is
     * already transient by design (it keeps the last RUNS_KEPT and rolls the rest off), so dropping one early
     * is the same event happening on purpose.
     */
    readonly forget: (runId: string) => Promise<void>;
    // Count one boot-time resume against the run, so a workflow whose step reliably kills the daemon cannot be
    // resurrected forever. Returns the run as it now stands, or undefined when it went away underneath.
    readonly countResume: (runId: string) => Promise<WorkflowRun | undefined>;
}

export const fileWorkflowRunsStore = (path: string): WorkflowRunsStore => {
    const file = jsonFile<WorkflowRun[]>(path, {
        parse: (raw) => z.array(WorkflowRunSchema).safeParse(raw).data,
        fallback: () => [],
    });
    // Every mutation is "find this run, replace it". A run that isn't there is a no-op rather than an error —
    // the ledger rolls, and a scheduler still writing to a run that has rolled off the end must not resurrect it.
    const amend = async (runId: string, change: (run: WorkflowRun) => WorkflowRun): Promise<void> => {
        await file.update((runs) => {
            const existing = runs.find((run) => run.runId === runId);
            return existing === undefined ? runs : runs.map((run) => (run === existing ? change(existing) : run));
        });
    };
    const amendSteps = (runId: string, change: (step: WorkflowStepRun) => WorkflowStepRun): Promise<void> =>
        amend(runId, (run) => ({ ...run, steps: run.steps.map(change) }));

    return {
        list: async () => (await file.read()).toSorted((a, b) => b.startedAt - a.startedAt),
        get: async (runId) => (await file.read()).find((run) => run.runId === runId),
        start: async (run) => {
            await file.update((runs) => [run, ...runs].slice(0, RUNS_KEPT));
            return run;
        },
        patchStep: (runId, stepId, patch) => amendSteps(runId, (step) => (step.stepId === stepId ? { ...step, ...patch } : step)),
        markSteps: (runId, stepIds, state, detail) => {
            const wanted = new Set(stepIds);
            return amendSteps(runId, (step) => (wanted.has(step.stepId) ? { ...step, state, ...(detail !== undefined ? { detail } : {}) } : step));
        },
        settle: (runId, state, now, detail) => amend(runId, (run) => ({ ...run, state, endedAt: now, ...(detail !== undefined ? { detail } : {}) })),
        setArchived: (runId, at) => amend(runId, ({ archivedAt: _was, ...run }) => (at === undefined ? run : { ...run, archivedAt: at })),
        forget: async (runId) => {
            await file.update((runs) => runs.filter((run) => run.runId !== runId));
        },
        countResume: async (runId) => {
            await amend(runId, (run) => ({ ...run, resumed: run.resumed + 1 }));
            return (await file.read()).find((run) => run.runId === runId);
        },
    };
};
