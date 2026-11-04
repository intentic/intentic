import { cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import type { GitRunner } from "@intentic/base/git";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { repositoryOf } from "../../store/git/git-dir.js";

// WHAT A CONVERSATION WROTE WHERE A REPOSITORY'S CHECKOUT NOW HAS TO STAND. A nested repo the conversation does not
// carry is a hole in its root checkout: the root excludes the path as it excludes every repo, so whatever a turn wrote
// there reached no branch. When that repo joins later (it was unborn then, or cloned since), `worktree add` refuses a
// directory that is not empty, so those files are stood aside first and carried onto the new checkout after, where they
// read as the conversation's own changes to that repo, as they always were. Kept in the trash on /history, never in
// the checkout (where the root would capture them), until they are carried; a carry that fails leaves them there and
// says where in the log. A clone the conversation made there for itself is the same hole with a `.git` in it: its git
// dir goes to the trash under its own name (it may hold commits nobody pushed) and its files are carried like the rest,
// as relinkOne does for a checkout an agent `git init`ed over; left standing, `worktree add` failed every turn on
// `already exists`.

export interface CheckoutPlace {
    readonly historyRoot: string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly id: string;
    readonly repo: string;
    // The checkout's directory: where the hole is, and where `worktree add` puts the checkout.
    readonly target: string;
}

// Where the hole's contents went: its files, and the git dir of a clone the conversation made there.
interface StoodAside {
    readonly files?: string;
    readonly git?: string;
}

// A `.git` in the hole that is not one of this repository's checkouts (the conversation's own clone or `git init`)
// moved to the trash; undefined when it is one, which `worktree add` then names itself.
const gitAside = async ({ historyRoot, logger, id, repo, target }: CheckoutPlace, main: string): Promise<string | undefined> => {
    const own = await repositoryOf(target);
    if (own !== undefined && own === (await repositoryOf(main))) {
        return undefined;
    }
    // Named as relinkOne names the `.git` it sets aside, in the same trash.
    const kept = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-git-${Date.now()}`);
    await mkdir(dirname(kept), { recursive: true });
    await rename(join(target, ".git"), kept);
    logger.warn({ id, repo, kept }, "agents: the conversation's own clone stood where this repo's checkout goes, its git dir was kept in the trash");
    return kept;
};

// Moves the hole's contents out of the way. An empty or absent directory git takes as it is.
const standAside = async (place: CheckoutPlace, main: string): Promise<StoodAside> => {
    const { historyRoot, id, repo, target } = place;
    const entries = repo === "root" ? undefined : await readdir(target).catch(undefinedIfMissing);
    if (entries === undefined || entries.length === 0) {
        return {};
    }
    const git = entries.includes(".git") ? await gitAside(place, main) : undefined;
    if (entries.includes(".git") && git === undefined) {
        return {};
    }
    if (entries.length === 1 && git !== undefined) {
        return { git };
    }
    // Encoded like the git dirs in the same trash (history.ts reapGitDir): repo ids hold slashes.
    const files = join(historyRoot, "trash", `${encodeURIComponent(repo)}-${id}-${Date.now()}-before-checkout`);
    await mkdir(dirname(files), { recursive: true });
    await rename(target, files);
    return { files, ...opt("git", git) };
};

// A refused add leaves the hole as it was found, clone and all, so the next ensure meets it and tries again.
const putBack = async ({ logger, id, repo, target }: CheckoutPlace, { files, git }: StoodAside): Promise<void> => {
    if (files !== undefined && !(await pathExists(target))) {
        await rename(files, target).catch((err) => logger.warn({ err, id, repo, aside: files }, "agents: files stood aside could not be put back"));
    }
    if (git !== undefined && !(await pathExists(join(target, ".git")))) {
        await rename(git, join(target, ".git")).catch((err) =>
            logger.warn({ err, id, repo, aside: git }, "agents: the conversation's own clone's git dir could not be put back"),
        );
    }
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

// Runs `worktree add` (`args`, in the repo's main checkout) over whatever the hole holds, and rethrows a refusal once
// the hole is put back.
export const addCheckoutOver = async (place: CheckoutPlace, main: string, args: readonly string[], git: GitRunner): Promise<void> => {
    const stood = await standAside(place, main);
    try {
        await git(main, args);
    } catch (error) {
        await putBack(place, stood);
        throw error;
    }
    if (stood.files !== undefined) {
        await carryOnto(place, stood.files);
    }
};
