import { RATE_LIMIT_PATIENCE_MS } from "../../decorators/vendor-errors.js";

/* A RATE LIMIT CODEX WAITS OUT INSIDE THE TURN IS GIVEN ONLY SO LONG. Codex honours the translator's Retry-After, which
   for a spent allowance is the rest of its window ("retrying sampling request (1/5 in 13734s)" in Codex's own log), and
   tells this client only "Reconnecting... 1/5" before going quiet. A turn sat as working for 2h42m that way on a spent
   Codex allowance (2026-10-11), and three subagents sat until the reset four hours off (2026-10-13), each holding its
   seat, its parent's wait and its card. Past RATE_LIMIT_PATIENCE_MS with no answer the phase is interrupted and the
   turn ends coded `rate_limit`, which the daemon holds and books for the reset (classify-failure.ts), as OpenCode's and
   Claude's loops already hand theirs over. A short limit the provider lifts in seconds is answered well inside it. */
export interface LimitWait {
    // Codex announced a rate-limited retry: the clock starts, unless it is already running.
    readonly retrying: () => void;
    // The provider answered again, so whatever it was waiting out is over.
    readonly answered: () => void;
    // Whether patience ran out and the phase was stopped for it.
    readonly handedOver: () => boolean;
    readonly dispose: () => void;
}

export const limitWait = (stop: () => void, patienceMs: number = RATE_LIMIT_PATIENCE_MS): LimitWait => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handed = false;
    const clear = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return {
        retrying: () => {
            if (timer === undefined && !handed) {
                timer = setTimeout(() => {
                    timer = undefined;
                    handed = true;
                    stop();
                }, patienceMs);
            }
        },
        answered: clear,
        handedOver: () => handed,
        dispose: clear,
    };
};

// What the turn ends on when its wait is handed over: coded, so it is held and booked rather than offered as a Continue.
export const LIMIT_WAIT_HANDED_OVER =
    "The provider refused this Codex turn with a rate limit (HTTP 429), and Codex was waiting inside the turn for it to lift; a spent allowance lifts only at its reset, which can be hours away. The wait is handed to the sandbox, which holds the turn for the reset instead of keeping it open.";
