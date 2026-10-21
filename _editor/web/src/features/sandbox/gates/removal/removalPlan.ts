// A SANDBOX'S REMOVAL AS THE FEW STEPS IT TAKES, so the dialog can say which one it is on, and a second press after a
// failure picks up where the first stopped instead of doing again what already happened. Pure, so the order, the
// resume and the countdown are pinned by a test (removalPlan.test.ts) instead of by clicking through a dialog.
//
// The ORDER is the safety: the container out there goes first and the account row last. A failure on the machine leaves
// the row in place, the one handle there is to retry from; a failure on the account leaves a row whose container is
// already put away, and the retry only has the row left to drop.

/**
 * The ledger key of one sandbox's removal. Under the account (`account/`, operations.ts ACCOUNT_SCOPE), not the open
 * sandbox: removing the sandbox on screen switches to another, and the run has to be readable from there.
 */
export const removalKey = (sandboxId: string): string => `account/sandbox-remove/${sandboxId}`;

/** `device`: the container on the owner's machine is put away (kept a week). `account`: the account row goes. */
export type RemovalStep = `device` | `account`;

/** Where a removal stands, kept on its run in the ledger so a reopened dialog draws the same steps. */
export interface RemovalProgress {
    /** Every step this removal takes, in order. */
    readonly steps: readonly RemovalStep[];
    /** The step it is on, or the last one it reached once it has ended. */
    readonly stage: RemovalStep;
    /** When each step began. */
    readonly stageAt: Partial<Record<RemovalStep, number>>;
    /** The steps that finished, by this run or an earlier one of the same removal. */
    readonly done: readonly RemovalStep[];
}

/** The steps, in the order that keeps a handle to retry from. */
export const removalSteps = (onMachine: boolean): readonly RemovalStep[] => (onMachine ? [`device`, `account`] : [`account`]);

/** What is left of a removal, given what an earlier attempt already finished. */
export const stepsLeft = (progress: Pick<RemovalProgress, `steps` | `done`>): readonly RemovalStep[] =>
    progress.steps.filter((step) => !progress.done.includes(step));

/** Where a removal starts: on its first unfinished step, with what an earlier attempt finished carried over. */
export const startProgress = (steps: readonly RemovalStep[], done: readonly RemovalStep[], now: number): RemovalProgress => {
    const left = stepsLeft({ steps, done });
    const stage = left[0] ?? steps.at(-1) ?? `account`;
    return { steps, stage, stageAt: { [stage]: now }, done: done.filter((step) => steps.includes(step)) };
};

/** The run moves on to `step`; a step seen before keeps its first clock. */
export const enterStep = (progress: RemovalProgress, step: RemovalStep, now: number): RemovalProgress => ({
    ...progress,
    stage: step,
    stageAt: { ...progress.stageAt, [step]: progress.stageAt[step] ?? now },
});

export const finishStep = (progress: RemovalProgress, step: RemovalStep): RemovalProgress =>
    progress.done.includes(step) ? progress : { ...progress, done: [...progress.done, step] };

// HOW LONG A PRESS CAN STILL BE TAKEN BACK. Nothing is touched until it runs out: the one honest cancel a removal can
// offer, since `ic sandbox remove` stopped halfway is a worse state than either ending. Five seconds is long enough to
// read "Removing in 5 s" and reach Undo, and short enough that waiting it out is not a chore.
export const REMOVAL_GRACE_MS = 5_000;

/** Whole seconds left on the countdown, never below zero; 5 at the press, 1 in its last second. */
export const graceSecondsLeft = (endsAt: number, now: number): number => Math.max(0, Math.ceil((endsAt - now) / 1_000));

// How long each lane usually takes, for the estimate the bar is drawn from (progress.ts): the machine stops a container
// and moves its volumes aside in tens of seconds, the account row goes in one round trip. Past the give-up the dialog
// stops waiting and offers a retry, which is safe because both steps are idempotent: the machine says a sandbox it already
// put away is already removed, and a row already gone is nothing to drop.
const REMOVAL_EXPECTED_MS = { device: 30_000, account: 2_000 } as const satisfies Record<RemovalStep, number>;
export const REMOVAL_GIVE_UP_MS = 5 * 60_000;

/** The usual length of the steps left, for the run's expectation. */
export const expectedMs = (steps: readonly RemovalStep[]): number => steps.reduce((sum, step) => sum + REMOVAL_EXPECTED_MS[step], 0);

/** Each step's share of the bar, by how long it usually takes. */
export const stepWeight = (step: RemovalStep, steps: readonly RemovalStep[]): number => REMOVAL_EXPECTED_MS[step] / expectedMs(steps);

/** The machine's latest word, for the running step's second line: its last line that says anything. */
export const latestLine = (lines: readonly string[]): string | undefined => lines.findLast((line) => line.trim() !== ``)?.trim();
