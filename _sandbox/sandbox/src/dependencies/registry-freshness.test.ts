import { afterEach, expect, test, vi } from "vitest";
import { admits, createFreshnessResolver, gapBetween, isPrerelease, parseVersion, type PinnedPackage } from "./registry-freshness.js";

const pin = (version: string, range: PinnedPackage["range"] = "", name = "vue"): PinnedPackage => ({ ecosystem: "npm", name, version, range });

afterEach(() => {
    vi.unstubAllGlobals();
});

/* ---- what "behind" means, which is the whole correctness of the feature ------------------------------ */

/* THE PROPERTY THIS RESTS ON. `"vite": "^7.1.7"` against a latest of 7.4.0 is NOT behind — the manifest
 * already says yes to it and an install picks it up with nobody editing anything. Against 8.2.1 it IS, because
 * the caret stops at the major. A check that could not tell those apart would fire on most of a healthy
 * lockfile and be switched off within a day. */
test.each([
    ["^", "7.1.7", "7.4.0", true],
    ["^", "7.1.7", "8.2.1", false],
    ["~", "7.1.7", "7.1.9", true],
    ["~", "7.1.7", "7.2.0", false],
    ["", "7.1.7", "7.1.8", false],
    ["", "7.1.7", "7.1.7", true],
    [">=", "7.1.7", "9.0.0", true],
] as const)("a %s range on %s admits %s: %s", (range, version, candidate, expected) => {
    expect(admits(pin(version, range), parseVersion(candidate)!)).toBe(expected);
});

// Below 1.0.0 npm's caret locks the minor instead of the major, and a check that got this backwards would be
// wrong about every pre-1.0 package in a tree — which, for a workspace on early SDKs, is a lot of them.
test.each([
    ["0.147.0", "0.147.3", true],
    ["0.147.0", "0.151.0", false],
] as const)("a caret on the pre-1.0 %s admits %s: %s", (version, candidate, expected) => {
    expect(admits(pin(version, "^"), parseVersion(candidate)!)).toBe(expected);
});

test.each([
    ["1.2.3", "2.0.0", "major"],
    ["1.2.3", "1.5.0", "minor"],
    ["1.2.3", "1.2.9", "patch"],
] as const)("the gap between %s and %s reads as %s", (from, to, gap) => {
    expect(gapBetween(parseVersion(from)!, parseVersion(to)!)).toBe(gap);
});

test.each(["1.2.3-rc.1", "2.0.0-beta"])("a prerelease is not what latest means to anyone: %s", (version) => {
    expect(isPrerelease(version)).toBe(true);
});

test.each(["1.2", "1.2.3", "24.18.0"])("a version with or without a patch reads: %s", (version) => {
    expect(parseVersion(version)).toEqual(expect.any(Object));
});

test.each(["latest", "*", "", "vNext"])("something that is not a version reads as nothing: %s", (version) => {
    expect(parseVersion(version)).toBeUndefined();
});

/* ---- the resolver, against a stubbed registry -------------------------------------------------------- */

const npmStub = (latest: string, deprecated?: string, calls: { count: number } = { count: 0 }) => {
    const fetcher = vi.fn(async (url: string | URL) => {
        calls.count += 1;
        const text = String(url).includes("/-/package/") ? JSON.stringify({ latest }) : JSON.stringify(deprecated === undefined ? {} : { deprecated });
        return { ok: true, text: async () => text } as unknown as Response;
    });
    return { fetcher, calls };
};

test("a pin the registry has moved past reports the newer version and the gap", async () => {
    const { fetcher } = npmStub("1.125.0");
    vi.stubGlobal("fetch", fetcher);
    expect(await createFreshnessResolver()(pin("1.90.0", "", "@types/vscode"))).toEqual({ latest: "1.125.0", gap: "minor" });
});

test("a pin the range already reaches has nothing to report", async () => {
    const { fetcher } = npmStub("7.4.0");
    vi.stubGlobal("fetch", fetcher);
    expect(await createFreshnessResolver()(pin("7.1.7", "^", "vite"))).toBeUndefined();
});

// Deprecation is worth saying whatever the numbers are: a package can be on its newest version and still be
// one its own author has told you to stop using.
test("a deprecated package is reported even when it is on the newest version", async () => {
    const { fetcher } = npmStub("2.88.2", "request has been deprecated");
    vi.stubGlobal("fetch", fetcher);
    const answer = await createFreshnessResolver()(pin("2.88.2", "", "request"));
    expect(answer?.deprecated).toBe("request has been deprecated");
});

test("a registry that answers nothing useful produces no claim", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, text: async () => "" }) as unknown as Response),
    );
    expect(await createFreshnessResolver()(pin("1.0.0"))).toBeUndefined();
});

test("a registry that throws produces no claim rather than an error the agent has to handle", async () => {
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
            throw new Error("ENOTFOUND");
        }),
    );
    expect(await createFreshnessResolver()(pin("1.0.0"))).toBeUndefined();
});

test("a specifier with no readable version is never looked up", async () => {
    const { fetcher, calls } = npmStub("9.9.9");
    vi.stubGlobal("fetch", fetcher);
    expect(await createFreshnessResolver()(pin("latest"))).toBeUndefined();
    expect(calls.count).toBe(0);
});

/* ---- the two clocks, and the memory behind them ------------------------------------------------------ */

test("the same package asked twice costs one round of requests", async () => {
    const { fetcher, calls } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    const resolve = createFreshnessResolver();
    await resolve(pin("1.0.0"));
    const after = calls.count;
    await resolve(pin("1.0.0"));
    expect(calls.count).toBe(after);
});

test("twenty simultaneous asks for one package are one lookup, which a manifest write depends on", async () => {
    const { fetcher, calls } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    const resolve = createFreshnessResolver();
    await Promise.all(Array.from({ length: 20 }, () => resolve(pin("1.0.0"))));
    // Two documents per package (dist-tags and the pinned version), and no more.
    expect(calls.count).toBe(2);
});

/* THE ANSWER OUTLIVES ITS CALLER, which is the point of splitting the clocks. A lookup too slow for the grace
 * is not cancelled — it lands in the cache, so the pass after it finds the answer waiting rather than paying
 * for it again. Without this, the very first lookup of every session would be silently lost. */
test("a lookup that overruns the caller's grace still answers the next caller", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL) => {
            await gate;
            return { ok: true, text: async () => (String(url).includes("/-/package/") ? JSON.stringify({ latest: "2.0.0" }) : "{}") } as unknown as Response;
        }),
    );
    const resolve = createFreshnessResolver({ graceMs: 5 });
    expect(await resolve(pin("1.0.0"))).toBeUndefined();
    release!();
    await vi.waitFor(async () => {
        expect(await resolve(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
    });
});

// An unreachable registry is asked once, not on every edit of every file that names the package.
test("silence is remembered too", async () => {
    const fetcher = vi.fn(async () => ({ ok: false, text: async () => "" }) as unknown as Response);
    vi.stubGlobal("fetch", fetcher);
    const resolve = createFreshnessResolver();
    await resolve(pin("1.0.0"));
    const after = fetcher.mock.calls.length;
    await resolve(pin("1.0.0"));
    expect(fetcher.mock.calls.length).toBe(after);
});

// The cache that spans turns needs a real directory, which puts it in the integration budget: it lives in
// registry-freshness.integration.test.ts. Everything above is pure and belongs here, where it runs in
// milliseconds.
