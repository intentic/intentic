import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createFreshnessResolver, type PinnedPackage } from "./registry-freshness.js";

/* The half of the resolver that touches a real filesystem: the cache that spans turns. Everything about
 * WHAT it answers is pure and lives next door under the unit budget; this file exists because a temp tree
 * puts a suite in the integration budget, and only these two cases need one. */

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

/* What keeps a busy workspace from asking the registry for the same forty packages on every conversation:
 * the memory layer dies with the turn, this one does not. */
test("an answer survives to the next turn through the cache on disk", async () => {
    await inTempDir(async (dir) => {
        const { fetcher, calls } = npmStub("2.0.0");
        vi.stubGlobal("fetch", fetcher);
        expect(await createFreshnessResolver({ cacheDir: dir })(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
        // The write is deliberately not awaited by the lookup (a hung cache must never hold an answer it
        // already has), so the settling is what a second turn would find, not an ordering this can assume.
        await vi.waitFor(async () => {
            const calm = { count: 0 };
            const second = npmStub("2.0.0", calm);
            vi.stubGlobal("fetch", second.fetcher);
            // A second resolver is a second turn: nothing in memory, everything on disk.
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

/* A cache it cannot write is a cache miss next time and nothing worse. Written against a path UNDER A FILE,
 * which fails fast with ENOTDIR — the first version of this aimed at /proc, where `mkdir` does not fail at
 * all but HANGS, and it found a real bug: the lookup awaited the write, so a wedged cache silently swallowed
 * an answer it already had. That is fixed (the write is fire-and-forget); this keeps the easy half honest. */
test("an unwritable cache directory still answers", async () => {
    const { fetcher } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    expect(await createFreshnessResolver({ cacheDir: "/etc/hostname/not-a-dir" })(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
});

/* THE REGRESSION for the bug above, stated as the property rather than as the path that exposed it: a cache
 * write that never settles must not delay the answer by so much as its grace. */
test("a cache write that hangs forever does not hold up the answer", async () => {
    const { fetcher } = npmStub("2.0.0");
    vi.stubGlobal("fetch", fetcher);
    const resolve = createFreshnessResolver({ cacheDir: "/proc/nonexistent/nope", graceMs: 400 });
    const started = performance.now();
    expect(await resolve(pin("1.0.0"))).toEqual({ latest: "2.0.0", gap: "major" });
    expect(performance.now() - started).toBeLessThan(400);
});
