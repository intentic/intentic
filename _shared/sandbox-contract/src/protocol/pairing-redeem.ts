import { retry, withDeadline } from "@intentic/base/async";

// Redeeming a pairing code's one-time token, as every peer that takes one does it (the machine agent's
// `postWhileWarming`, the webext's `redeemPairing`): a sandbox still warming up answers 5xx through its tunnel, or
// nothing at all, and is asked again. Any other answer, a 401 above all (the code has expired), is the caller's to read
// at once: asking again would only delay the fresh code the person has to fetch.

// Why a try is being asked again: no answer at all, or a 5xx from a sandbox not ready yet.
export type RedeemRetry = { readonly kind: "unreachable"; readonly error: unknown } | { readonly kind: "warming"; readonly status: number };

export type RedeemOutcome =
    // The sandbox's answer: below 500 at once, or still 5xx when the tries ran out.
    | { readonly kind: "answered"; readonly response: Response }
    // No answer at all on the last try; `error` is that try's failure.
    | { readonly kind: "unreachable"; readonly error: unknown };

export interface RedeemOptions {
    // Tries in all, the first included.
    readonly attempts: number;
    // The wait between tries.
    readonly delayMs: number;
    // How long one try may take before it is abandoned and counts as unreachable; none when absent.
    readonly timeoutMs?: number | undefined;
    // Stops the tries: a stop rejects with the signal's reason rather than answering.
    readonly signal?: AbortSignal | undefined;
    // Hears each try that is about to be asked again, before the wait.
    readonly onRetry?: ((attempt: number, why: RedeemRetry) => void) | undefined;
}

// A 5xx carried out of a try so `retry` asks again, and handed back as the answer when the tries run out.
class Warming extends Error {
    constructor(readonly response: Response) {
        super(`the sandbox is warming up (HTTP ${response.status})`);
    }
}

// Runs `send` (one POST, handed the try's number and a signal to pass to its fetch, undefined when there is neither a
// deadline nor a stop) until the sandbox answers below 500 or the tries run out.
export const redeemWhileWarming = async (
    send: (attempt: number, signal: AbortSignal | undefined) => Promise<Response>,
    options: RedeemOptions,
): Promise<RedeemOutcome> => {
    const { attempts, delayMs, timeoutMs, signal, onRetry } = options;
    const once = (attempt: number): Promise<Response> =>
        timeoutMs === undefined ? send(attempt, signal) : withDeadline((bounded) => send(attempt, bounded), timeoutMs, { signal });
    try {
        const response = await retry(
            async (attempt) => {
                let answer: Response;
                try {
                    answer = await once(attempt);
                } catch (error) {
                    if (attempt < attempts && signal?.aborted !== true) {
                        onRetry?.(attempt, { kind: "unreachable", error });
                    }
                    throw error;
                }
                if (answer.status < 500) {
                    return answer;
                }
                if (attempt < attempts) {
                    onRetry?.(attempt, { kind: "warming", status: answer.status });
                }
                throw new Warming(answer);
            },
            { attempts, delayMs: () => delayMs, signal },
        );
        return { kind: "answered", response };
    } catch (error) {
        if (signal?.aborted === true) {
            // the stop's own reason, as an aborted fetch rejects with it
            throw signal.reason;
        }
        if (error instanceof Warming) {
            return { kind: "answered", response: error.response };
        }
        return { kind: "unreachable", error };
    }
};
