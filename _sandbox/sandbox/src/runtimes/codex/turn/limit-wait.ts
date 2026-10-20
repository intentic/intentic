import type { CodexCredential } from "../../../agent/providers/agent-request.js";
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

/* (2026-10-20) A WAIT KNOWN TO OUTLAST PATIENCE IS HANDED OVER AT ONCE. Patience alone kept every spent-allowance turn
   showing as working for its full two minutes, holding its seat, its parent's wait and the queue behind it, for a refusal
   whose end was already on file: the translator benches a credential a 429 refused until the Retry-After it was quoted,
   and the account's readings name their reset. `reopensAt` reads that (the turn's TurnAllowance, epoch seconds, undefined
   while anything still has room or nothing names an instant), asked once per wait as it starts; past patience, the wait
   is handed over then. Anything else (a short limit, no instant known, a read that fails) leaves the patience timer as
   the fallback it was. */
export interface LimitWaitOptions {
    readonly patienceMs?: number;
    readonly reopensAt?: () => Promise<number | undefined>;
    readonly now?: () => number;
}

// When the account reopens, or undefined when that cannot be read: a failed read is only the timer's to answer.
const reopeningOf = async (read: () => Promise<number | undefined>): Promise<number | undefined> => {
    try {
        return await read();
    } catch {
        // allow(silent-catch): an unreadable allowance names no instant, and the patience timer still answers the wait.
        return undefined;
    }
};

export const limitWait = (stop: () => void, options: LimitWaitOptions = {}): LimitWait => {
    const patienceMs = options.patienceMs ?? RATE_LIMIT_PATIENCE_MS;
    const now = options.now ?? Date.now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handed = false;
    const clear = (): void => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    const handOver = (): void => {
        clear();
        handed = true;
        stop();
    };
    // Hands this wait over when its reopening is past patience, unless it already ended (answered, disposed, handed).
    const lookAhead = async (wait: ReturnType<typeof setTimeout>, read: () => Promise<number | undefined>): Promise<void> => {
        const reopensAt = await reopeningOf(read);
        if (timer === wait && reopensAt !== undefined && reopensAt * 1000 - now() > patienceMs) {
            handOver();
        }
    };
    return {
        retrying: () => {
            if (timer !== undefined || handed) {
                return;
            }
            const wait = setTimeout(handOver, patienceMs);
            timer = wait;
            if (options.reopensAt !== undefined) {
                void lookAhead(wait, options.reopensAt);
            }
        },
        answered: clear,
        handedOver: () => handed,
        dispose: clear,
    };
};

// The reopening a turn's allowance names for its model, in epoch seconds; undefined while anything still has room.
export const allowanceReopening =
    (limit: () => Promise<{ readonly withHeadroom: number; readonly reopensAt?: number }>) =>
    async (): Promise<number | undefined> => {
        const read = await limit();
        return read.withHeadroom > 0 ? undefined : read.reopensAt;
    };

// What tells a rate-limited wait how long it really is: the turn's allowance, where its credential names one.
export const limitWaitOptions = (credential: CodexCredential): LimitWaitOptions => {
    const limit = credential.kind === "codex-endpoint" ? credential.allowance?.limit : undefined;
    return limit === undefined ? {} : { reopensAt: allowanceReopening(limit) };
};

// What the turn ends on when its wait is handed over: coded, so it is held and booked rather than offered as a Continue.
export const LIMIT_WAIT_HANDED_OVER =
    "The provider refused this Codex turn with a rate limit (HTTP 429), and Codex was waiting inside the turn for it to lift; a spent allowance lifts only at its reset, which can be hours away. The wait is handed to the sandbox, which holds the turn for the reset instead of keeping it open.";
