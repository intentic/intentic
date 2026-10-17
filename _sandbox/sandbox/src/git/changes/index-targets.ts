import type { GitRunner } from "@intentic/base/git";
import { DISCARDABLE_SIDES, isWholeRepo, scopedPaths, STAGEABLE_SIDES, UNSTAGEABLE_SIDES } from "@intentic/sandbox-contract/schemas/git/git-scope";
import { type GitChange, type GitDiffSide, type GitScope, type GitTarget, isScratch, type RepoChanges, type ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import type { Services } from "../../composition.js";
import { checkRunningIn, isBuildOutputPath } from "../../workspace/deps/checks-in-flight.js";
import { scratchScopeOf } from "./scratch.js";

// What a bulk target (GitTarget) names in one repository, resolved against live status, and the index moves that act
// on it: the Changes panel's stage, unstage and discard, the commit's stage-first, and the stage run's count
// (index-run.ts) all read a target through here, so the guardrail counts exactly what the stage then takes.

// The worktree rows that are the owner's to review. A check running in this repo is the daemon building the project,
// so its output dirs are mid-rewrite: a file the build has emptied but not yet written back is not a deletion to show,
// let alone to offer for staging. Held back only while that check runs (checks-in-flight.ts); the first scan after it
// reports whatever the build left standing. A build leaves the index alone, so `staged` stands as read.
export const ownWork = (repo: string, unstaged: GitChange[]): GitChange[] =>
    checkRunningIn(repo) ? unstaged.filter((change) => !isBuildOutputPath(change.path)) : unstaged;

export type IndexTargets = ReturnType<typeof createIndexTargets>;

export const createIndexTargets = (services: Pick<Services, "git" | "agentOrigins" | "workspace">) => {
    // Resolves a scope from a live `git status`, not the truncated review, so it acts past MAX_REPO_CHANGES. Origin
    // failures here throw (unlike the scan): a silent miss would quietly narrow a write.
    const scopeToPaths = async (repo: string, dir: string, scope: GitScope, sides: readonly GitDiffSide[]): Promise<readonly string[]> => {
        const { head, conflicted, staged, unstaged } = await services.git.changedFiles(dir);
        const origins = scope.origin === undefined ? {} : await services.agentOrigins.forRepo(repo, dir, head);
        // The worktree rows the scan shows (ownWork), so a scope never reaches a build-output row the panel hid.
        return scopedPaths({ conflicted, staged, unstaged: ownWork(repo, unstaged) }, sides, scope, origins);
    };
    // What a stage-everything leaves out of this repo right now (scratch.ts): the scan shows it, the stage honors it.
    const scratchIn = async (repo: string, dir: string): Promise<ScratchPath[]> =>
        services.git.scratchOf(dir, await scratchScopeOf(repo, services.workspace.root));
    // A repo row's `scratch`, read only when something is untracked: a scan runs about once a second while files land.
    const scratchRow = async (repo: string, dir: string, worktree: readonly GitChange[]): Promise<Pick<RepoChanges, "scratch">> => {
        if (!worktree.some((change) => change.status === "added")) {
            return {};
        }
        const scratch = await scratchIn(repo, dir);
        return scratch.length > 0 ? { scratch } : {};
    };
    // Stage-all uses a single-command spelling that never enumerates paths; a described target means "everything" of
    // some kind, and what looks like scratch joins one only when picked by path. Callers must hold the repo lock. `git`
    // is the stage run's killable runner; the plain routes leave it to the slice's own.
    const stageTarget = async (repo: string, dir: string, target: GitTarget, git?: GitRunner): Promise<void> => {
        if (target.paths !== undefined) {
            await services.git.stagePaths(dir, target.paths, git);
            return;
        }
        const scope = target.scope ?? {};
        const scratch = await scratchIn(repo, dir);
        if (isWholeRepo(scope)) {
            await services.git.stageAll(dir, scratch, git);
            return;
        }
        await services.git.stagePaths(dir, (await scopeToPaths(repo, dir, scope, STAGEABLE_SIDES)).filter((path) => !isScratch(path, scratch)), git);
    };
    // The paths `stageTarget` would hand git, for counting before it runs. A whole-repo stage is `add -A` less scratch,
    // which is every stageable row the scan would list less scratch; a dependency dir is in neither, since the project
    // excludes (git-layout.ts) keep it out of status altogether.
    const stagedBy = async (repo: string, dir: string, target: GitTarget): Promise<readonly string[]> => {
        if (target.paths !== undefined) {
            return target.paths;
        }
        const scratch = await scratchIn(repo, dir);
        return (await scopeToPaths(repo, dir, target.scope ?? {}, STAGEABLE_SIDES)).filter((path) => !isScratch(path, scratch));
    };
    // Unstage has no single-command spelling (a bare `reset` also clears MERGE_HEAD), so it always resolves to paths.
    const unstageTarget = async (repo: string, dir: string, target: GitTarget): Promise<void> => {
        await services.git.unstagePaths(dir, target.paths ?? (await scopeToPaths(repo, dir, target.scope ?? {}, UNSTAGEABLE_SIDES)));
    };
    const discardTarget = async (repo: string, dir: string, target: GitTarget): Promise<void> => {
        if (target.paths !== undefined) {
            await services.git.discardPaths(dir, target.paths);
            return;
        }
        const scope = target.scope ?? {};
        // `undefined` means the whole repo: `reset --hard` + `clean -fd`, which also removes now-empty dirs.
        await services.git.discardPaths(dir, isWholeRepo(scope) ? undefined : await scopeToPaths(repo, dir, scope, DISCARDABLE_SIDES));
    };
    return { scopeToPaths, scratchIn, scratchRow, stageTarget, stagedBy, unstageTarget, discardTarget };
};
