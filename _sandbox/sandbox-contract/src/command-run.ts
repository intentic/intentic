import type { CommandRun } from "./schemas/ci.js";

/* THE HEADING OVER A SETTLED RUN, three or four words, because it is read at a glance and from across a view
 * the user may have walked back into, and because it is read in TWO places that must agree: the card the app
 * floats over the workspace, and the notification the daemon sends to a phone when the user is not there to
 * see the card. Two copies of these words drifted once ("Checks failed" on the card, "Check failed" on the
 * phone), which is the whole reason the sentence lives in the package both sides already share.
 *
 * `subject` is what ran, in the words the button used: "Checks" for the pre-push check, "Push" for the push,
 * and the verb the user actually clicked ("Publish", "Sync") where the flow knows it. `passed` is included
 * for totality; no card is raised for it, a pass sends the push and says so where the click was. */
export interface FollowRunOptions<R extends CommandRun> {
    // The wait between "is it done yet" questions.
    readonly intervalMs: number;
    // Stop following: the caller has moved on. Resolves undefined rather than throwing, the run itself is
    // still going wherever it was, and nobody here has anything to report about it.
    readonly signal?: AbortSignal | undefined;
    // Every state read, settled or not, for a surface that draws progress (the terminal to open, the command).
    readonly onState?: ((run: R) => void) | undefined;
    // A poll that could not be read. NOT the run failing: it is still going on the daemon, and the next tick
    // usually reconnects, so following continues; the caller decides what to show meanwhile.
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

/* FOLLOW A RUN TO ITS VERDICT: read its state until it is no longer running, and answer with the settled run.
 * The one loop under every surface that starts a command and waits for the answer, the web's run watcher and
 * an extension's push pill alike, because a daemon that answers "started" at once (prepush.contract.ts,
 * git.contract.ts push) leaves every caller to write this loop, and each one that did wrote the dropped-poll
 * case differently. Reads once immediately, so a run that has already settled is answered without a wait. */
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
            // `idle` reaches a card only when the command was cleared between the click and the request, there
            // is no run any more, so it says so rather than implying one ran and said nothing.
            return `${subject} didn't run`;
    }
};
