import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A platform that accepts the connection but never answers: the response callback is never invoked. The fake
// mirrors the two ClientRequest behaviors the timeout path relies on — setTimeout arms an idle timer, and
// destroy(err) surfaces that error via the `error` event.
const requestMock = vi.fn((_url: URL, _opts: unknown, _cb: (res: unknown) => void) => {
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
vi.mock("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { postToPlatform } = await import("./platform-client.js");

const config = {
    platform: { url: "https://host.docker.internal:6480" },
    connectToken: "tok",
} as unknown as Parameters<typeof postToPlatform>[0];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("postToPlatform", () => {
    it("rejects when the platform accepts the socket but never responds", async () => {
        const pending = postToPlatform(config, "/sandbox/host-tunnel", { hostName: "x" });
        const assertion = expect(pending).rejects.toThrow("the platform did not respond in time");
        await vi.advanceTimersByTimeAsync(60_000);
        await assertion;
    });
});
