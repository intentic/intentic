import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DAY_MS } from "../../chore-clock.js";
import { packageStoresChore, prunePackageStores } from "./package-stores-chore.js";
import type { RunningProgram } from "./running-programs.js";
import { plant, removeStorageTrees, storageTree } from "./storage.testing.js";

// Real temp volumes with a store at the top of each, as pnpm leaves them; the prune is a stand-in that removes what pnpm
// would call unreferenced, so what is asserted is which stores the chore reaches and when it leaves them alone.

const NOW = Date.now();
const OLD = 30 * DAY_MS;

afterEach(removeStorageTrees);

const silent = { info: () => undefined, warn: () => undefined };
// A logger that keeps the fields of every info line.
const recording = (logged: unknown[]) => ({ ...silent, info: (fields: unknown) => void logged.push(fields) });

const twoStores = async () => {
    const { roots } = await storageTree();
    const workspaceStore = join(roots.workspace, ".pnpm-store");
    const historyStore = join(roots.history, ".pnpm-store");
    const unreferenced = [
        await plant(join(workspaceStore, "v11", "files", "00", "a"), 1000, NOW, OLD),
        await plant(join(historyStore, "v11", "files", "01", "b"), 4000, NOW, OLD),
    ];
    await plant(join(workspaceStore, "v11", "files", "02", "kept"), 300, NOW, OLD);
    const pruned: string[] = [];
    const prune = async (storeDir: string): Promise<boolean> => {
        pruned.push(storeDir);
        await Promise.all(unreferenced.filter((path) => path.startsWith(`${storeDir}/`)).map((path) => rm(path)));
        return true;
    };
    return { roots, workspaceStore, historyStore, pruned, prune };
};

test("the store at the top of each volume is pruned, credited with what each prune freed", async () => {
    const { roots, workspaceStore, historyStore, pruned, prune } = await twoStores();
    const logged: unknown[] = [];

    const result = await prunePackageStores({ roots: async () => roots, prune, programs: async () => [], now: () => NOW, logger: recording(logged) });

    expect(result).toEqual({ category: "packageStores", freedBytes: 5000, removed: 2, kept: 0, failed: 0 });
    expect(pruned.toSorted()).toEqual([historyStore, workspaceStore].toSorted());
    expect(logged).toEqual([{ storage: result }]);
});

test("while any pnpm runs no store is handed to the prune, and nothing is logged", async () => {
    const { roots, pruned, prune } = await twoStores();
    const installing: RunningProgram = { argv: ["/usr/local/share/pnpm/bin/pnpm", "install"] };
    const logged: unknown[] = [];

    const result = await prunePackageStores({
        roots: async () => roots,
        prune,
        programs: async () => [installing],
        now: () => NOW,
        logger: recording(logged),
    });

    expect(result).toEqual({ category: "packageStores", freedBytes: 0, removed: 0, kept: 2, failed: 0 });
    expect(pruned).toEqual([]);
    expect(logged).toEqual([]);
});

test("it runs daily on the housekeeping clock", async () => {
    const { roots, pruned, prune } = await twoStores();
    const chore = packageStoresChore({ roots: async () => roots, prune, programs: async () => [], now: () => NOW, logger: silent });

    expect(chore.name).toBe("package-stores");
    expect(chore.everyMs).toBe(DAY_MS);
    expect(chore.when).toBeUndefined();
    await chore.run();
    expect(pruned).toHaveLength(2);
});
