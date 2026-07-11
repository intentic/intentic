import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drive each register attempt's outcome from a queue: { status } acks with that HTTP code, { err: true }
// simulates a transport failure. request() returns a fake ClientRequest whose .end() fires the outcome.
const outcomes: Array<{ status?: number; err?: boolean }> = [];
const requestMock = vi.fn((_url: URL, _opts: unknown, cb: (res: { statusCode: number; resume: () => void }) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
        const outcome = outcomes.shift() ?? { status: 200 };
        if (outcome.err === true) {
            req.emit("error", new Error("boom"));
            return;
        }
        cb({ statusCode: outcome.status ?? 200, resume: () => {} });
    };
    return req;
});
vi.mock("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { createAnnouncer } = await import("./announce.js");

const config = {
    platform: { url: "https://host.docker.internal:6480" },
    sandbox: { publicUrl: "https://sandbox-x.intentic.dev" },
    connectToken: "tok",
} as unknown as Parameters<typeof createAnnouncer>[0];
const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Parameters<typeof createAnnouncer>[1];

beforeEach(() => {
    vi.useFakeTimers();
    outcomes.length = 0;
    requestMock.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("createAnnouncer", () => {
    it("registers once on a 200 and then goes silent — never a heartbeat", () => {
        outcomes.push({ status: 200 });
        createAnnouncer(config, logger).start();

        expect(requestMock).toHaveBeenCalledTimes(1);
        // No reschedule after an ack: minutes later, still exactly one request.
        vi.advanceTimersByTime(120_000);
        expect(requestMock).toHaveBeenCalledTimes(1);
    });

    it("retries a failed attempt with backoff, then stops the moment it's acked", () => {
        outcomes.push({ err: true }, { status: 200 });
        createAnnouncer(config, logger).start();
        expect(requestMock).toHaveBeenCalledTimes(1);

        // Backoff is 2s for the first retry; it then acks and never fires again.
        vi.advanceTimersByTime(2_000);
        expect(requestMock).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(120_000);
        expect(requestMock).toHaveBeenCalledTimes(2);
    });

    it("stops scheduling after the give-up window when the platform is never reachable", () => {
        for (let i = 0; i < 200; i++) {
            outcomes.push({ err: true });
        }
        createAnnouncer(config, logger).start();
        // Well past the 10-minute give-up bound: the retry loop must terminate, not run forever.
        vi.advanceTimersByTime(20 * 60_000);
        const settled = requestMock.mock.calls.length;
        vi.advanceTimersByTime(20 * 60_000);
        expect(requestMock).toHaveBeenCalledTimes(settled);
    });
});
