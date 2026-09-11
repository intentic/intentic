import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The platform post, mocked like announce.test.ts: every post succeeds and is recorded, since what matters is what gets
// reported.
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
    // The id /health has to match is derived from this token, so the probe proves it reached itself.
    connectToken: "tok",
} as unknown as Parameters<typeof createReachReporter>[0];
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Parameters<typeof createReachReporter>[1];
// What the reporter expects its own /health to answer with, derived from the token exactly as the daemon does.
const OWN_ID = sandboxIdFromToken("tok");

// Drains the several-awaits-deep post→probe→body chain without moving the clock.
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

// The only check that the sandbox's public address actually answers; every failure it can name surfaces on the setup
// page.
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

    /* A HOSTED SANDBOX HAS NO TUNNEL, so it must not be told about one. It is a Fly app the platform's edge
     * replays to (ingress-tunnel.ts reachPosture → `direct`) and dials nothing itself, so the 502 it meets
     * when the edge is not routing is the edge's, and the old wording — "its tunnel is not routing here yet" —
     * named a component it does not have and implied waiting would fix it. Five minutes of that is what a
     * customer read before being offered a restart that could not help. */
    it("blames the edge, not a tunnel, for a hosted sandbox's 502", async () => {
        vi.stubGlobal("fetch", async () => new Response("not connected right now", { status: 502 }));
        const verdict = await probeSelf(PUBLIC_URL, "abc", "direct");
        expect(verdict.ok).toBe(false);
        if (verdict.ok === false) {
            expect(verdict.detail).toContain("502");
            expect(verdict.detail).toContain("edge");
            expect(verdict.detail).not.toContain("tunnel");
        }
    });

    it("names an address that cannot be reached at all", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed");
        });
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok).toBe(false);
        if (verdict.ok === false) {
            expect(verdict.detail).toContain(PUBLIC_URL);
        }
    });

    it("names an address that hangs, apart from one that refuses", async () => {
        vi.stubGlobal("fetch", async () => {
            throw new DOMException("timed out", "TimeoutError");
        });
        const unreachable = await probeSelf(PUBLIC_URL, "abc");
        vi.stubGlobal("fetch", async () => {
            throw new TypeError("fetch failed");
        });
        const refused = await probeSelf(PUBLIC_URL, "abc");
        expect(unreachable.ok).toBe(false);
        expect(refused.ok).toBe(false);
        if (unreachable.ok === false && refused.ok === false) {
            expect(unreachable.detail).not.toBe(refused.detail);
        }
    });

    it("refuses a healthy answer that belongs to a different sandbox", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, sandboxId: "someone-else" }), { status: 200 }));
        const verdict = await probeSelf(PUBLIC_URL, "abc");
        expect(verdict.ok).toBe(false);
        if (verdict.ok === false) {
            expect(verdict.detail).toContain("abc");
            expect(verdict.detail).toContain(PUBLIC_URL);
        }
    });
});

