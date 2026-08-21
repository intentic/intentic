import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The platform post, mocked the same way announce.test.ts does it: what matters here is WHAT gets reported,
// so every post simply succeeds and is recorded.
const posted: Array<{ path: string; body: unknown }> = [];
const requestMock = vi.fn((url: URL, _opts: unknown, cb: (res: { statusCode: number; resume: () => void }) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: (payload: string) => void };
    req.end = (payload: string) => {
        posted.push({ path: url.pathname, body: JSON.parse(payload) as unknown });
        cb({ statusCode: 200, resume: () => {} });
    };
    return req;
});
vi.mock("node:https", () => ({ request: (...args: unknown[]) => requestMock(...(args as Parameters<typeof requestMock>)) }));

const { createReachReporter, probeSelf } = await import("./reach-report.js");
const { sandboxIdFromToken } = await import("@intentic/sandbox-contract/tunnel-ids");

const PUBLIC_URL = "https://sandbox-abc.sbx.test";
const config = {
    platform: { url: "https://platform.test" },
    sandbox: { publicUrl: PUBLIC_URL },
    // The id the /health answer has to match is derived from this token, so the probe proves it reached ITSELF.
    connectToken: "tok",
} as unknown as Parameters<typeof createReachReporter>[0];
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof createReachReporter>[1];
// What the reporter expects its own /health to answer with: derived from the token, exactly as the daemon does.
const OWN_ID = sandboxIdFromToken("tok");

// Let the awaited posts and probes resolve without moving the clock. The chain is several awaits deep (post →
// probe → body), so this drains rather than counting them.
const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
    vi.useFakeTimers();
    posted.length = 0;
    requestMock.mockClear();
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

/* The probe is the whole point: it is the only check anybody makes that the sandbox's PUBLIC address answers,
 * and every failure it can name is a sentence somebody reads on the setup page. */
describe("probeSelf", () => {
    it("passes when its own address answers with its own id", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, sandboxId: "abc" }), { status: 200 }));
        expect(await probeSelf(PUBLIC_URL, "abc")).toEqual({ ok: true });
    });

    it("names a tunnel that is up with nothing behind it", async () => {
        vi.stubGlobal("fetch", async () => new Response("no share here", { status: 502 }));
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.detail).toContain("502");
    });

    it("names an address that cannot be reached at all", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed");
        });
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok === false && verdict.detail).toContain("could not be reached");
    });

    it("names an address that hangs, apart from one that refuses", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new DOMException("timed out", "TimeoutError");
        });
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok === false && verdict.detail).toContain("never answered");
    });

    // A 200 from somebody ELSE is the worst failure to leave unnamed: everything looks healthy and the
    // traffic is going somewhere it should not.
    it("refuses a healthy answer that belongs to a different sandbox", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, sandboxId: "someone-else" }), { status: 200 }));
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok === false && verdict.detail).toContain("different sandbox");
    });
});

describe("createReachReporter", () => {
    it("says it is checking before it knows, then reports the verdict and goes quiet", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sandboxId: OWN_ID }), { status: 200 }));
        const reporter = createReachReporter(config, logger);
        reporter.start();
        await settle();

        // The first word matters on its own: it tells a waiting page that a daemon exists and is testing
        // itself, which is more than the spinner it replaces ever managed.
        expect(posted.map((post) => (post.body as { reach: string }).reach)).toEqual(["checking", "reachable"]);
        expect(posted.every((post) => post.path === "/sandbox/boot-report")).toBe(true);
        expect(reporter.status().state).toBe("reachable");

        // Proved: nothing further, exactly like the announce after its ack.
        await vi.advanceTimersByTimeAsync(120_000);
        expect(posted).toHaveLength(2);
    });

    it("keeps reporting an address that does not answer, and keeps its reason", async () => {
        vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
        const reporter = createReachReporter(config, logger);
        reporter.start();
        await settle();

        expect(reporter.status().state).toBe("unreachable");
        expect(reporter.status().detail).toContain("404");
        expect(reporter.status().retrying).toBe(true);

        // The share the entrypoint binds can take a few seconds, so it retries rather than concluding.
        await vi.advanceTimersByTimeAsync(3_000);
        expect(posted.filter((post) => (post.body as { reach: string }).reach === "unreachable").length).toBeGreaterThan(1);
    });

    it("stops retrying after the give-up window, keeping the last reason", async () => {
        vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
        const reporter = createReachReporter(config, logger);
        reporter.start();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        const settled = posted.length;

        expect(reporter.status().state).toBe("unreachable");
        expect(reporter.status().retrying).toBe(false);
        // A permanently-unreachable box must not report forever: the page has stopped waiting by now too.
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(posted).toHaveLength(settled);
    });

    it("is off until started: a headless run has no address to probe", () => {
        expect(createReachReporter(config, logger).status()).toEqual({ state: "off" });
    });
});
