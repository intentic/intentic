import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnitOwners } from "../../store/conversation-units.js";
import { overlaysDir, overlaysRoot } from "./isolation.js";
import { orphanCheckoutsChore, type OrphanCheckoutsDeps, sweepOrphanCheckouts } from "./orphan-checkouts.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DAY_MS = 24 * 60 * 60_000;

const historyRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "orphan-checkouts-"));
    roots.push(root);
    return root;
};

// A checkout and its overlay for `id`, as worktrees.ts and isolation.ts lay them out.
const conversationOnDisk = async (root: string, id: string): Promise<void> => {
    await mkdir(join(root, "worktrees", id, "src"), { recursive: true });
    await writeFile(join(root, "worktrees", id, "src", "draft.ts"), "uncommitted\n");
    await mkdir(join(overlaysDir(root, id), "node_modules", "upper"), { recursive: true });
    await mkdir(join(overlaysDir(root, id), "node_modules", "work"), { recursive: true });
};

const depsFor = (root: string, registry: readonly string[], owners: UnitOwners, now: number): OrphanCheckoutsDeps => ({
    historyRoot: root,
    worktreesRoot: join(root, "worktrees"),
    registry: { ids: () => [...registry] },
    owners,
    logger: { info: () => undefined, warn: () => undefined },
    now: () => now,
});

const database = (ids: readonly string[], recreated = false): UnitOwners => ({ has: (id) => ids.includes(id), any: () => ids.length > 0, recreated });

test("an unowned checkout moves to the trash and its overlay is removed, a day after anything changed in them", async () => {
    const root = await historyRoot();
    await conversationOnDisk(root, "owned-one");
    await conversationOnDisk(root, "gone-one");
    // A row this build cannot read still owns its directories: the database answers for it, the registry does not.
    await conversationOnDisk(root, "unreadable-row");
    await mkdir(join(root, "worktrees", ".not-a-conversation"), { recursive: true });
    const owners = database(["owned-one", "unreadable-row"]);

    // Everything was just written: a day has not passed.
    const early = await sweepOrphanCheckouts(depsFor(root, ["owned-one"], owners, Date.now()), Date.now());
    expect(early).toEqual({ checkouts: [], overlays: [], young: 2, unknown: 0, failed: [] });

    const later = Date.now() + DAY_MS + 60_000;
    const pass = await sweepOrphanCheckouts(depsFor(root, ["owned-one"], owners, later), later);
    expect(pass).toEqual({ checkouts: ["gone-one"], overlays: ["gone-one"], young: 0, unknown: 0, failed: [] });
    expect((await readdir(join(root, "worktrees"))).toSorted()).toEqual([".not-a-conversation", "owned-one", "unreadable-row"]);
    expect((await readdir(overlaysRoot(root))).toSorted()).toEqual(["owned-one", "unreadable-row"]);
    // Moved whole, stamped with the moment, so the trash sweep keeps it its while.
    expect(await readFile(join(root, "trash", `gone-one-checkout-${String(later)}`, "src", "draft.ts"), "utf8")).toBe("uncommitted\n");
});

test("nothing is judged while the registry cannot name every conversation", async () => {
    const root = await historyRoot();
    await conversationOnDisk(root, "gone-one");
    const later = Date.now() + 30 * DAY_MS;
    const sweep = (registry: readonly string[], owners: UnitOwners): ReturnType<typeof sweepOrphanCheckouts> =>
        sweepOrphanCheckouts(depsFor(root, registry, owners, later), later);

    expect((await sweep(["owned-one"], database(["owned-one"], true))).held).toBe("database-recreated");
    expect((await sweep([], database([]))).held).toBe("database-empty");
    expect((await sweep([], database(["owned-one"]))).held).toBe("registry-empty");
    expect(await readdir(join(root, "worktrees"))).toEqual(["gone-one"]);
    expect(await readdir(overlaysRoot(root))).toEqual(["gone-one"]);
});

test("a registry that throws when asked leaves that directory in place", async () => {
    const root = await historyRoot();
    await conversationOnDisk(root, "gone-one");
    const later = Date.now() + 30 * DAY_MS;
    const owners: UnitOwners = {
        has: () => {
            throw new Error("SQLITE_IOERR");
        },
        any: () => true,
        recreated: false,
    };
    expect(await sweepOrphanCheckouts(depsFor(root, ["owned-one"], owners, later), later)).toEqual({
        checkouts: [],
        overlays: [],
        young: 0,
        unknown: 2,
        failed: [],
    });
    expect(await readdir(join(root, "worktrees"))).toEqual(["gone-one"]);
});

test("the chore is the daily orphan-checkouts one, and an empty volume is no failure", async () => {
    const root = await historyRoot();
    const chore = orphanCheckoutsChore(depsFor(root, [], database([]), Date.now()));
    expect(chore.name).toBe("orphan-checkouts");
    expect(chore.everyMs).toBe(DAY_MS);
    await chore.run();
});
