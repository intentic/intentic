// A LONG RUN ON A MACHINE, DRAWN AS THE FEW THINGS IT DOES. The shape both the checkout rebuild and a device's update
// or rollback share: a handful of named steps, each sized by how long it usually takes, read off the run's own output.

export interface ProgressStep<Key extends string = string> {
    readonly key: Key;
    readonly label: string;
    /** What the sandbox is doing meanwhile, said once per step rather than as a paragraph under the card. */
    readonly note: string;
    /** Share of the whole run, so the bar's segments are sized by time rather than by count. */
    readonly weight: number;
}

/**
 * Where the run stands as a whole. `stopped` is where it got to and ended without finishing; `unheard` is a step this
 * page lost sight of, neither known to be going nor known to have stopped.
 */
export type ProgressStatus = "running" | "done" | "stopped" | "unheard";

export type StepState = "done" | "running" | "pending" | "stopped" | "unheard";

const rankIn = (steps: readonly ProgressStep[], key: string): number => steps.findIndex((step) => step.key === key);

/** Where a step's segment of the bar starts, so a finished step reads as finished however the next one is going. */
export const stepStart = (steps: readonly ProgressStep[], key: string): number =>
    steps.slice(0, Math.max(0, rankIn(steps, key))).reduce((sum, step) => sum + step.weight, 0);

export const stepWeight = (steps: readonly ProgressStep[], key: string): number => steps.find((step) => step.key === key)?.weight ?? 0;

/**
 * One step's state, given the step the run is on. A finished run marks done what it reached, and leaves pending what it
 * never needed: an update that found nothing to download ends without restarting anything.
 */
export const stepState = (steps: readonly ProgressStep[], key: string, at: string, status: ProgressStatus): StepState => {
    const here = rankIn(steps, key);
    const reached = rankIn(steps, at);
    if (here < reached) {
        return `done`;
    }
    if (here > reached) {
        return `pending`;
    }
    return status;
};

/**
 * A step's own clock: from the moment it was first seen to the moment a later one was. A step that nothing timed shows
 * no number rather than a made-up one.
 */
export const stepSeconds = (
    steps: readonly ProgressStep[],
    key: string,
    stageAt: Partial<Record<string, number>>,
    end: number | undefined,
): number | undefined => {
    const from = stageAt[key];
    if (from === undefined) {
        return undefined;
    }
    const later = steps
        .slice(rankIn(steps, key) + 1)
        .map((step) => stageAt[step.key])
        .find((at) => at !== undefined);
    const to = later ?? end;
    return to === undefined ? undefined : Math.max(0, Math.round((to - from) / 1000));
};

/** How much of a step's own segment is filled: zero for a step with nothing countable in it, which then pulses. */
export const stepFill = (steps: readonly ProgressStep[], key: string, fraction: number): number => {
    const weight = stepWeight(steps, key);
    return weight === 0 ? 0 : Math.min(1, Math.max(0, (fraction - stepStart(steps, key)) / weight));
};
