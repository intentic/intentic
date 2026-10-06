import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { Services } from "../composition.js";
import { AGENT_GIT_AUTHOR } from "../git-identity.js";

// A settings page's own write (a persona's card or kit, a connection's manifest entry, the Agent tab's settings.json),
// committed on its own as it lands.
// These files are versioned in the workspace (VERSIONED_STATE_PATHS), and left uncommitted they read as the owner's own
// edits: a land touching the same file was refused as work only its owner could move, and it took three Accepts, a
// manual save and a redo to get it through. Unlike the `version-landed` rule's commits this does not wait on the owner
// opting in: the owner never edited these files, the app did, so nothing of theirs is swept into history by it.
// Exactly the paths written, never whatever else is dirty or staged, and under the repo lock, so a land queues behind
// it. Best-effort: a workspace whose own `.git` ignores `.intentic` refuses the stage, and the file stays as it was.

// The commit itself goes through the git slice rather than an import of git/: every settings page sits above git/ in
// the daemon, and git/ reaches back up to most of them.
type SettingsVersionHost = Pick<Services, "agentWorktrees" | "git" | "logger">;

// Only paths git can stage: one on disk, or one it tracks (a removed kit's deletions). A kit that never existed is
// neither, and naming it would fail the whole stage.
const stageable = async (dir: string, paths: readonly string[], git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["ls-files", "-z", "--", ...paths]);
    const tracked = stdout.split("\0").filter((file) => file !== "");
    return paths.filter((path) => existsSync(join(dir, path)) || tracked.some((file) => file === path || file.startsWith(`${path}/`)));
};

// Whether any of `paths` differs from HEAD (staged, unstaged or untracked); true when git cannot say, so a doubt keeps
// the write uncommitted rather than committing somebody's work.
const uncommitted = async (services: SettingsVersionHost, paths: readonly string[], git: GitRunner): Promise<boolean> => {
    try {
        const { stdout } = await git(services.agentWorktrees.mainDir("root"), ["status", "--porcelain", "--untracked-files=all", "--", ...paths]);
        return stdout.trim() !== "";
    } catch {
        // allow(silent-catch): a doubt is the answer here, and the caller acts on it by leaving the write uncommitted
        return true;
    }
};

/**
 * Runs `write` and commits `paths` after it as `versionSettingsWrite` does, but only when they held nothing uncommitted
 * before it: a file the owner also edits by hand (settings.json) may carry their own unsaved edits, and those are
 * theirs to commit, never swept in under a page's subject. `write`'s own failure propagates; the commit never throws.
 */
export const versionedSettingsWrite = async <T>(
    services: SettingsVersionHost,
    paths: readonly string[],
    subject: string,
    write: () => Promise<T>,
    git: GitRunner = defaultGit,
): Promise<T> => {
    const theirs = await uncommitted(services, paths, git);
    const result = await write();
    if (!theirs) {
        await versionSettingsWrite(services, paths, subject, git);
    }
    return result;
};

/** Commits exactly `paths` (workspace-relative) under `subject`; false when nothing was committed. Never throws. */
export const versionSettingsWrite = async (
    services: SettingsVersionHost,
    paths: readonly string[],
    subject: string,
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    try {
        const dir = services.agentWorktrees.mainDir("root");
        return await services.agentWorktrees.withRepoLock("root", async () =>
            services.git.commitOnly(dir, await stageable(dir, paths, git), subject, AGENT_GIT_AUTHOR, git),
        );
    } catch (error) {
        services.logger.debug({ err: error, paths }, "settings: a settings page's write stays uncommitted");
        return false;
    }
};
