import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quarantineRoot, type UnitSweep } from "../../../store/conversation-units.js";
import { sweepTrash, TRASH_KEEP_MS, trashRoot, trashSweepChore } from "./trash-sweep.js";

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DAY_MS = 24 * 60 * 60_000;

const historyRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "trash-sweep-"));
    roots.push(root);
    return root;
};

// A directory set aside under `name`, holding one file, its own mtime set `ageMs` back. Its ctime is the real now,
// which nothing in a test can set back: a pass reads it at a `now` beyond that.
const setAside = async (root: string, name: string, ageMs: number): Promise<void> => {
    const dir = join(trashRoot(root), name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "HEAD"), "ref: refs/heads/main\n");
    const at = new Date(Date.now() - ageMs);
    await utimes(dir, at, at);
};

const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

test("a pass removes what was set aside past its while, keeps what was not, and never reaches into the conversations' quarantine", async () => {
    const root = await historyRoot();
    const moved = Date.now();
    await setAside(root, `root-calm-vale-gbmd-git-${String(moved)}`, 40 * DAY_MS);
    // Stamped by its writer as moved later than the disk says.
    await setAside(root, `site-${String(moved + 3 * DAY_MS)}`, 40 * DAY_MS);
    await mkdir(join(quarantineRoot(root), "old-convo"), { recursive: true });
    await utimes(join(quarantineRoot(root), "old-convo"), new Date(0), new Date(0));
    await symlink("/nonexistent-target", join(trashRoot(root), "a-link"));

    const early = await sweepTrash(root, moved + TRASH_KEEP_MS - DAY_MS);
    expect(early).toEqual({ removed: [], kept: 3, failed: [] });

    const later = await sweepTrash(root, moved + TRASH_KEEP_MS + DAY_MS);
    expect(later.removed.toSorted()).toEqual(["a-link", `root-calm-vale-gbmd-git-${String(moved)}`]);
    expect(later.kept).toBe(1);
    expect((await readdir(trashRoot(root))).toSorted()).toEqual(["conversations", `site-${String(moved + 3 * DAY_MS)}`]);
    expect(await readdir(quarantineRoot(root))).toEqual(["old-convo"]);
});

test("a volume with no trash sweeps nothing rather than failing", async () => {
    expect(await sweepTrash(await historyRoot(), Date.now())).toEqual({ removed: [], kept: 0, failed: [] });
});

test("the chore runs the quarantine's own prune, and sweeps the blobs only when that removed something", async () => {
    const root = await historyRoot();
    await setAside(root, `pkg-x-${String(Date.now())}`, 0);
    const answers: UnitSweep[] = [
        { held: "database-empty", quarantined: [], pruned: [] },
        { quarantined: [], pruned: [] },
        { quarantined: [], pruned: ["c1"] },
    ];
    const prunedAt: number[] = [];
    const swept: ReadonlySet<string>[] = [];
    const now = Date.now() + TRASH_KEEP_MS + DAY_MS;
    const chore = trashSweepChore({
        historyRoot: root,
        units: {
            prune: async (at) => {
                prunedAt.push(at);
                return answers.shift()!;
            },
        },
        transcripts: {
            sweep: async (gone) => {
                swept.push(gone);
            },
        },
        logger: silent,
        now: () => now,
    });
    expect(chore.name).toBe("trash-sweep");

    await chore.run();
    await chore.run();
    expect(swept).toEqual([]);
    await chore.run();
    expect(prunedAt).toEqual([now, now, now]);
    expect(swept).toEqual([new Set()]);
    expect(await readdir(trashRoot(root))).toEqual([]);
});
