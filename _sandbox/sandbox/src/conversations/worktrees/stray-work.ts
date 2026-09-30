import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { z } from "zod";
import { AGENT_GIT_AUTHOR } from "../../git-identity.js";
import { gitFailureReason, identity } from "../../git/git.js";
import { headSha } from "../../git/changes/changes.js";
import { branchSha, carriedRef } from "../land/agent-refs.js";
import { opt } from "../../opt.js";
import type { AgentWorktrees } from "./worktrees.js";

// WORK A TURN LEFT ON A BRANCH OF ITS OWN, carried back onto `agent/<id>`. A conversation may stand its copy on another
// branch: a CI branch to push, a pull request its owner asked it to work on. Review and land read `agent/<id>` only, so
// until now whatever it committed there was stranded, reported on the review and never landed. At the end of every turn
// the commits the turn made on that other branch are replayed onto `agent/<id>` (ref-only: no checkout moves, and the
// copy stays exactly where the agent put it), so its own branch carries them and Land takes them like any other work.
//
// "The turn made" is decided by the refs as the turn opened: a commit reachable from none of the tips every local
// branch and remote-tracking ref named then, nor from the main checkout's HEAD now, nor already on `agent/<id>`, is one
// this turn wrote. That keeps out what the other branch held before (origin/main's commits under a branch cut from it,
// a pull request's own history), which is not this conversation's to land. Commits only: uncommitted edits on the other
// branch stay there, and the review says so.
//
// A marker ref, `refs/intentic/carried/<id>` (agent-refs.ts `carriedRef`), records the copy's HEAD as of the last carry
// that went through: what the review reads to tell carried work from stranded work, and a second floor for the next
// carry, so a turn that opens on the other branch never re-offers what an earlier one carried.

// Every tip a local branch or remote-tracking ref names in each repository, as a turn opens: the floor below which
// nothing is this turn's own. Undefined for a repository that could not be read, which then carries nothing.
export type RefSnapshot = ReadonlyMap<string, readonly string[]>;

export const snapshotRefs = async (worktrees: AgentWorktrees, repos: readonly { readonly repo: string }[], git: GitRunner = defaultGit): Promise<RefSnapshot> => {
    const read = await Promise.all(
        repos.map(async ({ repo }): Promise<[string, string[]] | undefined> => {
            try {
                const { stdout } = await git(worktrees.mainDir(repo), ["for-each-ref", "--format=%(objectname)", "refs/heads", "refs/remotes"]);
                return [repo, [...new Set(stdout.split("\n").filter((line) => line !== ""))]];
            } catch {
                // allow(silent-catch): an unreadable repository has no floor, and a carry with no floor carries nothing.
                return undefined;
            }
        }),
    );
    return new Map(read.filter((entry) => entry !== undefined));
};

// What one repository's carry did: how many commits reached `agent/<id>`, or why none did.
export interface StrayCarry {
    readonly repo: string;
    // The branch the copy stands on; absent for a detached HEAD.
    readonly branch?: string;
    readonly carried: number;
    // Why nothing moved: a commit that does not replay onto `agent/<id>`, or a repository git could not read.
    readonly refused?: string;
}

// What a ref names, undefined when it names nothing.
const shaOrUndefined = async (dir: string, name: string, git: GitRunner): Promise<string | undefined> => {
    try {
        return (await git(dir, ["rev-parse", "-q", "--verify", `${name}^{commit}`])).stdout.trim();
    } catch {
        // allow(silent-catch): `--verify -q` exits 1 for a name that resolves to nothing, which is the answer asked for.
        return undefined;
    }
};

// The copy's commits `agent/<id>` does not hold yet, oldest first: right of the symmetric range so a commit already
// carried under the same patch drops out, merges left out since what they bring is another line's, and everything
// reachable from `floor` excluded.
const strayCommits = async (worktree: string, own: string, floor: readonly string[], git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(worktree, ["rev-list", "--reverse", "--no-merges", "--cherry-pick", "--right-only", `${own}...HEAD`, "--not", ...floor]);
    return stdout.split("\n").filter((line) => line !== "");
};

// What a refused `merge-tree` hands back: exit 1 with the tree and the conflicted paths on stdout is a conflict.
const MergeRefusalSchema = z.object({ code: z.literal(1), stdout: z.string() });

