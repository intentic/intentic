import { pollUntil } from "@intentic/base/async";

export type ReadinessProbe = (url: string, expectedStatus: number) => Promise<boolean>;

// Only "<seconds>s" durations exist in the graph this increment.
export const parseDuration = (text: string): number => {
    const match = /^(\d+)s$/.exec(text);
    if (match === null) {
        throw new Error(`unsupported duration "${text}" (expected "<seconds>s")`);
    }
    return Number(match[1]) * 1000;
};

export const httpProbe: ReadinessProbe = async (url, expectedStatus) => {
    // A connection refused/reset/timeout during warm-up means "not ready yet": return false so waitReady keeps
    // polling instead of throwing. Bounded per probe so a host that accepts the socket but never answers can't stall
    // past waitReady's own deadline.
    try {
        const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
        return response.status === expectedStatus || response.status < 400;
    } catch {
        return false;
    }
};

// Thrown on readiness timeout so callers can react to this specific failure while the error still propagates.
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

// Poll `probe` until it succeeds or the timeout elapses; throws ReadinessTimeoutError on timeout. The probe is
// injected so tests never hit the network.
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
