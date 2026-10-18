import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathExists, writeFileAtomic } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { HistoryGitRunner } from "./history.js";

// RESTORE-POINT RETENTION (2026-10-13). Restore points older than settings.retention.restorePointKeepDays are cut off with
// git's own shallow boundary rather than by rewriting the chain. The newest snapshot before the cut stays as the
// chain's root ("the base", listed in <gitDir>/shallow): it is the state every later point that has no commit of its
// own in this scope restores to, so cutting it too would make a newer restore skip the scope. It is hidden from the
// timeline (history.ts reads it as an interval capture), everything behind it becomes unreachable, and a `gc` takes
// that off the disk. Rewriting the kept commits instead would cost one git process per kept snapshot on every run; the
// boundary costs one file. Rejected: grafts or replace refs, which keep the objects. A deleted repo's scope with nothing
// newer than the cut is removed whole: nothing it holds is inside the window.

// THE CUT AND THE COLLECTION ARE TWO STEPS (2026-10-18). The cut (`cutScopes`) is quick and runs under the history lock:
// the boundary, the reflog, the pending mark, a deleted repo's scope. The collection (`collectScopes`) is the `gc`, which
// on a multi-GB store repacks for minutes, and it runs OUTSIDE the lock, so snapshots (and every git action of the
// owner's that takes one first) never wait on it. That is safe because it prunes with a grace, git's own model for a gc
// beside writers: an unreachable object younger than RETENTION_GRACE_MS is kept, so the objects a snapshot is writing
// at that moment, not yet named by its ref, are never taken. It is also why a collection that runs out of its budget
// may be stopped at all: the stop ends `git gc` only, and a `repack` or `prune` it started runs on to its end, which
// with a grace is as harmless as any gc beside a snapshot. Before (with `--prune=now`) the gc had to hold the lock, and
// a stop that left its `prune --expire=now` running past the lock could take a fresh snapshot's objects.
//
// What a grace leaves for later: an object the cut made unreachable is dropped only once it, or the pack it sits in,
// is older than the grace, and packs here are freshened by every snapshot that writes an object they already hold. The
// first collection after a cut therefore loosens what it cannot drop yet, giving each such object its pack's time, and
// the pending mark stays until a collection that starts a grace or more after that first one has run: by then
// everything the cut left is older than the horizon. With the daily sweep that is the next day's pass.
export const RETENTION_GRACE_MS = 60 * 60_000;

// How long one sweep's collections may run in all. Outside the lock, a long one costs nobody a wait, so this only
// bounds a git that will never finish; generous, since the store this exists for repacks for minutes. Scopes not
// reached keep their pending mark for the next pass.
const COLLECTION_BUDGET_MS = 2 * 60 * 60_000;

// The pending mark: written by a cut that left objects to collect, holding when the first collection of them ran.
const PENDING_MARK = "retention-gc-pending";

export interface RetentionScope {
    readonly name: string;
    readonly gitDir: string;
    readonly worktree: string;
}

// The bases of a scope, by commit sha: the commits the timeline shows as no checkpoint.
export const retentionBases = async (gitDir: string): Promise<Set<string>> => {
    const text = (await readFile(join(gitDir, "shallow"), "utf8").catch(undefinedIfMissing)) ?? "";
    return new Set(text.split("\n").filter((line) => line !== ""));
};

// A tree-only git command's place: the history root, with the scope's bare git dir.
export interface BareRun {
    readonly cwd: string;
    readonly env: Record<string, string>;
}

