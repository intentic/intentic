import type { PrepushRun } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { errorMessage } from "../useAsyncAction";

/* THE PRE-PUSH CHECK, browser-side — start it, watch it, stop it.
 *
 * THE OUTPUT IS NOT HERE, and that is the point. The daemon runs the suite as a tmux window and names the session
 * in the run's `session`; this opens the terminals panel on it, and what the user watches is a terminal — colour,
 * a runner rewriting its own progress line, the wheel scrolling back through the part that already went past.
 * A dialog re-printing a captured tail into a <pre> could be none of those things, and the escape codes it could
 * not interpret arrived as `[39m[22m` litter across the failure the user was trying to read.
 *
 * SO WHAT IS POLLED IS THE VERDICT, and only while a run is going. The verdict this replaced was a persisted
 * thing the Changes panel polled forever so a badge could stay warm; a run here exists only inside the moment a
 * push is waiting on it, so the poll starts with the run and stops when it settles. Nothing observes the check at
 * rest, because at rest there is nothing to observe.
 *
 * A PLAIN INTERVAL rather than a vue-query observer, for the same reason: a query key implies a cached, shared,
 * refetchable resource, and this is a one-shot the dialog owns for as long as it is open. The state is module
 * scope (there is one check, and one push flow at a time) so a re-render of the dialog never restarts a run. */

// The wait between "is it done yet" questions — short enough that the dialog's answer follows the terminal's last
// line rather than trailing it, and cheap: the daemon answers from memory, and only while a push is waiting.
const POLL_MS = 700;

const IDLE: PrepushRun = { status: `idle`, command: ``, output: `` };

const run = ref<PrepushRun>(IDLE);
const error = ref<string | undefined>(undefined);
let timer: ReturnType<typeof setInterval> | undefined;

const stopPolling = (): void => {
    clearInterval(timer);
    timer = undefined;
};

const poll = async (): Promise<void> => {
    try {
        run.value = await sandboxJson<PrepushRun>(`/prepush/state`);
        error.value = undefined;
    } catch (cause) {
        // A dropped poll is not a failed check: the suite is still going on the daemon. Report it and keep
        // polling — the next tick usually reconnects, and killing the poll here would strand the dialog on a
        // "running" it can never leave.
        error.value = errorMessage(cause, `Lost contact with the checks.`);
        return;
    }
    if (run.value.status !== `running`) {
        stopPolling();
    }
};

export function usePrepush() {
    /* Put the check's terminal on screen. Called once as a run starts, and offered as a button for the rest of
     * it: the panel is the user's, so closing it or switching tabs must not be something the dialog undoes on
     * the next poll. Absent `session` means this sandbox has no tmux wrapper (local dev) — the suite ran in an
     * invisible shell, and there is no tab to send anyone to. */
    const showTerminal = (): void => {
        const session = run.value.session;
        if (session !== undefined) {
            useTerminalPanel().openFocused(session);
        }
    };

    /* Start a run and follow it to a terminal state. Resolves with the settled run, which is what makes the
     * push flow readable as one sentence at the call site — start the checks, then decide.
     *
     * The daemon is the arbiter of "one at a time" (a second /prepush/run while one is going does nothing), so
     * this can be called without checking first: a dialog reopened over a check that is still going joins it
     * rather than starting a second suite. */
    const start = async (): Promise<PrepushRun> => {
        stopPolling();
        error.value = undefined;
        run.value = { ...IDLE, status: `running` };
        try {
            await sandboxJson(`/prepush/run`, { method: `POST` });
        } catch (cause) {
            error.value = errorMessage(cause, `Could not start the checks.`);
            run.value = IDLE;
            return run.value;
        }
        // Ask once before settling into the interval, because this first answer is the one that names the
        // terminal: waiting a tick for it would leave the panel closed over the opening seconds of a suite, which
        // on a fast command is all of it.
        await poll();
        showTerminal();
        if (run.value.status !== `running`) {
            return run.value;
        }
        return await new Promise<PrepushRun>((resolve) => {
            timer = setInterval(() => {
                void poll().then(() => {
                    // `poll` clears the timer the moment the run settles, so this is that settle — and the only
                    // value it can resolve with is the one the dialog is already showing.
                    if (timer === undefined) {
                        resolve(run.value);
                    }
                });
            }, POLL_MS);
        });
    };

    // Stop the suite. The daemon settles the run as `cancelled`, which the poll picks up — so the dialog's
    // wording comes from the same place every other outcome's does.
    const cancel = async (): Promise<void> => {
        try {
            await sandboxJson(`/prepush/cancel`, { method: `POST` });
        } catch (cause) {
            error.value = errorMessage(cause, `Could not stop the checks.`);
        }
    };

    // Drop the run from view without touching the daemon — what closing the dialog does. A check still running
    // when the user pushes anyway keeps running, in the terminal it was already running in; it just has nobody
    // waiting on the verdict. The terminal tab is not closed either: it is the record of what ran.
    const forget = (): void => {
        stopPolling();
        run.value = IDLE;
        error.value = undefined;
    };

    return {
        run: computed(() => run.value),
        error: computed(() => error.value),
        running: computed(() => run.value.status === `running`),
        // Whether there is a terminal to send the user to at all — what the dialog's button is drawn on.
        terminal: computed(() => run.value.session),
        start,
        cancel,
        forget,
        showTerminal,
    };
}
