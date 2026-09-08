import type { CommandRun } from "../schemas/ci.js";

// The heading over a settled run, shown both on the workspace card and in a phone notification, so the two must agree
// on wording. `subject` is what ran, in the clicked button's own words ("Checks", "Push", "Publish").
export interface FollowRunOptions<R extends CommandRun> {
    // The wait between "is it done yet" questions.
    readonly intervalMs: number;
    // Stop following, not stop the run: resolves undefined rather than throwing.
    readonly signal?: AbortSignal | undefined;
    // Every state read, settled or not, for a surface that draws progress.
    readonly onState?: ((run: R) => void) | undefined;
    // A poll that failed, not a run that failed: the run is still going, and following continues.
    readonly onError?: ((cause: unknown) => void) | undefined;
}

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal?.removeEventListener("abort", done);
            resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
    });

// Follows a run to its verdict: reads state until it is no longer running. The one shared loop, so a dropped poll isn't
// handled differently by every caller; reads once immediately, so an already-settled run returns without a wait.
export const followCommandRun = async <R extends CommandRun>(read: () => Promise<R>, options: FollowRunOptions<R>): Promise<R | undefined> => {
    const { intervalMs, signal, onState, onError } = options;
    for (;;) {
        if (signal?.aborted === true) {
            return undefined;
        }
        try {
            const run = await read();
            onState?.(run);
            if (run.status !== "running") {
                return run;
            }
        } catch (cause) {
            onError?.(cause);
        }
        await sleep(intervalMs, signal);
    }
};

export const commandRunOutcome = (run: Pick<CommandRun, "status" | "timedOut">, subject: string): string => {
    if (run.timedOut === true) {
        return `${subject} timed out`;
    }
    switch (run.status) {
        case "error":
            return `${subject} couldn't run`;
        case "cancelled":
            return `${subject} stopped`;
        case "failed":
            return `${subject} failed`;
        case "passed":
            return `${subject} passed`;
        default:
            // idle reaches a card only when the command was cleared between click and request; it says so.
            return `${subject} didn't run`;
    }
};
