import { defaultGit, type GitRunner } from "@intentic/base/git";
import { mainBranchOf } from "./agent-refs.js";
import { trackedDefaultBranchOf } from "./ops/publish-file.js";

// THE BRANCH EACH SHARED CHECKOUT STAYS ON. /work and every repo under it are the one tree every agent is cut from,
// synced onto and lands into (worktrees.ts composableHead, sync.ts, land.ts), for every person in the sandbox at once.
// Moving it to another branch would re-aim all of them, so it stays on its main line. Another branch is looked at in the
// Workspace (a per-person view, branch-checkouts.ts) or worked on by an agent started from it, never by switching here.
//
// The name is latched into the repo's own config the first time it is asked (`intentic.mainBranch`), so the daemon, the
// agent guard and the shell's `git` wrapper (bin/guard-shims/git) all read one answer, and a person who means another
// line sets it there. Resolved once: the branch `origin/HEAD` names when there is a local one, else `main`, else `master`,
// else the branch checked out now.

export const MAIN_BRANCH_CONFIG = "intentic.mainBranch";

const FALLBACKS = ["main", "master"] as const;

const configured = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    // allow(silent-catch): `config --get` exits 1 for a key nobody set, which is the answer "not latched yet".
    const read = await git(dir, ["config", "--get", MAIN_BRANCH_CONFIG]).catch(() => undefined);
    const name = read?.stdout.trim() ?? "";
    return name === "" ? undefined : name;
};

const localBranch = async (dir: string, name: string, git: GitRunner): Promise<boolean> =>
    // allow(silent-catch): `rev-parse -q --verify` exits 1 for a name that is not there, which is the answer.
    (await git(dir, ["rev-parse", "-q", "--verify", `refs/heads/${name}`]).catch(() => undefined)) !== undefined;

// HEAD's branch even on an unborn repo, which `rev-parse --abbrev-ref` cannot name.
const symbolicHead = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    // allow(silent-catch): a detached HEAD makes `symbolic-ref -q` exit 1, and a detached HEAD has no branch to name.
    const read = await git(dir, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => undefined);
    const name = read?.stdout.trim() ?? "";
    return name === "" ? undefined : name;
};

/** What the repo's main line would be, read without latching it. Undefined only for a detached repo with no branches. */
const resolveMainBranch = async (dir: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    const tracked = await trackedDefaultBranchOf(dir, "origin", git);
    if (tracked !== undefined && (await localBranch(dir, tracked, git))) {
        return tracked;
    }
    for (const name of FALLBACKS) {
        if (await localBranch(dir, name, git)) {
            return name;
        }
    }
    return symbolicHead(dir, git);
};

/**
 * The branch this shared checkout is locked to: the latched config, latched now when nothing is set yet. Undefined when
 * nothing names one (a detached repo with no branches), which locks nothing.
 */
export const lockedBranchOf = async (dir: string, git: GitRunner = defaultGit): Promise<string | undefined> => {
    const latched = await configured(dir, git);
    if (latched !== undefined) {
        return latched;
    }
    const resolved = await resolveMainBranch(dir, git);
    if (resolved !== undefined) {
        // allow(silent-catch): an unwritable config still answers this call, and the next one resolves the same way.
        await git(dir, ["config", MAIN_BRANCH_CONFIG, resolved]).catch(() => undefined);
    }
    return resolved;
};

/** Where one shared checkout stands against its main line: `current` undefined is a detached HEAD. */
export interface MainLineStanding {
    readonly locked: string | undefined;
    readonly current: string | undefined;
    readonly on: boolean;
}

export const mainLineStanding = async (dir: string, git: GitRunner = defaultGit): Promise<MainLineStanding> => {
    const locked = await lockedBranchOf(dir, git);
    // allow(silent-catch): an unborn HEAD fails `rev-parse`, and the symbolic read below still names its branch.
    const current = (await mainBranchOf(dir, git).catch(() => undefined)) ?? (await symbolicHead(dir, git));
    return { locked, current, on: locked === undefined || current === locked };
};

// The words every door that refuses a switch uses, so the route, the guard and the wrapper say one thing.
export const mainLineRefusal = (locked: string, target?: string): string =>
    `The shared workspace stays on \`${locked}\`, since every agent and every person here starts from it and lands into it. ${ 
    target === undefined
        ? "To work on another branch, start an agent from it; to look at one, pick it in the Workspace's view menu."
        : `To work on \`${target}\`, start an agent from it; to look at it, pick it in the Workspace's view menu.`}`;

// A land that would write into a shared checkout someone moved off its main line anyway: what it waits on, and the way
// back. Its own class, so a land failure reads it by type rather than by its wording (land-failure.ts).
export class OffMainLineError extends Error {
    constructor(
        readonly repo: string,
        readonly locked: string,
        readonly current: string | undefined,
    ) {
        super(
            `${repo === "root" ? "The workspace" : `\`${repo}\``} is on ${current === undefined ? "a bare commit" : `\`${current}\``}, not \`${locked}\`: ` +
                `this work waits until it is back on \`${locked}\` (the Changes view has the way back), so it never lands on the wrong branch.`,
        );
        this.name = "OffMainLineError";
    }
}

/** Whether a checkout to `ref` keeps the shared checkout on its main line: only the main line itself does. */
export const staysOnMainLine = (locked: string, ref: string): boolean => ref === locked || ref === `refs/heads/${locked}`;
