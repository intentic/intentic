import { mkdir, readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { BranchNameSchema, type RepoBranch } from "@intentic/sandbox-contract/schemas/shared";
import { ORPCError } from "@orpc/server";
import type { Logger } from "pino";
// Type only, as orphan-checkouts.ts takes it: a value import from system/ would close a cycle between the subsystems.
import { type Chore, DAY_MS } from "../../../system/chore-clock.js";
import { lockedBranchOf } from "../../../git/main-line-lock.js";
import { commonDirOf, gitDirOf } from "../../../store/git/git-dir.js";
import { isValidRepoId } from "../../../workspace/layout/repo-discovery.js";
import type { AgentWorktrees } from "../worktrees.js";

// A branch checkout lives beside the shared workspace, laid out like /work. Branch sessions land uncommitted work
// here, and the owner edits, stages and commits it through Workspace. Refresh follows external ref moves only when
// Git can preserve local edits. The idle sweep removes clean, unused checkouts; dirty checkouts keep their work.

/** How long a checkout nobody lands onto stays after it was last looked at. */
export const BRANCH_CHECKOUT_IDLE_MS = 7 * DAY_MS;

// Its folder's modified time is when it was last used; written at most this often, since every read of a view asks.
const TOUCH_EVERY_MS = 60_000;

export interface BranchCheckouts {
    /** The workspace-shaped folder a view of the branch resolves paths against. */
    readonly viewRoot: (repo: string, branch: string) => string;
    /** The branch's checkout itself: the view root for the workspace, the repository's folder under it otherwise. */
    readonly checkoutDir: (repo: string, branch: string) => string;
    /**
     * Refuses what may not be checked out here, makes the local branch at origin's when only that exists, and adds the
     * checkout when it is not there yet; answers its folder. ORPCError with a plain reason when refused.
     */
    readonly ensure: (repo: string, branch: string) => Promise<string>;
    /** `ensure`, following the branch's tip while preserving local work; answers its folder. */
    readonly refresh: (repo: string, branch: string) => Promise<string>;
    /** Removes the checkout, never the branch; answers whether one stood. */
    readonly release: (repo: string, branch: string) => Promise<boolean>;
    /** The checkouts on disk now. */
    readonly standing: () => Promise<RepoBranch[]>;
    /** Removes each checkout no live conversation lands onto (`targeted`) and nobody used for a week; answers those removed. */
    readonly sweep: (targeted: () => readonly RepoBranch[], now?: number) => Promise<RepoBranch[]>;
}

export interface BranchCheckoutsDeps {
    readonly historyRoot: string;
    readonly worktrees: Pick<AgentWorktrees, "withRepoLock" | "mainDir">;
    readonly logger: Pick<Logger, "info" | "warn">;
}

const keyOf = (repo: string, branch: string): string => `${repo}\0${branch}`;

// A branch's tip read off the files (a loose ref, else packed-refs), so a view asking on every read spawns nothing;
// undefined when neither names it, which the caller then asks git.
const tipOnDisk = async (common: string, branch: string): Promise<string | undefined> => {
    const loose = (await readFile(join(common, "refs", "heads", branch), "utf8").catch(undefinedIfMissing))?.trim();
    if (loose !== undefined && /^[0-9a-f]{40,64}$/.test(loose)) {
        return loose;
    }
    const packed = (await readFile(join(common, "packed-refs"), "utf8").catch(undefinedIfMissing)) ?? "";
    const line = packed.split("\n").find((row) => row.endsWith(` refs/heads/${branch}`));
    return line?.split(" ")[0];
};

// What every step below shares: where things are, and what this process remembers of each checkout.
interface Held {
    readonly mainDir: (repo: string) => string;
    readonly viewRoot: (repo: string, branch: string) => string;
    readonly checkoutDir: (repo: string, branch: string) => string;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly git: GitRunner;
    // The sha each checkout was last brought to: equal to the branch's tip, nothing has moved since.
    readonly settledAt: Map<string, string>;
    readonly touchedAt: Map<string, number>;
}

const refused = (code: "BAD_REQUEST" | "NOT_FOUND" | "PRECONDITION_FAILED", message: string): never => {
    throw new ORPCError(code, { message });
};

const named = (repo: string): string => (repo === "root" ? "the workspace" : `\`${repo}\``);

const verified = async (dir: string, ref: string, git: GitRunner): Promise<boolean> =>
    // allow(silent-catch): `rev-parse -q --verify` exits 1 for a ref that is not there, which is the answer.
    (await git(dir, ["rev-parse", "-q", "--verify", ref]).catch(() => undefined)) !== undefined;

// What may be checked out here at all, before anything is written; answers the repository's main checkout.
const admissible = async ({ mainDir, git }: Held, repo: string, branch: string): Promise<string> => {
    if (repo !== "root" && !isValidRepoId(repo)) {
        refused("BAD_REQUEST", `\`${repo}\` is not a repository name.`);
    }
    const main = mainDir(repo);
    if (!(await pathExists(join(main, ".git")))) {
        refused("NOT_FOUND", `There is no repository at \`${repo}\` in the workspace.`);
    }
    if (!BranchNameSchema.safeParse(branch).success) {
        refused("BAD_REQUEST", `\`${branch}\` is not a branch name.`);
    }
    if (branch.startsWith("agent/")) {
        refused("BAD_REQUEST", `\`${branch}\` is an agent's own copy: look at it, or start from it, through that agent.`);
    }
    if ((await lockedBranchOf(main, git)) === branch) {
        refused("BAD_REQUEST", `\`${branch}\` is ${named(repo)}'s main line, which the shared workspace itself stands on.`);
    }
    return main;
};

// The local branch, made at origin's tip when only origin has it; non-destructive, an existing one is left as it is.
const localBranch = async (main: string, repo: string, branch: string, git: GitRunner): Promise<void> => {
    if (await verified(main, `refs/heads/${branch}`, git)) {
        return;
    }
    if (!(await verified(main, `refs/remotes/origin/${branch}`, git))) {
        refused("NOT_FOUND", `${repo === "root" ? "The workspace" : named(repo)} has no branch \`${branch}\`, here or on origin.`);
    }
    await git(main, ["branch", branch, `origin/${branch}`]);
};

// Which branch a checkout's HEAD names, off the file; undefined when there is no checkout or it is detached.
const attachedTo = async (dir: string): Promise<string | undefined> => {
    const gitDir = await gitDirOf(dir);
    const head = gitDir === undefined ? undefined : await readFile(join(gitDir, "HEAD"), "utf8").catch(undefinedIfMissing);
    return head?.match(/^ref:\s*refs\/heads\/(\S+)$/m)?.[1];
};

const tipOf = async (main: string, branch: string, git: GitRunner): Promise<string> => {
    const gitDir = await gitDirOf(main);
    const onDisk = gitDir === undefined ? undefined : await tipOnDisk(await commonDirOf(gitDir), branch);
    return onDisk ?? (await git(main, ["rev-parse", "--verify", `refs/heads/${branch}`])).stdout.trim();
};

// Under the repo's lock: the checkout standing and on its branch, added when it is not there yet.
const ensureHeld = async (held: Held, repo: string, branch: string): Promise<string> => {
    const { git } = held;
    const main = await admissible(held, repo, branch);
    const dir = held.checkoutDir(repo, branch);
    if ((await attachedTo(dir)) === branch) {
        return dir;
    }
    await localBranch(main, repo, branch, git);
    held.settledAt.delete(keyOf(repo, branch));
    if (await pathExists(join(dir, ".git"))) {
        // Standing, but no longer on its branch: it is the daemon's own, so it is simply put back.
        await git(dir, ["checkout", "-q", branch]);
        return dir;
    }
    // A folder a crash left without its `.git`, and an admin entry for a checkout no longer there, both go first.
    await rm(dir, { recursive: true, force: true });
    // allow(silent-catch): pruning stale admin entries is optional; the add below reports its own failure.
    await git(main, ["worktree", "prune"]).catch(() => undefined);
    await mkdir(held.viewRoot(repo, branch), { recursive: true });
    try {
        await git(main, ["worktree", "add", "-q", dir, branch]);
    } catch (error) {
        // Checked out somewhere else (an agent's copy that switched to it): git's own reason is the one to give.
        const said = error instanceof Error ? error.message.split("\n").find((line) => line.startsWith("fatal:")) : undefined;
        refused("PRECONDITION_FAILED", `\`${branch}\` could not be checked out for ${named(repo)}: ${said?.replace(/^fatal:\s*/, "") ?? "git refused"}`);
    }
    held.logger.info({ repo, branch }, "branches: checked out a branch the shared workspace is not on");
    return dir;
};

// Follow an external ref move with Git's two-tree merge, which refuses to overwrite overlapping local edits.
const settleHeld = async (held: Held, repo: string, branch: string): Promise<string> => {
    const { git } = held;
    const dir = await ensureHeld(held, repo, branch);
    const tip = await tipOf(held.mainDir(repo), branch, git);
    const key = keyOf(repo, branch);
    if (held.settledAt.get(key) === tip) {
        return dir;
    }
    const previous = held.settledAt.get(key);
    if (previous !== undefined && previous !== tip) {
        await git(dir, ["read-tree", "-m", "-u", previous, tip]);
    }
    held.settledAt.set(key, tip);
    return dir;
};

// Under the repo's lock: the checkout and its folder gone, the branch untouched.
const releaseHeld = async (held: Held, repo: string, branch: string): Promise<boolean> => {
    const { git } = held;
    const root = held.viewRoot(repo, branch);
    if (!(await pathExists(root))) {
        return false;
    }
    const main = held.mainDir(repo);
    const dir = held.checkoutDir(repo, branch);
    if (await pathExists(join(dir, ".git")) && (await git(dir, ["status", "--porcelain", "-uall"])).stdout.trim() !== "") {
        return false;
    }
    const repository = await pathExists(join(main, ".git"));
    if (repository) {
        // allow(silent-catch): a checkout git no longer knows is removed by the `rm` below, its admin entry by prune.
        await git(main, ["worktree", "remove", "--force", held.checkoutDir(repo, branch)]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
    if (repository) {
        // allow(silent-catch): pruning stale admin entries is optional; the next add prunes again.
        await git(main, ["worktree", "prune"]).catch(() => undefined);
    }
    held.settledAt.delete(keyOf(repo, branch));
    held.touchedAt.delete(keyOf(repo, branch));
    return true;
};

// Its folder's modified time is when it was last used, stamped at most once a minute.
const touch = (held: Held, repo: string, branch: string): void => {
    const key = keyOf(repo, branch);
    const now = Date.now();
    if (now - (held.touchedAt.get(key) ?? 0) < TOUCH_EVERY_MS) {
        return;
    }
    held.touchedAt.set(key, now);
    const at = new Date(now);
    // allow(silent-catch): a stamp that could not be written only lets the sweep judge it a little sooner.
    void utimes(held.viewRoot(repo, branch), at, at).catch(() => undefined);
};

const standingUnder = async (branchesRoot: string): Promise<RepoBranch[]> => {
    const found: RepoBranch[] = [];
    for (const repoDir of (await readdir(branchesRoot).catch(undefinedIfMissing)) ?? []) {
        for (const branchDir of (await readdir(join(branchesRoot, repoDir)).catch(undefinedIfMissing)) ?? []) {
            found.push({ repo: decodeURIComponent(repoDir), branch: decodeURIComponent(branchDir) });
        }
    }
    return found;
};

export const createBranchCheckouts = (deps: BranchCheckoutsDeps, git: GitRunner = defaultGit): BranchCheckouts => {
    const { worktrees } = deps;
    const branchesRoot = join(deps.historyRoot, "branches");
    const viewRoot = (repo: string, branch: string): string => join(branchesRoot, encodeURIComponent(repo), encodeURIComponent(branch));
    const checkoutDir = (repo: string, branch: string): string => (repo === "root" ? viewRoot(repo, branch) : join(viewRoot(repo, branch), repo));
    const held: Held = { mainDir: worktrees.mainDir, viewRoot, checkoutDir, logger: deps.logger, git, settledAt: new Map(), touchedAt: new Map() };
    const withLock = <T>(repo: string, task: () => Promise<T>): Promise<T> => worktrees.withRepoLock(repo, task);
    return {
        viewRoot,
        checkoutDir,
        ensure: async (repo, branch) => {
            touch(held, repo, branch);
            return withLock(repo, () => ensureHeld(held, repo, branch));
        },
        refresh: async (repo, branch) => {
            touch(held, repo, branch);
            // The ordinary read: on its branch, and the branch where it was last settled, for the cost of file reads.
            const dir = checkoutDir(repo, branch);
            const settled = held.settledAt.get(keyOf(repo, branch));
            // allow(silent-catch): a tip that cannot be read takes the locked, settling path below, which reports its own failure.
            const tip = settled === undefined ? undefined : await tipOf(worktrees.mainDir(repo), branch, git).catch(() => undefined);
            if (tip !== undefined && tip === settled && (await attachedTo(dir)) === branch) {
                return dir;
            }
            return withLock(repo, () => settleHeld(held, repo, branch));
        },
        release: (repo, branch) => withLock(repo, () => releaseHeld(held, repo, branch)),
        standing: () => standingUnder(branchesRoot),
        sweep: async (targeted, now = Date.now()) => {
            const released: RepoBranch[] = [];
            for (const { repo, branch } of await standingUnder(branchesRoot)) {
                const usedAt = (await stat(viewRoot(repo, branch)).catch(undefinedIfMissing))?.mtimeMs ?? 0;
                // Asked again under the lock, so a conversation started from the branch meanwhile keeps it.
                const kept = (): boolean => now - usedAt < BRANCH_CHECKOUT_IDLE_MS || targeted().some((target) => target.repo === repo && target.branch === branch);
                if (kept()) {
                    continue;
                }
                try {
                    if (await withLock(repo, async () => !kept() && (await releaseHeld(held, repo, branch)))) {
                        released.push({ repo, branch });
                    }
                } catch (error) {
                    deps.logger.warn({ err: error, repo, branch }, "branches: could not remove a branch checkout nobody uses");
                }
            }
            return released;
        },
    };
};

// Daily: the checkouts nobody lands onto or looked at for a week go (`sweep`); the branches stay.
export const branchCheckoutsChore = (deps: {
    readonly branchCheckouts: Pick<BranchCheckouts, "sweep">;
    readonly targeted: () => readonly RepoBranch[];
    readonly logger: Pick<Logger, "info">;
}): Chore => ({
    name: "branch-checkouts",
    everyMs: DAY_MS,
    run: async () => {
        const released = await deps.branchCheckouts.sweep(deps.targeted);
        if (released.length > 0) {
            deps.logger.info({ released }, "branches: removed checkouts of branches nobody lands onto or looked at for a week");
        }
    },
});