describe("createReachReporter", () => {
    it("says it is checking before it knows, then reports the verdict and goes quiet", async () => {
        vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ sandboxId: OWN_ID }), { status: 200 }));
        const reporter = createReachReporter(config, logger);
        reporter.start({ by: "tunnel" });
        await settle();

        expect(posted.map((post) => (post.body as { reach: string }).reach)).toEqual(["checking", "reachable"]);
        expect(posted.every((post) => post.path === "/sandbox/boot-report")).toBe(true);
        expect(reporter.status().state).toBe("reachable");

        await vi.advanceTimersByTimeAsync(120_000);
        expect(posted).toHaveLength(2);
    });

    it("keeps reporting an address that does not answer, and keeps its reason", async () => {
        vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
        const reporter = createReachReporter(config, logger);
        reporter.start({ by: "tunnel" });
        await settle();

        expect(reporter.status().state).toBe("unreachable");
        expect(reporter.status().detail).toContain("404");
        expect(reporter.status().retrying).toBe(true);

        await vi.advanceTimersByTimeAsync(3_000);
        expect(posted.filter((post) => (post.body as { reach: string }).reach === "unreachable").length).toBeGreaterThan(1);
    });

    it("stops retrying after the give-up window, keeping the last reason", async () => {
        vi.stubGlobal("fetch", async () => new Response("nope", { status: 404 }));
        const reporter = createReachReporter(config, logger);
        reporter.start({ by: "tunnel" });
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        const settled = posted.length;

        expect(reporter.status().state).toBe("unreachable");
        expect(reporter.status().retrying).toBe(false);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(posted).toHaveLength(settled);
    });

    it("is off until started: a headless run has no address to probe", () => {
        expect(createReachReporter(config, logger).status()).toEqual({ state: "off" });
    });

    /* A container told a public name but given nothing to dial with. The verdict is knowable before any probe
     * and cannot change while the box runs, so it is stated once, with the reason and without a probe: the
     * five minutes of "its tunnel has not come up yet" that used to fill this case read as waiting, and the
     * people reading them waited. */
    it("settles at once when the daemon dials no edge, naming why and probing nothing", async () => {
        const probe = vi.fn(async () => new Response(JSON.stringify({ sandboxId: OWN_ID }), { status: 200 }));
        vi.stubGlobal("fetch", probe);
        const reporter = createReachReporter(config, logger);

        reporter.start({ by: "loopback", reason: "no INGRESS_URL, so there is no edge to dial" });
        await settle();

        expect(probe).not.toHaveBeenCalled();
        expect(reporter.status().state).toBe("unreachable");
        expect(reporter.status().retrying).toBe(false);
        // The reason travels: it is the one sentence that tells somebody what to do about it.
        expect(reporter.status().detail).toContain("no edge to dial");
        expect(reporter.status().detail).toContain(PUBLIC_URL);
        expect(reporter.status().detail).toContain("setup screen");
        // Told once. Waiting is not a strategy here, so neither is re-reporting.
        expect(posted.map((post) => (post.body as { reach: string }).reach)).toEqual(["unreachable"]);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(posted).toHaveLength(1);

        expect(posted.map((post) => (post.body as { retrying?: boolean }).retrying)).toEqual([false]);
    });

    // Drift rides the same report that still gets through when the tunnel itself is down.
    it("names the env a drifted container is missing, on the same post as the verdict", async () => {
        vi.stubEnv("SANDBOX_PUBLIC_URL", PUBLIC_URL);
        vi.stubEnv("SANDBOX_GRANT", "");
        vi.stubEnv("INGRESS_URL", "");
        const reporter = createReachReporter(config, logger);

        reporter.start({ by: "loopback", reason: "no INGRESS_URL, so there is no edge to dial" });
        await settle();

        const [drift] = posted.map((post) => (post.body as { drift?: { key: string; missing: string[]; repair: string }[] }).drift);
        expect(drift?.map((gap) => gap.key)).toEqual(["reachability"]);
        expect(drift?.[0]?.missing).toEqual(["SANDBOX_GRANT", "INGRESS_URL"]);
        // Rendered verbatim wherever it lands, so the sentence has to name the move rather than the variable.
        expect(drift?.[0]?.repair).toContain("setup command");
    });

    // No drift: the field is absent, not an empty array, when nothing needs explaining.
    it("says nothing about drift when the container carries what it needs", async () => {
        vi.stubEnv("SANDBOX_PUBLIC_URL", PUBLIC_URL);
        vi.stubEnv("SANDBOX_GRANT", "ig1.payload.sig");
        vi.stubEnv("INGRESS_URL", "https://ingress.intentic.dev");
        const reporter = createReachReporter(config, logger);

        reporter.start({ by: "loopback", reason: "this profile serves no front door for a tunnel to reach" });
        await settle();

        expect(posted.map((post) => (post.body as { drift?: unknown }).drift)).toEqual([undefined]);
    });
});