// One commit's change replayed onto `onto`, three-way against its own parent: the tree, or the paths that clash.
// Any failure other than a conflict propagates.
const replayedTree = async (dir: string, commit: string, onto: string, git: GitRunner): Promise<{ tree: string } | { conflicted: string[] }> => {
    try {
        const { stdout } = await git(dir, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${commit}^`, onto, commit]);
        return { tree: stdout.split("\n")[0]?.trim() ?? "" };
    } catch (cause) {
        const failure = MergeRefusalSchema.safeParse(cause);
        if (!failure.success) {
            throw cause;
        }
        const paths = failure.data.stdout
            .split("\n")
            .slice(1)
            .map((line) => line.trim())
            .filter((line) => line !== "");
        return { conflicted: [...new Set(paths)] };
    }
};

// A commit on `parent` with `tree`, keeping the original's author, date and message; the daemon commits it.
const recommit = async (dir: string, original: string, tree: string, parent: string, git: GitRunner): Promise<string> => {
    const { stdout } = await git(dir, ["log", "-1", "--format=%an%x00%ae%x00%aI%x00%B", original]);
    const [name = "", email = "", date = "", ...body] = stdout.split("\0");
    const message = body.join("\0").trimEnd();
    const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date };
    return (await git(dir, [...identity(AGENT_GIT_AUTHOR), "commit-tree", tree, "-p", parent, "-m", message === "" ? "Agent" : message], env)).stdout.trim();
};

const treeOf = async (dir: string, commit: string, git: GitRunner): Promise<string> => (await git(dir, ["rev-parse", `${commit}^{tree}`])).stdout.trim();

const carryRepo = async (worktrees: AgentWorktrees, id: string, repo: string, branch: string | undefined, floor: readonly string[], git: GitRunner): Promise<StrayCarry> => {
    const at = { repo, ...opt("branch", branch) };
    const main = worktrees.mainDir(repo);
    const worktree = worktrees.worktreeDir(id, repo);
    const own = `agent/${id}`;
    const head = await headSha(worktree, git);
    const start = await branchSha(main, own, git);
    if (head === undefined || start === undefined) {
        return { ...at, carried: 0, refused: head === undefined ? "its copy has no commit to read" : `${own} is gone` };
    }
    const mainHead = await headSha(main, git);
    const marker = await shaOrUndefined(main, carriedRef(id), git);
    const excluded = [...floor, ...(mainHead === undefined ? [] : [mainHead]), ...(marker === undefined ? [] : [marker])];
    let tip = start;
    let carried = 0;
    for (const commit of await strayCommits(worktree, own, excluded, git)) {
        const replayed = await replayedTree(main, commit, tip, git);
        if ("conflicted" in replayed) {
            // Nothing written yet: the new commits are loose objects until the ref moves, which it now never does.
            const short = commit.slice(0, 9);
            return { ...at, carried: 0, refused: `${short} does not apply onto ${own}: ${replayed.conflicted.join(", ") || "conflict"}` };
        }
        // A change `agent/<id>` already holds, carried by an earlier turn or made on both branches alike.
        if (replayed.tree === (await treeOf(main, tip, git))) {
            continue;
        }
        tip = await recommit(main, commit, replayed.tree, tip, git);
        carried += 1;
    }
    if (tip !== start) {
        // Against `start`: a land that moved the branch meanwhile makes this refuse rather than drop what it wrote.
        await git(main, ["update-ref", "-m", `carry from ${branch ?? "a detached HEAD"}`, `refs/heads/${own}`, tip, start]);
    }
    await git(main, ["update-ref", carriedRef(id), head]);
    return { ...at, carried };
};

// Carries what this turn committed on each repository whose copy stands off `agent/<id>`, under that repository's lock.
// Never throws: a repository that refuses keeps its work where it is, which is what the review then says.
export const carryStrayWork = async (
    worktrees: AgentWorktrees,
    id: string,
    repos: readonly { readonly repo: string }[],
    snapshot: RefSnapshot,
    git: GitRunner = defaultGit,
): Promise<StrayCarry[]> => {
    const carries: StrayCarry[] = [];
    for (const { repo, branch } of await worktrees.elsewhere(id, repos)) {
        const floor = snapshot.get(repo);
        if (floor === undefined) {
            carries.push({ repo, ...opt("branch", branch), carried: 0, refused: "no record of its refs as the turn opened" });
            continue;
        }
        try {
            carries.push(await worktrees.withRepoLock(repo, () => carryRepo(worktrees, id, repo, branch, floor, git)));
        } catch (error) {
            carries.push({ repo, ...opt("branch", branch), carried: 0, refused: gitFailureReason(error, "git could not carry it") });
        }
    }
    return carries;
};

// A copy standing off `agent/<id>`, as the review and the fleet's invariant read it: whether what it committed there is
// carried (the last carry left HEAD exactly here), and whether it holds uncommitted edits to tracked files, which no carry
// takes. Untracked files are left out: a copy's scratch lives there, and the review lists that on its own.
export interface StrayStanding {
    readonly repo: string;
    readonly branch?: string;
    readonly carried: boolean;
    readonly uncommitted: boolean;
}

export const strayStandings = async (
    worktrees: AgentWorktrees,
    id: string,
    repos: readonly { readonly repo: string }[],
    git: GitRunner = defaultGit,
): Promise<StrayStanding[]> =>
    Promise.all(
        (await worktrees.elsewhere(id, repos)).map(async ({ repo, branch }) => {
            const worktree = worktrees.worktreeDir(id, repo);
            const [head, marker, status] = await Promise.all([
                // allow(silent-catch): a worktree with no readable HEAD has nothing carried, which is what undefined reports.
                headSha(worktree, git).catch(() => undefined),
                shaOrUndefined(worktrees.mainDir(repo), carriedRef(id), git),
                git(worktree, ["status", "--porcelain", "--untracked-files=no"]).catch(() => ({ stdout: "" })),
            ]);
            return {
                repo,
                ...opt("branch", branch),
                carried: head !== undefined && head === marker,
                uncommitted: status.stdout.trim() !== "",
            };
        }),
    );
