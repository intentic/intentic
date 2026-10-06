import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STALE_LOCK_MS } from "@intentic/base/git";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { clearStaleGitLocks, findStaleGitEntries, historyGitDirs, STALE_TMP_PACK_MS, staleGitEntry } from "./stale-git-locks.js";

// What a dead git left is removed only when old enough and only while no git runs; pinned on a temp history root, never
// the live /history.

const NOW = Date.parse("2026-10-05T12:00:00Z");
const MINUTE = 60_000;

describe("staleGitEntry", () => {
    test("a lock is stale past ten minutes, a temporary pack or index past a day", () => {
        expect(staleGitEntry("index.lock", NOW - STALE_LOCK_MS - MINUTE, NOW)).toBe("lock");
        expect(staleGitEntry("maintenance.lock", NOW - STALE_LOCK_MS + MINUTE, NOW)).toBeUndefined();
        expect(staleGitEntry("tmp_pack_mYPaBl", NOW - STALE_TMP_PACK_MS - MINUTE, NOW)).toBe("tmp-pack");
        expect(staleGitEntry("tmp_idx_Q2xa", NOW - STALE_TMP_PACK_MS - MINUTE, NOW)).toBe("tmp-pack");
        // An hour-old temporary pack may be a long repack still writing it.
        expect(staleGitEntry("tmp_pack_mYPaBl", NOW - 60 * MINUTE, NOW)).toBeUndefined();
    });

    test("nothing else is debris, however old, and nothing from the future is stale", () => {
        const ancient = NOW - 365 * STALE_TMP_PACK_MS;
        for (const name of ["locked", "HEAD", "packed-refs", "pack-1a2b.pack", "gc.pid", "lock", "index"]) {
            expect(staleGitEntry(name, ancient, NOW)).toBeUndefined();
        }
        expect(staleGitEntry("index.lock", NOW + STALE_LOCK_MS * 2, NOW)).toBeUndefined();
    });
});

