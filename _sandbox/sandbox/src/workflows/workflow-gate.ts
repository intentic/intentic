import type { GateVerdict, WorkflowRun, WorkflowStepRun, WorkflowStepState } from "@intentic/sandbox-contract";

/* WHAT A FINISHED RUN SAYS TO A PIPELINE.
 *
 * Every way this can go wrong except one lands on `blocked`, and that asymmetry IS the design. There is
 * exactly one thing a gate can say that should stop a release: the step ran, wrote the field it promised, and
 * the value is not one of the ones that ship. Everything else — a step that failed, a run that was stopped or
 * ran out of money, a deadline, a document that never arrived, a field missing from one that did — means the
 * gate never got to judge, and calling that `fail` tells a team their product is broken when what broke was
 * the check.
 *
 * That distinction is worth more than it looks. A gate wired into a merge queue is read by people who did not
 * write it, on the worst day of their week, and the first time it goes red for its own outage is the day it
 * stops being believed. So `blocked` is meant to be the honest answer far more often than it is the
 * convenient one, and the route hands it back with a neutral exit rather than a failed build.
 *
 * The rule is read off the RUN'S SNAPSHOT (`run.workflow.gate`), never off the live manifest, for the reason
 * the run view draws the snapshotted graph: a workflow edited while its run was in flight must not change what
 * that run is judged by, and a run of a since-deleted workflow still has to answer.
 */

// Why this step was never in a position to give a verdict, in the words the pipeline log will carry. `running`
// is the deadline's own case: the gate stopped waiting and cut the run off, so the step is still mid-turn.
const NEVER_JUDGED: Record<Exclude<WorkflowStepState, "done">, string> = {
    pending: "never started",
    running: "was still going when the gate stopped waiting",
    failed: "failed",
    skipped: "never ran, because something it waits for did not finish",
    stopped: "was stopped",
};

// The step's own title, which the verdict quotes — read off the snapshot rather than the run's step record,
// since only the workflow definition carries it.
const titleOf = (run: WorkflowRun, step: WorkflowStepRun): string =>
    run.workflow.steps.find((entry) => entry.id === step.stepId)?.title ?? step.stepId;

/* The declared field, as a single value the `pass` list can be compared against.
 *
 * Stringified rather than compared typed, because `pass` is authored in a form and everything typed into a
 * form is a string: a boolean field gates on "true", a number on "3". Lists are refused when the workflow is
 * saved (workflowFaults), so the only shapes reaching here are the three scalars.
 */
const valueOf = (document: WorkflowStepRun["document"], field: string): string | undefined => {
    const raw = document?.data?.[field];
    return raw === undefined || raw === null ? undefined : String(raw);
};

const quoted = (values: readonly string[]): string => values.map((value) => `"${value}"`).join(" or ");

export const gateVerdictOf = (run: WorkflowRun): GateVerdict => {
    const { gate } = run.workflow;
    if (gate === undefined) {
        return { outcome: "blocked", runId: run.runId, reason: "This workflow declares no gate." };
    }
    const step = run.steps.find((entry) => entry.stepId === gate.step);
    if (step === undefined) {
        return { outcome: "blocked", runId: run.runId, reason: `The run has no step "${gate.step}".` };
    }
    const title = titleOf(run, step);
    if (step.state !== "done") {
        const detail = step.detail === undefined ? "" : ` (${step.detail})`;
        return { outcome: "blocked", runId: run.runId, reason: `"${title}" ${NEVER_JUDGED[step.state]}${detail}.` };
    }
    const value = valueOf(step.document, gate.field);
    if (value === undefined) {
        return { outcome: "blocked", runId: run.runId, reason: `"${title}" finished without writing "${gate.field}".` };
    }
    return gate.pass.includes(value)
        ? { outcome: "pass", runId: run.runId, value, reason: `${gate.field} is "${value}".` }
        : { outcome: "fail", runId: run.runId, value, reason: `${gate.field} is "${value}"; this gate ships on ${quoted(gate.pass)}.` };
};
