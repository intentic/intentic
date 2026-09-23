import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { afterEach, expect, test } from "bun:test";
import type { Logger } from "pino";
import { createDiskStorage, type DiskStorageOptions } from "./disk-storage.js";
import type { RunningProgram } from "./running-programs.js";
import type { StorageRoots } from "./storage-catalog.js";
import { plant, removeStorageTrees, storageTree } from "./storage.testing.js";

// The one scan and the one clean a daemon runs at a time, over a real temp tree. A scan reads the process table once
// its walk is done, which is where these hold it, so the order of what happens next is the test's and not the disk's.

const NOW = Date.now();
const OLD = 30 * 24 * 60 * 60 * 1000;

afterEach(removeStorageTrees);

const storageOver = (roots: StorageRoots, over: Partial<DiskStorageOptions> = {}) =>
    createDiskStorage({
        workspaceRoot: roots.workspace,
        historyRoot: roots.history,
        logger: unstubbed<Logger>("logger", { info: () => {} }),
        programs: async () => [],
        prune: async () => false,
        ...over,
    });

// A process table that answers only when the test says so, counting how often it was read.
const heldPrograms = () => {
    const gate = Promise.withResolvers<readonly RunningProgram[]>();
    let reads = 0;
    return {
        programs: () => {
            reads += 1;
            return gate.promise;
        },
        release: () => gate.resolve([]),
        reads: () => reads,
    };
};

test("two scans asked for at once are one scan, and the report says one is running until it ends", async () => {
    const { roots } = await storageTree();
    await plant(join(roots.history, "trash", "site-1789157842097", "index.html"), 500, NOW, OLD);
    const held = heldPrograms();
    const storage = storageOver(roots, { programs: held.programs });

    const first = storage.scan();
    const second = storage.scan();
    expect(second).toBe(first);
    expect(storage.report()).toEqual({ scanning: true });

    held.release();
    const report = await first;
    expect(report.scanning).toBe(false);
    expect(report.scan?.categories.map((category) => [category.id, category.bytes])).toEqual([["trash", 500]]);
    expect(held.reads()).toBe(1);
});

test("a cancelled scan leaves the last finished one standing", async () => {
    const { roots } = await storageTree();
    await plant(join(roots.history, "trash", "site-1789157842097", "index.html"), 500, NOW, OLD);
    const held = heldPrograms();
    let reads = 0;
    const storage = storageOver(roots, { programs: async () => (++reads === 1 ? [] : held.programs()) });
    const finished = await storage.scan();

    await plant(join(roots.history, "trash", "site-1789157842098", "index.html"), 900, NOW, OLD);
    const rescan = storage.scan();
    storage.cancel();
    held.release();
    // The rescan never lands: what the finished scan measured is still the answer, and nothing is running.
    expect(await rescan).toEqual(finished);
    expect(finished.scan?.categories.map((category) => [category.id, category.bytes])).toEqual([["trash", 500]]);
});

test("one clean at a time: a second one asked for meanwhile is refused, not queued", async () => {
    const { roots } = await storageTree();
    await plant(join(roots.history, ".pnpm-store", "v11", "files", "00", "a"), 1000, NOW, OLD);
    const pruning = Promise.withResolvers<boolean>();
    const storage = storageOver(roots, { prune: () => pruning.promise });

    const first = storage.clean("packageStores");
    expect(await storage.clean("trash")).toBe("already cleaning");
    pruning.resolve(true);
    expect(await first).toEqual({ category: "packageStores", freedBytes: 0, removed: 1, kept: 0, failed: 0 });
    expect(await storage.clean("workspace")).toBe("not cleanable");
});

test("a clean stops a scan in flight first, so no size it reports was measured mid-removal", async () => {
    const { roots } = await storageTree();
    await plant(join(roots.history, "trash", "site-1789157842097", "index.html"), 500, NOW, OLD);
    const held = heldPrograms();
    const storage = storageOver(roots, { programs: held.programs });

    const scanning = storage.scan();
    const cleaning = storage.clean("trash");
    held.release();
    // Cancelled before it could land: no scan has ever finished here.
    expect(await scanning).toEqual({ scanning: false });
    expect(await cleaning).toEqual({ category: "trash", freedBytes: 500, removed: 1, kept: 0, failed: 0 });
});
