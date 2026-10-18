import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathExists, writeFileAtomic } from "@intentic/base/fs";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import type { HistoryGitRunner } from "./history.js";

// RESTORE-POINT RETENTION (2026-10-13). Restore points older than settings.retention.restorePointDays are cut off with
// git's own shallow boundary rather than by rewriting the chain. The newest snapshot before the cut stays as the
// chain's root ("the base", listed in <gitDir>/shallow): it is the state every later point that has no commit of its
// own in this scope restores to, so cutting it too would make a newer restore skip the scope. It is hidden from the
// timeline (history.ts reads it as an interval capture), everything behind it becomes unreachable, and
// `gc --prune=now` takes that off the disk. Rewriting the kept commits instead would cost one git process per kept
// snapshot on every run; the boundary costs one file. Rejected: grafts or replace refs, which keep the objects. A
// deleted repo's scope with nothing newer than the cut is removed whole: nothing it holds is inside the window.

// A first pass over an old store may repack a lot, and it holds the history lock throughout (a `gc --prune=now` beside a
// snapshot being written could drop that snapshot's objects), so snapshots wait while it runs. Bounded, so a stuck git
// cannot hold them off for good; generous, because the store this exists for is the multi-GB one, whose repack takes
// minutes, and a budget it can never finish in would cut the collection off every day and free nothing. A pass cut off
// leaves its pending mark, and the next day's finishes it.
const RETENTION_GIT_BUDGET_MS = 15 * 60_000;

export const retentionGit = (git: HistoryGitRunner): HistoryGitRunner => {
    const signal = AbortSignal.timeout(RETENTION_GIT_BUDGET_MS);
    return (args, options) => git(args, { ...options, signal });
};

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

// Removes a scope's snapshots taken before `before` (epoch ms); returns how many it took off the timeline.
const pruneScope = async (deps: PruneDeps, before: number): Promise<number> => {
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
    const base = { sha };
    const behind = Number((await git(["rev-list", "--count", sha], bare)).stdout.trim()) - 1;
    const hidden = (await retentionBases(scope.gitDir)).has(base.sha);
    const pendingGc = join(scope.gitDir, "retention-gc-pending");
    if (behind === 0 && hidden && !(await pathExists(pendingGc))) {
        return 0;
    }
    const collect = behind > 0 || (await pathExists(pendingGc));
    // Record the collection before the cut, so a crash between the two writes still retries it.
    if (collect) {
        await writeFileAtomic(pendingGc, "pending\n");
    }
    const shallow = join(scope.gitDir, "shallow");
    await writeFileAtomic(shallow, `${base.sha}\n`);
    if (collect) {
        await git(["reflog", "expire", "--expire=now", "--all"], bare);
        // A cruft pack would keep what the cut left unreachable; --prune=now with -a drops it instead.
        await git(["-c", "gc.cruftPacks=false", "gc", "--prune=now", "-q"], bare);
        await rm(pendingGc, { force: true });
    }
    return behind + (hidden ? 0 : 1);
};

// Every scope in turn; one that fails is logged and the rest still go.
export const pruneScopes = async (
    deps: Omit<PruneDeps, "scope" | "bare"> & { readonly scopes: readonly RetentionScope[]; readonly bareOf: (scope: RetentionScope) => BareRun },
    before: number,
): Promise<number> => {
    let removed = 0;
    for (const scope of deps.scopes) {
        try {
            removed += await pruneScope({ git: deps.git, logger: deps.logger, scope, bare: deps.bareOf(scope) }, before);
        } catch (error) {
            deps.logger.warn({ err: error, scope: scope.name }, "history: pruning restore points failed");
        }
    }
    return removed;
};
