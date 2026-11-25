import { lstat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitRunner } from "@intentic/base/git";
import { exitCodeOf, undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import { ensureLines } from "../../store/plain-files/text-file.js";

// THE MIRROR LINKS' SAFETY: what keeps a dependency/build mirror (worktrees.ts linkMirrors) from ever being staged onto
// an agent's branch. Moved out of worktrees.ts as it was, so that file keeps to its size.

export interface MirrorLinks {
    readonly removedLink: (target: string, repo: string, mirror: string) => Promise<boolean>;
    readonly excludeMirrors: (main: string, mirrors: readonly string[]) => Promise<void>;
    readonly secureLinks: (main: string, worktree: string, mirrors: readonly string[], repo: string) => Promise<void>;
}

export const mirrorLinks = (git: GitRunner, logger: Pick<Logger, "warn">): MirrorLinks => {
    // Drops one mirror symlink, answering whether it went; what follows each call relies on the link being gone.
    const removedLink = async (target: string, repo: string, mirror: string): Promise<boolean> => {
        try {
            await rm(target, { force: true });
            return true;
        } catch (error) {
            logger.warn({ err: error, repo, mirror }, "agents: could not remove a mirror link");
            return false;
        }
    };

    // Which of these mirror paths git will actually ignore. A mirror is a SYMLINK, and a directory-only gitignore rule
    // (`node_modules/`) matches a directory but never a symlink, so the answer differs by what stands there when asked;
    // every caller below asks about links that already exist. check-ignore exits 1 for "none of them", not failure.
    const ignoredLinks = async (worktree: string, links: readonly string[]): Promise<Set<string>> => {
        if (links.length === 0) {
            return new Set();
        }
        const { stdout } = await git(worktree, ["check-ignore", ...links]).catch((error) => {
            // A failed check answers "none ignored" too, which drops the links: tooling lost, never a mirror committed.
            if (exitCodeOf(error) !== 1) {
                logger.warn({ err: error, worktree }, "agents: could not ask git which mirror links it ignores");
            }
            return { stdout: "" };
        });
        return new Set(stdout.split("\n").filter((path) => path !== ""));
    };

    // Git's own exclude file for a repo: never committed, never pushed, and shared by every worktree of it (git reads
    // it from the common dir, not the per-worktree one). Anchored, file-matching lines here cover the symlink form that
    // a repo's own `node_modules/` cannot, so no `git add -A` — the pre-turn anchor's or an agent's own — can commit a
    // mirror onto the branch and hand the land a symlink it can never apply over the user's real directory.
    const MIRROR_EXCLUDE_NOTE = "# intentic: dependency and build dirs mirrored into agent worktrees.";

    const excludeFileOf = async (main: string): Promise<string | undefined> => {
        const { stdout } = await git(main, ["rev-parse", "--git-common-dir"]).catch((error) => {
            logger.warn({ err: error, main }, "agents: could not locate the repo's exclude file for its mirror links");
            return { stdout: "" };
        });
        const common = stdout.trim();
        return common === "" ? undefined : join(resolve(main, common), "info", "exclude");
    };

    const excludeMirrors = async (main: string, mirrors: readonly string[]): Promise<void> => {
        if (mirrors.length === 0) {
            return;
        }
        const path = await excludeFileOf(main);
        if (path === undefined) {
            return;
        }
        // Queued on the file, which every worktree of the repo shares and project-installs grows too. The owner's own
        // exclude lines live here as well: content that exists but cannot be read is never written over.
        await ensureLines(
            path,
            mirrors.map((rel) => `/${rel}`),
            { note: MIRROR_EXCLUDE_NOTE },
        ).catch((error) => logger.warn({ err: error, main }, "agents: mirror exclude not written, left as it is"));
    };

    // Every link git would stage, asked of the links as they now stand rather than of whatever preceded them: the
    // question only has an answer once the symlink exists. Excluding them locally settles it for any repo whose rule is
    // merely directory-only; a repo that actively un-ignores the path (a tracked `!` rule outranks info/exclude) keeps
    // no link at all, since a committed mirror blocks every land afterwards with a conflict neither side can clear.
    // Only symlinks are dropped: a real install the agent made is a directory and stays.
    const secureLinks = async (main: string, worktree: string, mirrors: readonly string[], repo: string): Promise<void> => {
        const already = await ignoredLinks(worktree, mirrors);
        const stageable = mirrors.filter((rel) => !already.has(rel));
        if (stageable.length === 0) {
            return;
        }
        await excludeMirrors(main, stageable);
        const covered = await ignoredLinks(worktree, stageable);
        await Promise.all(
            stageable
                .filter((rel) => !covered.has(rel))
                .map(async (rel) => {
                    const target = join(worktree, rel);
                    if ((await lstat(target).catch(undefinedIfMissing))?.isSymbolicLink() !== true) {
                        return;
                    }
                    logger.warn({ repo, mirror: rel }, "agents: mirror left unlinked, this repo un-ignores it");
                    await removedLink(target, repo, rel);
                }),
        );
    };

    return { removedLink, excludeMirrors, secureLinks };
};