describe("the sweep", () => {
    const tempDirs: string[] = [];
    afterEach(async () => {
        for (const dir of tempDirs.splice(0)) {
            await rm(dir, { recursive: true, force: true });
        }
    });

    const at = async (path: string, ageMs: number): Promise<string> => {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "");
        const when = new Date(NOW - ageMs);
        await utimes(path, when, when);
        return path;
    };

    // A history root shaped like the daemon's: two repo git dirs (one holding a conversation's worktree admin dir) and a
    // history scope, with debris in every place git leaves it, and files that must stay.
    const historyRoot = async (): Promise<{ root: string; stale: string[]; kept: string[] }> => {
        const root = await mkdtemp(join(tmpdir(), "intentic-stale-git-"));
        tempDirs.push(root);
        const repo = join(root, "gits", "intentic");
        const nested = join(root, "gits", encodeURIComponent("extensions/x"));
        const old = STALE_LOCK_MS + MINUTE;
        const stale = [
            await at(join(repo, "objects", "maintenance.lock"), 4 * STALE_TMP_PACK_MS),
            await at(join(repo, "objects", "pack", "tmp_pack_mYPaBl"), 4 * STALE_TMP_PACK_MS),
            await at(join(repo, "objects", "pack", "tmp_idx_aB3"), 2 * STALE_TMP_PACK_MS),
            await at(join(repo, "objects", "info", "commit-graphs", "commit-graph-chain.lock"), old),
            await at(join(repo, "packed-refs.lock"), old),
            await at(join(repo, "refs", "heads", "agent", "x.lock"), old),
            await at(join(repo, "worktrees", "coral-lantern", "index.lock"), old),
            await at(join(repo, "worktrees", "coral-lantern", "HEAD.lock"), old),
            await at(join(nested, "index.lock"), old),
            await at(join(root, "scopes", "intentic.git", "refs", "snapshots", "head.lock"), old),
        ];
        const kept = [
            await at(join(repo, "index.lock"), STALE_LOCK_MS - MINUTE),
            await at(join(repo, "objects", "pack", "tmp_pack_live"), 60 * MINUTE),
            await at(join(repo, "worktrees", "coral-lantern", "locked"), 30 * STALE_TMP_PACK_MS),
            await at(join(repo, "HEAD"), 30 * STALE_TMP_PACK_MS),
            // Loose-object dirs are not walked, and nothing outside a git dir is touched.
            await at(join(repo, "objects", "ab", "tmp_obj_x.lock"), old),
            await at(join(root, "worktrees", "coral-lantern", "stray.lock"), old),
            await at(join(root, "scopes", "not-a-git-dir", "index.lock"), old),
        ];
        return { root, stale, kept };
    };

    const exists = (path: string): Promise<boolean> => Bun.file(path).exists();
    const warnings = (lines: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] =>
        lines.filter((line) => line["level"] === "warn");

    test("finds every stale lock and temporary pack in the history git dirs and their worktrees, and only those", async () => {
        const { root, stale } = await historyRoot();
        expect((await historyGitDirs(root)).toSorted()).toEqual(
            [join(root, "gits", "extensions%2Fx"), join(root, "gits", "intentic"), join(root, "scopes", "intentic.git")].toSorted(),
        );
        const found = await findStaleGitEntries(await historyGitDirs(root), NOW);
        expect(found.map((entry) => entry.path).toSorted()).toEqual(stale.toSorted());
        expect(found.find((entry) => entry.path.endsWith("tmp_pack_mYPaBl"))).toMatchObject({ kind: "tmp-pack", ageMs: 4 * STALE_TMP_PACK_MS });
    });

    test("with no git running, removes them and logs each one", async () => {
        const { root, stale, kept } = await historyRoot();
        const { lines, logger } = recordingLogger();
        const swept = await clearStaleGitLocks(root, logger, { now: () => NOW, gitRunning: async () => false });
        expect(swept.held).toBeUndefined();
        expect(swept.removed.map((entry) => entry.path).toSorted()).toEqual(stale.toSorted());
        // One line per removal, naming the path and its age.
        expect(
            warnings(lines)
                .map((line) => line["path"])
                .toSorted(),
        ).toEqual(stale.toSorted());
        expect(warnings(lines).find((line) => String(line["path"]).endsWith("tmp_pack_mYPaBl"))).toMatchObject({
            kind: "tmp-pack",
            ageMinutes: 4 * 24 * 60,
        });
        for (const path of stale) {
            expect(await exists(path)).toBe(false);
        }
        for (const path of kept) {
            expect(await exists(path)).toBe(true);
        }
    });

    test("a git running, or a /proc that cannot say, leaves everything and says why", async () => {
        for (const [running, held] of [
            [true, "git-running"],
            [undefined, "unknown"],
        ] as const) {
            const { root, stale } = await historyRoot();
            const { lines, logger } = recordingLogger();
            const swept = await clearStaleGitLocks(root, logger, { now: () => NOW, gitRunning: async () => running, polls: 2, pollMs: 1 });
            expect(swept).toEqual({ removed: [], held });
            expect(warnings(lines)).toEqual([expect.objectContaining({ held, paths: expect.arrayContaining(stale) })]);
            for (const path of stale) {
                expect(await exists(path)).toBe(true);
            }
        }
    });

    test("waits for a moment with no git before giving up", async () => {
        const { root, stale } = await historyRoot();
        const answers = [true, true, false];
        const swept = await clearStaleGitLocks(root, recordingLogger().logger, {
            now: () => NOW,
            gitRunning: async () => answers.shift(),
            polls: 3,
            pollMs: 1,
        });
        expect(swept.removed).toHaveLength(stale.length);
    });

    test("a history root with no git dirs is nothing to do", async () => {
        const root = await mkdtemp(join(tmpdir(), "intentic-stale-git-"));
        tempDirs.push(root);
        let probed = false;
        const swept = await clearStaleGitLocks(root, recordingLogger().logger, {
            gitRunning: async () => {
                probed = true;
                return false;
            },
        });
        expect(swept).toEqual({ removed: [] });
        // Nothing found means /proc is never read.
        expect(probed).toBe(false);
    });
});
