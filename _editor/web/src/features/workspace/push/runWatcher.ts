import { type CommandRun, followCommandRun } from "@intentic/sandbox-contract";
import { errorMessage } from "@intentic/ui/async";
import { computed, type ComputedRef, ref } from "vue";

// Watches a command the daemon runs on click: start it, follow it to a verdict, stop it. One watcher over two
// sources (the check in usePrepush.ts, the push in usePushRun.ts), since both need the same rules:
//
// - the output isn't here: the daemon runs it in a tmux window, so this opens the terminal panel on it instead
//   of re-printing a captured tail.
// - the reveal happens once per run, at the first state carrying a terminal session; after that the panel is
//   the user's to close or leave.
// - a dropped poll isn't a failed run: the error is reported and polling continues, since killing it would
//   strand the surface on "running".
// - only the verdict is polled, and only while a run is going; the poll starts with the run and stops the
//   moment it settles.
// - a plain interval, not a vue-query observer: state is per watcher, so a re-render never restarts a run.

// The wait between polls, short enough that the answer follows the terminal's last line, and cheap: memory-only.
const POLL_MS = 700;

// What a source says about its run: where it starts, is read, stops, and its words for the terminal panel and
// error line. Everything else (cadence, reveal, settle) is the watcher's, shared by every source.
// `A` is what a start needs to know, for a source whose run isn't the same every time: the pre-push check is about the
// repositories going out, while a push run is already bound to its own. Defaults to nothing, so a source that takes no
// argument declares none and its callers keep writing `start()`.
export interface RunSource<R extends CommandRun, A = void> {
    // The shape at rest: what the watcher shows before the first poll and after `forget`.
    readonly idle: R;
    readonly start: (args: A) => Promise<unknown>;
    readonly state: () => Promise<R>;
    readonly cancel: () => Promise<unknown>;
    // What the terminal panel is told it's opening on, since the panel can't know; undefined means no panel to open.
    readonly reveal: (run: R) => { readonly title: string; readonly detail: string } | undefined;
    // The noun in error lines: "Could not start the checks.", "Lost contact with the push."
    readonly subject: string;
}

export interface RunWatcher<R extends CommandRun, A = void> {
    readonly run: ComputedRef<R>;
    readonly error: ComputedRef<string | undefined>;
    readonly running: ComputedRef<boolean>;
    // Whether there's a terminal to send the user to; what a "Show terminal" button is drawn on.
    readonly terminal: ComputedRef<string | undefined>;
    // Starts a run and follows it to a terminal state, resolving with the settled run so a call site reads as one
    // sentence. The daemon arbitrates "one at a time", so calling it again just joins a run already going.
    readonly start: (args: A) => Promise<R>;
    // Stops the run; the daemon settles it as `cancelled`, so the wording matches any other outcome's.
    readonly cancel: () => Promise<void>;
    // Drops the run from view without touching the daemon (what closing the surface does); a run still going
    // keeps going in its terminal, unwatched. The terminal tab stays open as the record of what ran.
    readonly forget: () => void;
    // The button beside a running command: the poll reveals once automatically, this is the user asking again.
    readonly showTerminal: () => void;
}

export const createRunWatcher = <R extends CommandRun, A = void>(source: RunSource<R, A>): RunWatcher<R, A> => {
    const run = ref(source.idle) as { value: R };
    const error = ref<string | undefined>(undefined);
    // The follow in progress, aborted by `forget` and the next `start`; one at a time per watcher.
    let following: AbortController | undefined;
    let shown = false;

    const stopFollowing = (): void => {
        following?.abort();
        following = undefined;
    };

    // Reached lazily, not for style: the panel module touches `window`/`document` at load, while this watcher is
    // imported by stores that run without a DOM. A microtask-later reveal is still the same user-visible moment.
    const reveal = (state: R): void => {
        const { session } = state;
        const words = session === undefined ? undefined : source.reveal(state);
        if (session !== undefined && words !== undefined) {
            void import(`../../terminal/useTerminalPanel`).then(({ useTerminalPanel }) => useTerminalPanel().openFocused(session, words));
        }
    };

    const start = async (args: A): Promise<R> => {
        stopFollowing();
        error.value = undefined;
        shown = false;
        run.value = { ...source.idle, status: `running` };
        try {
            await source.start(args);
        } catch (cause) {
            error.value = errorMessage(cause, `Could not start the ${source.subject}.`);
            run.value = source.idle;
            return run.value;
        }
        const follow = new AbortController();
        following = follow;
        // The poll loop is the contract's (followCommandRun); this watcher owns only what each state means to a screen.
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
        // Forgotten mid-run: the daemon keeps going, but the surface shows the rest state `forget` already put there.
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