interface PruneDeps {
    readonly git: HistoryGitRunner;
    readonly scope: RetentionScope;
    // How to run a tree-only command against the scope's bare git dir.
    readonly bare: BareRun;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// Cuts a scope's snapshots taken before `before` (epoch ms) off its timeline; returns how many it took off. The objects
// they held go with the collection (`collectScopes`), which a cut that left any marks as pending.
const cutScope = async (deps: PruneDeps, before: number): Promise<number> => {
    const { git, scope, bare, logger } = deps;
    if (!(await pathExists(join(scope.gitDir, "refs")))) {
        return 0;
    }
    // A scope with no snapshot yet has no head to log, and nothing to prune.
    const head = (await git(["log", "-1", "--format=%ct", "refs/snapshots/head"], bare).catch(() => ({ stdout: "" }))).stdout.trim();
    if (head === "") {
        return 0;
    }
    if (Number(head) * 1000 < before && scope.name !== "root" && !(await pathExists(scope.worktree))) {
        const count = Number((await git(["rev-list", "--count", "refs/snapshots/head"], bare)).stdout.trim());
        await rm(scope.gitDir, { recursive: true, force: true });
        logger.info({ scope: scope.name, snapshots: count }, "history: removed a deleted repo's restore points past retention");
        return count;
    }
    // Never hide the newest snapshot, even when the whole store is old. Ask git for one boundary and a count rather
    // than bringing weeks of minute-by-minute history into the daemon's heap.
    const sha = (
        await git(["log", "-1", "--format=%H", `--before=${String(Math.ceil(before / 1000) - 1)}`, "refs/snapshots/head^"], bare).catch(() => ({
            stdout: "",
        }))
    ).stdout.trim();
    if (sha === "") {
        return 0;
    }
    const behind = Number((await git(["rev-list", "--count", sha], bare)).stdout.trim()) - 1;
    const hidden = (await retentionBases(scope.gitDir)).has(sha);
    if (behind === 0 && hidden) {
        return 0;
    }
    // Marked before the cut, so a crash between the two writes still collects. A new cut starts the count of
    // collections over: what it leaves unreachable has not been through one yet.
    if (behind > 0) {
        await writeFileAtomic(join(scope.gitDir, PENDING_MARK), "pending\n");
    }
    await writeFileAtomic(join(scope.gitDir, "shallow"), `${sha}\n`);
    if (behind > 0) {
        // The reflog would keep what the cut left behind reachable; it goes now, under the lock, with the cut.
        await git(["reflog", "expire", "--expire=now", "--all"], bare);
    }
    return behind + (hidden ? 0 : 1);
};

export interface CutOutcome {
    // Snapshots taken off the timeline.
    readonly removed: number;
    // Scopes holding objects a cut left for the collection, this pass's or an earlier one's.
    readonly collect: readonly RetentionScope[];
}

// The quick half, under the history lock: every scope's cut in turn; one that fails is logged and the rest still go.
export const cutScopes = async (
    deps: Omit<PruneDeps, "scope" | "bare"> & { readonly scopes: readonly RetentionScope[]; readonly bareOf: (scope: RetentionScope) => BareRun },
    before: number,
): Promise<CutOutcome> => {
    let removed = 0;
    const collect: RetentionScope[] = [];
    for (const scope of deps.scopes) {
        try {
            removed += await cutScope({ git: deps.git, logger: deps.logger, scope, bare: deps.bareOf(scope) }, before);
        } catch (error) {
            deps.logger.warn({ err: error, scope: scope.name }, "history: pruning restore points failed");
        }
        // Read after the cut, so an earlier pass's unfinished collection is carried on whatever this pass's cut decided.
        if (await pathExists(join(scope.gitDir, PENDING_MARK))) {
            collect.push(scope);
        }
    }
    return { removed, collect };
};

// When the first collection since a pending mark's cut ran; undefined when none has yet.
const lastCollection = async (mark: string): Promise<number | undefined> => {
    const said = /^gc (\d+)$/u.exec(((await readFile(mark, "utf8").catch(undefinedIfMissing)) ?? "").trim())?.[1];
    return said === undefined ? undefined : Number(said);
};

export interface CollectDeps {
    readonly git: HistoryGitRunner;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly bareOf: (scope: RetentionScope) => BareRun;
    // RETENTION_GRACE_MS unless a test needs `--prune=now`.
    readonly graceMs?: number | undefined;
    readonly now?: (() => number) | undefined;
}

// The slow half, OUTSIDE the history lock: each pending scope's gc, pruned with the grace, under one budget for all.
export const collectScopes = async (deps: CollectDeps, scopes: readonly RetentionScope[]): Promise<void> => {
    const graceMs = deps.graceMs ?? RETENTION_GRACE_MS;
    const now = deps.now ?? Date.now;
    const signal = AbortSignal.timeout(COLLECTION_BUDGET_MS);
    for (const scope of scopes) {
        if (signal.aborted) {
            deps.logger.warn({ scope: scope.name }, "history: restore-point collection ran out of time; the next pass carries on");
            return;
        }
        const mark = join(scope.gitDir, PENDING_MARK);
        const started = now();
        try {
            // A cruft pack would keep what the cut left unreachable; with it off, `-A` drops what is past the grace.
            const prune = graceMs === 0 ? "now" : `${String(Math.ceil(graceMs / 1000))}.seconds.ago`;
            await deps.git(["-c", "gc.cruftPacks=false", "gc", `--prune=${prune}`, "-q"], { ...deps.bareOf(scope), signal });
        } catch (error) {
            deps.logger.warn({ err: error, scope: scope.name }, "history: collecting pruned restore points failed; the next pass tries again");
            continue;
        }
        // Done once a collection has started a grace after the first since the cut (above), which only loosened: every
        // object the cut left is then loose and no newer than that first one.
        const first = await lastCollection(mark);
        if (graceMs === 0 || (first !== undefined && started - graceMs >= first)) {
            await rm(mark, { force: true });
        } else if (first === undefined && (await pathExists(mark))) {
            await writeFileAtomic(mark, `gc ${String(started)}\n`);
        }
    }
};
