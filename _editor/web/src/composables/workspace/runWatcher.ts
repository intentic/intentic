import { type CommandRun, followCommandRun } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, type ComputedRef, ref } from "vue";

/* WATCHING A COMMAND THE DAEMON RUNS ON A CLICK, browser-side: start it, follow it to a verdict, stop it. The
 * pre-push check is one such command (usePrepush.ts) and the push itself is another (usePushRun.ts), and they
 * are the SAME watcher over two sources rather than two watchers, because the four things this gets right took
 * the check several iterations to learn and a second copy would have forgotten one:
 *
 *   THE OUTPUT IS NOT HERE. The daemon runs the command as a tmux window and names the session in the run's
 *   `session`; this opens the terminals panel on it, and what the user watches is a terminal, colour, a runner
 *   rewriting its own progress line, the wheel scrolling back through the part that already went past. A dialog
 *   re-printing a captured tail into a <pre> could be none of those things, and the escape codes it could not
 *   interpret arrived as `[39m[22m` litter across the failure the user was trying to read.
 *
 *   THE REVEAL IS ONCE PER RUN, at the first state that carries a terminal. The daemon names the session only
 *   once the command is actually in it, so that is the moment there is something to watch; opening the panel
 *   any earlier is how it came to sit on a spinner over a session tmux had not created yet. After that the
 *   panel is the user's: they may close it, or switch tabs, and a poll must not drag them back.
 *
 *   A DROPPED POLL IS NOT A FAILED RUN. The command is still going on the daemon; the error is reported and
 *   the poll continues, because killing it would strand the surface on a "running" it can never leave.
 *
 *   ONLY THE VERDICT IS POLLED, and only while a run is going. A run exists inside the moment a push is waiting
 *   on it, so the poll starts with the run and stops when it settles; nothing observes a run at rest.
 *
 * A PLAIN INTERVAL rather than a vue-query observer: a query key implies a cached, shared, refetchable resource,
 * and this is a one-shot the surface that started it owns for as long as it is open. State is per watcher, and
 * the sources hand out one watcher per thing that can run (one check, one push per repo), so a re-render never
 * restarts a run. */

// The wait between "is it done yet" questions, short enough that the surface's answer follows the terminal's
// last line rather than trailing it, and cheap: the daemon answers from memory, and only while a run is going.
const POLL_MS = 700;

/* What a source has to say about its run: where it starts, where it is read, where it stops, and the words
 * the terminal panel and the error line use. Everything else, the cadence, the reveal, the settle, is the
 * watcher's, and the same for every source. */
export interface RunSource<R extends CommandRun> {
    // The shape at rest, what the watcher shows before the first poll and after `forget`.
    readonly idle: R;
    readonly start: () => Promise<unknown>;
    readonly state: () => Promise<R>;
    readonly cancel: () => Promise<unknown>;
    // What the terminal panel is told it is opening on, the panel cannot know, and the tmux session's own name
    // (`job-checks`) is not an answer to "why has this opened" for anyone who met it mid-push. Undefined means
    // there is no panel to open for this run: the terminal is on a box this browser is not looking at.
    readonly reveal: (run: R) => { readonly title: string; readonly detail: string } | undefined;
    // The noun in the error lines: "Could not start the checks.", "Lost contact with the push."
    readonly subject: string;
}

export interface RunWatcher<R extends CommandRun> {
    readonly run: ComputedRef<R>;
    readonly error: ComputedRef<string | undefined>;
    readonly running: ComputedRef<boolean>;
    // Whether there is a terminal to send the user to at all, what a "Show terminal" button is drawn on.
    readonly terminal: ComputedRef<string | undefined>;
    /* Start a run and follow it to a terminal state. Resolves with the settled run, which is what makes the
     * push flow readable as one sentence at the call site: start the checks, then decide; start the push, then
     * report. The daemon is the arbiter of "one at a time" (a second start while one is going does nothing),
     * so this can be called without checking first: a surface reopened over a run that is still going joins
     * it rather than starting a second. */
    readonly start: () => Promise<R>;
    // Stop the run. The daemon settles it as `cancelled`, which the poll picks up, so the wording comes from the
    // same place every other outcome's does.
    readonly cancel: () => Promise<void>;
    /* Drop the run from view without touching the daemon, what closing the surface does. A run still going
     * when the user moves on keeps going, in the terminal it was already running in; it just has nobody
     * waiting on the verdict. The terminal tab is not closed either: it is the record of what ran. */
    readonly forget: () => void;
    // The button beside a running command. The automatic reveal is the poll's, once per run; this is the user
    // asking again, after closing the panel, or from another view.
    readonly showTerminal: () => void;
}

export const createRunWatcher = <R extends CommandRun>(source: RunSource<R>): RunWatcher<R> => {
    const run = ref(source.idle) as { value: R };
    const error = ref<string | undefined>(undefined);
    // The follow in progress, aborted by `forget` and by the next `start`; one at a time per watcher.
    let following: AbortController | undefined;
    let shown = false;

    const stopFollowing = (): void => {
        following?.abort();
        following = undefined;
    };

    /* The terminal panel is reached lazily, and this is not a nicety: the panel module pulls in the layout and
     * the terminal renderer, which read `window` and `document` as they load, while this watcher is imported
     * by stores that run wherever the app's plain state does (the sandbox scope, the ledger of other boxes'
     * work). A static import here would have made "which sandbox am I in" depend on a DOM. Nothing is lost:
     * a reveal is a user-visible moment and a microtask later is still that moment. */
    const reveal = (state: R): void => {
        const { session } = state;
        const words = session === undefined ? undefined : source.reveal(state);
        if (session !== undefined && words !== undefined) {
            void import(`../terminal/useTerminalPanel`).then(({ useTerminalPanel }) => useTerminalPanel().openFocused(session, words));
        }
    };

    const start = async (): Promise<R> => {
        stopFollowing();
        error.value = undefined;
        shown = false;
        run.value = { ...source.idle, status: `running` };
        try {
            await source.start();
        } catch (cause) {
            error.value = errorMessage(cause, `Could not start the ${source.subject}.`);
            run.value = source.idle;
            return run.value;
        }
        const follow = new AbortController();
        following = follow;
        // The loop itself is the contract's (followCommandRun), shared with every other surface that waits on a
        // run; what is this watcher's is what each state means to a screen: the reveal, once, and the error
        // line that a dropped poll writes without ending the wait.
        const settled = await followCommandRun(source.state, {
            intervalMs: POLL_MS,
            signal: follow.signal,
            onState: (state) => {
                run.value = state;
                error.value = undefined;
                if (!shown && state.session !== undefined) {
                    shown = true;
                    reveal(state);
                }
            },
            onError: (cause) => {
                error.value = errorMessage(cause, `Lost contact with the ${source.subject}.`);
            },
        });
        if (following === follow) {
            following = undefined;
        }
        // Forgotten mid-run: the run is still going on the daemon, but the surface that asked has moved on,
        // and what it is shown is the rest state `forget` already put there.
        return settled ?? run.value;
    };

    const cancel = async (): Promise<void> => {
        try {
            await source.cancel();
        } catch (cause) {
            error.value = errorMessage(cause, `Could not stop the ${source.subject}.`);
        }
    };

    const forget = (): void => {
        stopFollowing();
        run.value = source.idle;
        error.value = undefined;
    };

    return {
        run: computed(() => run.value),
        error: computed(() => error.value),
        running: computed(() => run.value.status === `running`),
        terminal: computed(() => run.value.session),
        start,
        cancel,
        forget,
        showTerminal: () => reveal(run.value),
    };
};
