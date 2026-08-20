import { setTimeout as sleep } from "node:timers/promises";

export type ReadinessProbe = (url: string, expectedStatus: number) => Promise<boolean>;

// Only "<seconds>s" durations exist in the graph this increment (120s/90s/60s).
export const parseDuration = (text: string): number => {
    const match = /^(\d+)s$/.exec(text);
    if (match === null) {
        throw new Error(`unsupported duration "${text}" (expected "<seconds>s")`);
    }
    return Number(match[1]) * 1000;
};

export const httpProbe: ReadinessProbe = async (url, expectedStatus) => {
    // A connection refused/reset/timeout during warm-up means "not ready yet", not a fatal error, return
    // false so waitReady keeps polling until the deadline rather than throwing on the first failed connect.
    // Bound each probe (a host that accepts the socket but never sends headers would otherwise stall on
    // undici's ~5-min default, silently overshooting waitReady's own deadline); an aborted probe is a caught
    // "not ready yet". Matches the wget -T 10 / AbortSignal.timeout convention used across the providers.
    try {
        const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
        return response.status === expectedStatus || response.status < 400;
    } catch {
        return false;
    }
};

// Thrown on readiness timeout so callers can react to this specific failure (the CLI runs an SSH
// diagnostic sweep) while still letting the error propagate unchanged.
export class ReadinessTimeoutError extends Error {
    constructor(
        readonly id: string,
        readonly url: string,
        readonly timeoutMs: number,
    ) {
        super(`readiness check timed out after ${timeoutMs}ms for ${url} (resource "${id}")`);
        this.name = "ReadinessTimeoutError";
    }
}

/* THE ONE WAITING LOOP. Every "is it up yet" in the engine and the providers is the same three lines, probe,
 * give up at a deadline, sleep between tries, and each of the ten used to spell them out again, which is how
 * they drifted apart on the edges (one gave up at `>` its deadline where the rest used `>=`).
 *
 * Always probes once before consulting the clock, so a wait is never skipped by a deadline that has already
 * passed. Answers whether `ready` passed and leaves what a failure MEANS to the caller, most throw with a
 * message naming the thing they were waiting for, but a DNS wait is allowed to shrug and carry on. `onRetry`
 * runs only when another attempt is coming, so a caller that narrates the wait says nothing extra on the last
 * one. A probe that throws propagates: some waits (a forwarder whose process already exited) must fail fast
 * rather than burn the whole deadline. */
export const pollUntil = async (
    ready: () => Promise<boolean>,
    options: { readonly timeoutMs: number; readonly intervalMs: number; readonly onRetry?: () => void },
): Promise<boolean> => {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
        if (await ready()) {
            return true;
        }
        if (Date.now() >= deadline) {
            return false;
        }
        options.onRetry?.();
        await sleep(options.intervalMs);
    }
};

// Poll `probe` until it succeeds or the timeout elapses; throws ReadinessTimeoutError on timeout. The
// probe is injected so tests never hit the network.
export const waitReady = async (
    id: string,
    url: string,
    options: { readonly status?: number; readonly timeout?: string },
    probe: ReadinessProbe,
    intervalMs = 1000,
): Promise<void> => {
    const expected = options.status ?? 200;
    const limit = options.timeout !== undefined ? parseDuration(options.timeout) : 60000;
    if (!(await pollUntil(() => probe(url, expected), { timeoutMs: limit, intervalMs }))) {
        throw new ReadinessTimeoutError(id, url, limit);
    }
};
