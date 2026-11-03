import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isInside } from "@intentic/base/contained";
import { ORPCError } from "@orpc/server";
import type { AgentClone } from "@intentic/sandbox-contract/schemas/git/clone";
import { undefinedIfMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { headSha } from "../../../git/changes/changes.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";
import { type BooksDeps, settleLandBooks } from "../turn-landing.js";

// A CLONE OF ITS OWN, SETTLED FROM THE CARD. A turn that runs `git init` (or clones) inside its copy leaves its work in a
// repository no land carries: the card says so (TurnReach.stranded, turn-reach.ts strandedClones), and until 2026-11 it
// offered nothing else, so on one sandbox the agent had to `rm -rf integra/.git` itself, behind a permission prompt, with
// the person asking why their work would not land. Two ways out, both from the card:
// - fold: the clone's `.git` goes, so its files are ordinary work of the repository around it and land with the rest. A
//   clone holding commits is folded only when the caller names their count, which the card shows before the press.
// - adopt: the clone moves into the main tree at the same folder, `.git` and every file git does not ignore, as a
//   workspace repository of its own (discovered like any repository the owner clones), and leaves the copy.

// Where a clone the card names sits: the composed repository around it, and the clone's folder inside that checkout.
interface PlacedClone {
    readonly parent: string;
    readonly dir: string;
    readonly path: string;
}

// The card names a clone relative to the conversation's copy of the workspace (strandedClones): a composed repository's
// own folder prefixes it unless it sits in the root.
export const placeClone = (entry: IsolatedAgent, dir: string, worktreeDir: (repo: string) => string): PlacedClone => {
    const clean = dir.replace(/\/+$/, "");
    if (clean.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new ORPCError("BAD_REQUEST", { message: `not a folder inside the conversation's copy: ${dir}` });
    }
    const nested = entry.placement.repos
        .map(({ repo }) => repo)
        .filter((repo) => repo !== "root" && clean.startsWith(`${repo}/`))
        .sort((a, b) => b.length - a.length)[0];
    const parent = nested ?? "root";
    if (parent === "root" && !entry.placement.repos.some(({ repo }) => repo === "root")) {
        throw new ORPCError("NOT_FOUND", { message: `no repository of this conversation holds ${dir}` });
    }
    const within = nested === undefined ? clean : clean.slice(nested.length + 1);
    const base = worktreeDir(parent);
    const path = join(base, within);
    if (!isInside(base, path) || path === base) {
        throw new ORPCError("BAD_REQUEST", { message: `not a folder inside the conversation's copy: ${dir}` });
    }
    return { parent, dir: clean, path };
};

// The clone's own `.git`: a directory for one `git init` or `git clone` made, a file for a worktree or a submodule,
// whose history lives somewhere else.
const gitEntryOf = async (path: string): Promise<"dir" | "file" | undefined> => {
    const stats = await lstat(join(path, ".git")).catch(undefinedIfMissing);
    return stats === undefined ? undefined : stats.isDirectory() ? "dir" : "file";
};

/** Commits the clone holds at all: 0 for one `git init` made and nothing was committed in. */
export const cloneCommits = async (path: string, git: GitRunner = defaultGit): Promise<number> =>
    (await headSha(path, git)) === undefined ? 0 : Number((await git(path, ["rev-list", "--count", "HEAD"])).stdout.trim()) || 0;

const fold = async (clone: PlacedClone, dropCommits: number | undefined, git: GitRunner): Promise<void> => {
    const commits = await cloneCommits(clone.path, git);
    if (commits > 0 && dropCommits !== commits) {
        throw new ORPCError("CONFLICT", {
            message: `${clone.dir} holds ${commits} commit${commits === 1 ? "" : "s"}: folding keeps its files and drops that history, so say so (dropCommits: ${commits})`,
        });
    }
    await rm(join(clone.path, ".git"), { recursive: true, force: true });
};

// Every file git keeps in the clone: tracked, and untracked but not ignored. Build output an ignore rule names stays
// behind with the copy, as a land leaves it: the source rebuilds it.
const keptFiles = async (path: string, git: GitRunner): Promise<string[]> =>
    (await git(path, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).stdout.split("\0").filter((file) => file !== "");

const adopt = async (clone: PlacedClone, mainRoot: string, git: GitRunner): Promise<void> => {
    if ((await gitEntryOf(clone.path)) !== "dir") {
        throw new ORPCError("CONFLICT", { message: `${clone.dir} keeps its history somewhere else (its .git is a pointer), so it cannot move on its own` });
    }
    const target = join(mainRoot, clone.dir);
    if ((await lstat(target).catch(undefinedIfMissing)) !== undefined) {
        throw new ORPCError("CONFLICT", { message: `your workspace already has ${clone.dir}: move or remove it first` });
    }
    const files = [...new Set(await keptFiles(clone.path, git))];
    try {
        await mkdir(target, { recursive: true });
        // Copied, never renamed: the copy and the workspace sit on different mounts.
        await cp(join(clone.path, ".git"), join(target, ".git"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
        for (const file of files) {
            const to = join(target, file);
            await mkdir(dirname(to), { recursive: true });
            // A file listed and since removed is simply not there to move; anything else stops the move.
            await cp(join(clone.path, file), to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true }).catch(undefinedIfMissing);
        }
    } catch (error) {
        // Half a repository in the owner's tree is worse than none: the copy still holds all of it.
        await rm(target, { recursive: true, force: true });
        throw error;
    }
    await rm(clone.path, { recursive: true, force: true });
};

export type CloneDeps = BooksDeps;

/**
 * Settles one clone the card names, under the conversation's land lease so no land reads the copy meanwhile. The card's
 * reach stops naming it, and a fold measures the conversation's books again, so its card reads the files it now carries.
 */
export const settleClone = async (deps: CloneDeps, entry: IsolatedAgent, input: AgentClone, git: GitRunner = defaultGit): Promise<{ readonly ok: true }> => {
    if (deps.conversations.running(entry.id) || deps.conversations.landing(entry.id)) {
        throw new ORPCError("CONFLICT", { message: "the agent's turn is running or landing, wait for it to finish" });
    }
    await deps.conversations.withLandLease(entry.id, async () => {
        if (!(await deps.agentWorktrees.attached(entry.id, "root")) && !entry.placement.repos.some(({ repo }) => repo !== "root")) {
            throw new ORPCError("CONFLICT", { message: "this conversation's copy is gone, and the clone went with it" });
        }
        const clone = placeClone(entry, input.dir, (repo) => deps.agentWorktrees.worktreeDir(entry.id, repo));
        if ((await gitEntryOf(clone.path)) === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `${clone.dir} is no repository of its own any more` });
        }
        if (input.action === "fold") {
            await fold(clone, input.dropCommits, git);
        } else {
            await adopt(clone, deps.agentWorktrees.mainDir("root"), git);
        }
    });
    await deps.agents.forgetStranded(entry.id, input.dir);
    if (input.action === "fold") {
        await settleLandBooks(deps, entry.id);
    }
    return { ok: true };
};
