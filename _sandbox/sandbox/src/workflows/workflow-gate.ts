import type { GateVerdict, WorkflowRun, WorkflowStepRun, WorkflowStepState } from "@intentic/sandbox-contract";

// What a finished run says to a pipeline: exactly one condition reaches `fail` (the step ran, wrote its field, and the
// value doesn't ship); everything else reaches `blocked`, since the gate never got to judge. Read off the run's own
// snapshot (`run.workflow.gate`), never the live manifest, so a workflow edited mid-run can't change its verdict.

// Why a step gave no verdict, for the pipeline log; `running` is the deadline's own case, cut off mid-turn.
const NEVER_JUDGED: Record<Exclude<WorkflowStepState, "done">, string> = {
    pending: "never started",
    running: "was still going when the gate stopped waiting",
    failed: "failed",
    skipped: "never ran, because something it waits for did not finish",
    stopped: "was stopped",
};

// Step's own title, quoted by the verdict, read off the snapshot since only the workflow definition carries it.
const titleOf = (run: WorkflowRun, step: WorkflowStepRun): string =>
    run.workflow.steps.find((entry) => entry.id === step.stepId)?.title ?? step.stepId;

// Declared field as a single value comparable to `pass`; stringified since `pass` is authored in a form (a boolean
// gates on "true", a number on "3"). Lists are refused at save time, so only scalars reach here.
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
