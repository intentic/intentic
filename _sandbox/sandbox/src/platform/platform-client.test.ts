import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";

// A platform that accepts the connection but never answers: the response callback is never invoked. The fake
// mirrors the two ClientRequest behaviors the timeout path relies on: setTimeout arms an idle timer, and
// destroy(err) surfaces that error via the `error` event.
const requestMock = mock((_url: URL, _opts: unknown, _cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & {
        end: () => void;
        setTimeout: (ms: number, cb: () => void) => void;
        destroy: (err: Error) => void;
    };
    req.end = () => {};
    req.setTimeout = (ms, cb) => void setTimeout(cb, ms);
    req.destroy = (err) => void req.emit("error", err);
    return req;
});
mock.module("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { postToPlatform } = await import("./platform-client.js");

const config = {
    platform: { url: "https://host.docker.internal:6480" },
    connectToken: "tok",
} as unknown as Parameters<typeof postToPlatform>[0];

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("postToPlatform", () => {
    it("rejects when the platform accepts the socket but never responds", async () => {
        // The rejection is held here rather than asserted before the advance: `expect(...).rejects` blocks until the
        // promise settles, and only the advance below settles it.
        const failure = postToPlatform(config, "/sandbox/local-dns", { challenge: "x" }).then(
            () => undefined,
            (error: Error) => error,
        );
        await advanceTimersByTimeAsync(60_000);
        expect((await failure)?.message).toMatch(/respond in time/);
    });
});
