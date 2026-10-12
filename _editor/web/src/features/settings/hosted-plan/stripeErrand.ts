import type { HostedPlanState } from "@intentic/api-contract";

/* AN ERRAND ON STRIPE, RUN IN THE READER'S OWN BROWSER. The desktop app has no browser of its own: a navigation to
 * Stripe is handed to the reader's real browser (desktop-app `windows.rs`), so the window that asked stays where it was
 * and nothing tells it the errand is over. The wait is therefore the app's: it re-reads the plan until the answer moves.
 * It runs as Billing's operation (operations.ts), so a reader who opens another view meanwhile comes back to the same
 * wait, or to its end; the one wait in flight is held here so that whichever Billing is on screen can stop it. */

export const POLL_EVERY_MS = 3_000;
// The webhook's few seconds, once Stripe has already sent the browser back to the app.
export const RETURN_WAIT_MS = 40_000;
// Someone typing a card into another window, which is a different order of time.
export const BROWSER_WAIT_MS = 10 * 60_000;

// The plan half of the answer, which is all an errand on Stripe can change. The hosted half moves on its own — a
// machine waking, a minute spent — and comparing it would report a change nobody made.
export const planMark = (state: HostedPlanState | undefined): string =>
    state === undefined
        ? ``
        : `${state.onPlan}:${state.status ?? ``}:${state.renewsAt ?? ``}:${state.cancelAtPeriodEnd === true}:${state.comped === true}:${state.hosted?.slots ?? 0}`;

// The wait in flight; a second errand ends the first, since the reader is now in the browser for the second.
let current: (() => void) | undefined;

/**
 * Re-reads the plan every few seconds until it differs from `left` (what it said when the errand left for the browser):
 * a cancellation and a new card are the same round trip as a payment, and neither turns `onPlan` on, so any change is
 * the errand's end. Coming back to the window re-reads at once and keeps reading for the webhook's few seconds past the
 * deadline. True once the plan moved; false when the wait ran out or was dropped.
 */
export const waitForStripe = async (left: string, read: () => Promise<HostedPlanState>): Promise<boolean> => {
    current?.();
    let deadline = Date.now() + BROWSER_WAIT_MS;
    // Set by stop(), which runs from outside the loop below.
    const run = { dropped: false };
    let wake: () => void = () => undefined;
    const stop = (): void => {
        run.dropped = true;
        wake();
    };
    current = stop;
    const onReturn = (): void => {
        if (document.visibilityState === `visible`) {
            deadline = Math.max(deadline, Date.now() + RETURN_WAIT_MS);
            wake();
        }
    };
    window.addEventListener(`focus`, onReturn);
    document.addEventListener(`visibilitychange`, onReturn);
    try {
        while (!run.dropped && Date.now() <= deadline) {
            await new Promise<void>((resolve) => {
                const tick = setTimeout(resolve, POLL_EVERY_MS);
                wake = () => {
                    clearTimeout(tick);
                    resolve();
                };
            });
            // allow(silent-catch): a read that fails is "not yet", which the next tick asks again.
            const state = run.dropped ? undefined : await read().catch(() => undefined);
            if (!run.dropped && state !== undefined && planMark(state) !== left) {
                return true;
            }
        }
        return false;
    } finally {
        window.removeEventListener(`focus`, onReturn);
        document.removeEventListener(`visibilitychange`, onReturn);
        if (current === stop) {
            current = undefined;
        }
    }
};

/** The reader saying the errand is over when it produced nothing: closed the tab, changed their mind. Nothing to undo. */
export const dropStripeErrand = (): void => current?.();
