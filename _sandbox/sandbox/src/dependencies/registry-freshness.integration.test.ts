import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFreshnessResolver, type PinnedPackage } from "./registry-freshness.js";

// The half of the resolver that touches a real filesystem: the cache that spans turns; pure logic lives in the
// unit-budget file next door.

const pin = (version: string, range: PinnedPackage["range"] = ""): PinnedPackage => ({ ecosystem: "npm", name: "vue", version, range });

afterEach(() => {
    vi.unstubAllGlobals();
});

const npmStub = (latest: string, calls: { count: number } = { count: 0 }) => {
    const fetcher = vi.fn(async (url: string | URL) => {
        calls.count += 1;
        return { ok: true, text: async () => (String(url).includes("/-/package/") ? JSON.stringify({ latest }) : "{}") } as unknown as Response;
    });
    return { fetcher, calls };
};

const inTempDir = async (check: (dir: string) => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "freshness-"));
    try {
        await check(dir);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

test("an answer survives to the next turn through the cache on disk", async () => {
    await inTempDir(async (dir) => {
        const { fetcher, calls } = npmStub("2.0.0");
        vi.stubGlobal("fetch", fetcher);
        expect(await createFreshnessResolver({ cacheDir: dir })(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
        // The write isn't awaited by the lookup, so this waits for it to settle rather than assuming an order.
        await vi.waitFor(async () => {
            const calm = { count: 0 };
            const second = npmStub("2.0.0", calm);
            vi.stubGlobal("fetch", second.fetcher);
            // A second resolver call simulates a second turn: nothing in memory, only disk.
            expect(await createFreshnessResolver({ cacheDir: dir })(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
            expect(calm.count).toBe(0);
        });
        expect(calls.count).toBeGreaterThan(0);
    });
});

test("a cached answer past its age is asked again", async () => {
    await inTempDir(async (dir) => {
        const { fetcher, calls } = npmStub("2.0.0");
        vi.stubGlobal("fetch", fetcher);
        let clock = 1_000;
        await createFreshnessResolver({ cacheDir: dir, now: () => clock })(pin("1.0.0"));
        const after = calls.count;
        clock += 7 * 60 * 60 * 1000;
        await createFreshnessResolver({ cacheDir: dir, now: () => clock })(pin("1.0.0"));
        expect(calls.count).toBeGreaterThan(after);
    });
});

// An unwritable cache is a miss, not a failure; the path is under a file so it fails fast (ENOTDIR) rather than hanging
// like /proc's mkdir.
test("an unwritable cache directory still answers", async () => {
    const { fetcher } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    expect(await createFreshnessResolver({ cacheDir: "/etc/hostname/not-a-dir" })(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
});

// Regression: a cache write that never settles must not delay the answer past its grace period.
test("a cache write that hangs forever does not hold up the answer", async () => {
    const { fetcher } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    const resolve = createFreshnessResolver({ cacheDir: "/proc/nonexistent/nope", graceMs: 400 });
    const started = performance.now();
    expect(await resolve(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
    expect(performance.now() - started).toBeLessThan(400);
});
