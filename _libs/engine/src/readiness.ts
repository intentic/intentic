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
    // A connection refused/reset/timeout during warm-up means "not ready yet", not a fatal error — return
    // false so waitReady keeps polling until the deadline rather than throwing on the first failed connect.
    try {
        const response = await fetch(url, { method: "GET" });
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
    const deadline = Date.now() + limit;
    for (;;) {
        if (await probe(url, expected)) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new ReadinessTimeoutError(id, url, limit);
        }
        await sleep(intervalMs);
    }
};
