import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import type { GitRunner } from "@intentic/base/git";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import type { Logger } from "pino";

// WHAT A CONVERSATION WROTE WHERE A REPOSITORY'S CHECKOUT NOW HAS TO STAND. A nested repo the conversation does not
// carry is a hole in its root checkout: the root excludes the path as it excludes every repo, so whatever a turn wrote
// there reached no branch. When that repo joins later (it was unborn then, or cloned since), `worktree add` refuses a
// directory that is not empty, so those files are stood aside first and carried onto the new checkout after, where they
// read as the conversation's own changes to that repo, as they always were. Kept in the trash on /history, never in
// the checkout (where the root would capture them), until they are carried; a carry that fails leaves them there and
// says where in the log.

export interface CheckoutPlace {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly id: string;
    readonly repo: string;
    // The checkout's directory: where the hole is, and where `worktree add` puts the checkout.
    readonly target: string;
}

// Moves the hole's contents out of the way; undefined when there is nothing to move. An empty or absent directory git
// takes as it is, and a `.git` already there is a checkout, which git names itself.
const standAside = async ({ historyRoot, id, repo, target }: CheckoutPlace): Promise<string | undefined> => {
    const entries = repo === "root" ? undefined : await readdir(target).catch(undefinedIfMissing);
    if (entries === undefined || entries.length === 0 || entries.includes(".git")) {
        return undefined;
    }
    // Encoded like the git dirs in the same trash (history.ts reapGitDir): repo ids hold slashes.
    const aside = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-${Date.now()}-before-checkout`);
    await mkdir(dirname(aside), { recursive: true });
    await rename(target, aside);
    return aside;
};

// What the root checkout's own mirroring left in the hole (isolation.ts): a link to the main tree's installs, or the
// empty mount point an overlay sat on. Neither is work, and the new checkout gets mirrors of its own.
export const isMirrorResidue = async (path: string): Promise<boolean> => {
    if (!MIRRORED_DIRS.has(basename(path))) {
        return false;
    }
    const stats = await lstat(path).catch(undefinedIfMissing);
    return stats === undefined || stats.isSymbolicLink() || (stats.isDirectory() && (await readdir(path)).length === 0);
};

const keepOnly = async (source: string): Promise<boolean> => !(await isMirrorResidue(source));

// The conversation's files win over what the checkout brings: they are its edits to that repo, written before the repo
// had a checkout to hold them.
const carryOnto = async ({ logger, id, repo, target }: CheckoutPlace, aside: string): Promise<void> => {
    try {
        await cp(aside, target, { recursive: true, force: true, verbatimSymlinks: true, filter: keepOnly });
        await rm(aside, { recursive: true, force: true });
        logger.info({ id, repo }, "agents: files the conversation wrote before this repo joined its checkout were carried into it");
    } catch (error) {
        logger.warn({ err: error, id, repo, aside }, "agents: files the conversation wrote before this repo joined its checkout were kept aside");
    }
};

// Runs `worktree add` (`args`, in the repo's main checkout) over whatever the hole holds. A refused add puts the files
// back where they were, so the next ensure meets the same hole and tries again, and rethrows.
export const addCheckoutOver = async (place: CheckoutPlace, main: string, args: readonly string[], git: GitRunner): Promise<void> => {
    const aside = await standAside(place);
    try {
        await git(main, args);
    } catch (error) {
        if (aside !== undefined && !(await pathExists(place.target))) {
            await rename(aside, place.target).catch((cause: unknown) =>
                place.logger.warn({ err: cause, id: place.id, repo: place.repo, aside }, "agents: files stood aside could not be put back"),
            );
        }
        throw error;
    }
    if (aside !== undefined) {
        await carryOnto(place, aside);
    }
};
