import type { PrepushRun } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { errorMessage } from "../useAsyncAction";

/* THE PRE-PUSH CHECK, browser-side — start it, watch it, stop it.
 *
 * POLLED WHILE IT RUNS, AND NOT AT ALL OTHERWISE, which is the whole shape of the rewrite. The verdict this
 * replaced was a persisted thing the Changes panel polled forever so a badge could stay warm; a run here exists
 * only inside the moment a push is waiting on it, so the poll starts with the run and stops when it settles.
 * Nothing observes the check at rest, because at rest there is nothing to observe.
 *
 * A PLAIN INTERVAL rather than a vue-query observer, for the same reason: a query key implies a cached, shared,
 * refetchable resource, and this is a one-shot the dialog owns for as long as it is open. The state is module
 * scope (there is one check, and one push flow at a time) so a re-render of the dialog never restarts a run. */

// Fast enough that a suite's output reads as streaming rather than as arriving in chunks, and cheap: the daemon
// answers from memory, and only while a dialog is open in front of it.
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
        return await new Promise<PrepushRun>((resolve) => {
            timer = setInterval(() => {
                void poll().then(() => {
                    if (timer === undefined) {
                        resolve(run.value);
                    }
                });
            }, POLL_MS);
            // Do not wait a whole interval to show the first frame: a command that exits in milliseconds would
            // otherwise spend most of its life on screen as an empty box.
            void poll().then(() => {
                if (timer === undefined) {
                    resolve(run.value);
                }
            });
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
    // when the user pushes anyway keeps running; it just has nobody watching it.
    const forget = (): void => {
        stopPolling();
        run.value = IDLE;
        error.value = undefined;
    };

    return {
        run: computed(() => run.value),
        error: computed(() => error.value),
        running: computed(() => run.value.status === `running`),
        start,
        cancel,
        forget,
    };
}
