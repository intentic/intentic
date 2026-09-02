import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { defaultGit, gitCommitAll, gitInit, type GitRunner } from "@intentic/scaffold";
import { repoGitDir, rootExcludes, syncRootExcludes } from "../history/history.js";
import { discoverRepos } from "../workspace/repo-discovery.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { commitIndex } from "./changes.js";
import { AGENT_GIT_AUTHOR } from "./git.js";

// The /work workspace repo ("root"): the ENTIRE workspace is under version control, not just the nested
// repositories, the Changes review commits/discards root files like any repo's. The git dir lives on
// /history (agent-tamper-proof, the nested repos' --separate-git-dir pattern); the in-worktree /work/.git is
// a pointer file this ensure (and history's healGitPointer) rewrites if the agent deletes it. Idempotent and
// boot-cheap: init happens once, the pointer + exclude list re-converge on every boot.

const exists = async (path: string): Promise<boolean> => {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
};

// Protected git-dir metadata, rather than a commit-message heuristic: only the daemon writes these keys and
// the container profile keeps the git dir outside /work. `fresh` is the narrow unborn window in which the boot
// seed runs; `baseline` names the exact commit the daemon created after boot convergence.
export const ROOT_FRESH_CONFIG = "intentic.fresh";
export const ROOT_BASELINE_CONFIG = "intentic.baseline";

// The index mode git gives a nested repository, the entry a repo dir becomes when it is staged instead of
// excluded. `ls-files --stage -z` prints "<mode> <sha> <stage>\t<path>", NUL-terminated and never quoted, so a
// path holding a space (or a newline) survives this parse intact.
const GITLINK_MODE = "160000 ";
const trackedGitlinks = async (root: string, git: GitRunner): Promise<string[]> =>
    (await git(root, ["ls-files", "--stage", "-z"])).stdout
        .split("\0")
        .filter((entry) => entry.startsWith(GITLINK_MODE))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));

/* A gitlink DECLARED in .gitmodules is a submodule, the user's own arrangement, never an accident this
 * convergence may undo. The container rarely sees one (repos arrive by clone, not by submodule add), but the
 * local profile serves the user's own repo where submodules are ordinary; dropping their entries would land a
 * daemon-authored commit deleting configuration nobody asked about. `git config -f` is the parser git itself
 * uses, so paths with spaces survive; no .gitmodules (the common case) is an empty set, not an error. */
const submodulePaths = async (root: string, git: GitRunner): Promise<Set<string>> => {
    const listing = await git(root, ["config", "-f", ".gitmodules", "-z", "--get-regexp", "^submodule\\..*\\.path$"]).catch(() => undefined);
    if (listing === undefined) {
        return new Set();
    }
    // -z entries are "<key>\n<value>", NUL-terminated.
    return new Set(
        listing.stdout
            .split("\0")
            .filter((entry) => entry.includes("\n"))
            .map((entry) => entry.slice(entry.indexOf("\n") + 1)),
    );
};

// The gitlinks the invariant actually forbids: tracked nested repos MINUS declared submodules.
const strayGitlinks = async (root: string, git: GitRunner): Promise<string[]> => {
    const gitlinks = await trackedGitlinks(root, git);
    if (gitlinks.length === 0) {
        return gitlinks;
    }
    const declared = await submodulePaths(root, git);
    return gitlinks.filter((path) => !declared.has(path));
};

/* ROOT TRACKS FILES, NEVER NESTED REPOSITORIES, the invariant behind the exclude list, enforced here in the
 * INDEX because the exclude list cannot enforce it.
 *
 * Every repo dir is excluded from root (history.ts rootExcludes) precisely so root never takes git's
 * embedded-repo handling. But an exclude rule is only ever consulted for an UNTRACKED path: the moment a repo
 * dir reaches root's index, a clone staged in the window before the derived list caught up with it, an agent's
 * own `git add -f`, the rules go inert for it forever. What the user sees from then on is a phantom `+1 -1` on
 * a one-line "file" with an empty diff, re-appearing in root's Changes review every time that repo's HEAD moves,
 * because a gitlink records the nested repo's HEAD sha and nothing inside root can make it stop.
 *
 * The entries are dropped from the index, the checkouts on disk are never touched, and the removal is
 * COMMITTED: left staged it would only trade the phantom modification for a phantom deletion of the whole repo,
 * one Discard away from checking an empty directory back out over a live checkout.
 *
 * The commit is built from HEAD's tree in a PRIVATE index (GIT_INDEX_FILE, the checkpoint snapshots' pattern),
 * never from the index the user stages into: a boot that swept someone's staged work into a daemon-authored
 * commit would be a worse bug than the one this fixes. The real index only ever sees the one removal at the end.
 *
 * Convergence, not a one-shot: it re-runs every boot, like the exclude sync above it and repo-git-dirs.ts, and
 * does nothing at all once root's index holds no gitlink, the steady state.
 */
const untrackNestedRepos = async (root: string, gitDir: string, git: GitRunner): Promise<void> => {
    const gitlinks = await strayGitlinks(root, git);
    if (gitlinks.length === 0) {
        return;
    }
    // `update-index --force-remove`, not `git rm --cached`: rm consults the worktree and refuses an entry whose
    // staged content matches neither the checkout nor HEAD, which is every one of these the moment the commit
    // below lands, since a live nested repo's HEAD has moved on and root's HEAD no longer names it at all. The
    // plumbing drops the index entry and nothing else; the repo on disk is never read, let alone touched.
    const drop = ["update-index", "--force-remove", "--", ...gitlinks];
    // Unborn HEAD (an init whose baseline never ran): the index entries are the whole of it, nothing to commit.
    const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD"])
        .then(({ stdout }) => stdout.trim())
        .catch(() => undefined);
    if (head === undefined) {
        await git(root, drop);
        return;
    }
    const index = join(gitDir, "untrack.index");
    const privateIndex = { GIT_INDEX_FILE: index };
    try {
        await git(root, ["read-tree", head], privateIndex);
        await git(root, drop, privateIndex);
        const tree = (await git(root, ["write-tree"], privateIndex)).stdout.trim();
        // Equal trees ⇒ the gitlinks were staged but never committed, so the index removal below is the whole
        // fix and an empty housekeeping commit would be noise in the user's history.
        if (tree !== (await git(root, ["rev-parse", "HEAD^{tree}"])).stdout.trim()) {
            const commit = (
                await git(root, [
                    "-c",
                    `user.name=${AGENT_GIT_AUTHOR.name}`,
                    "-c",
                    `user.email=${AGENT_GIT_AUTHOR.email}`,
                    "commit-tree",
                    tree,
                    "-p",
                    head,
                    "-m",
                    "chore: untrack nested repositories",
                ])
            ).stdout.trim();
            // Old-value guard: HEAD moved while this ran ⇒ leave it, the next boot converges again.
            await git(root, ["update-ref", "HEAD", commit, head]);
        }
    } finally {
        await rm(index, { force: true });
    }
    await git(root, drop);
};

/* THE SAME INVARIANT, IN A CONVERSATION'S OWN CHECKOUT, the last place it can still be broken.
 *
 * The turn-start sync, the land and the retire each preserve whatever an agent's worktree still holds as a
 * provenance commit on its branch (`add -A`, agents/sync.ts, land.ts, worktrees.ts). Root's exclude list is
 * derived from the repos discovered in the MAIN checkout, so it describes a conversation's tree only
 * approximately, a repo the agent cloned itself, one that appeared while the derived list was between syncs,
 * and `add -A` stages whatever the rules missed as a gitlink. The commit puts it on the branch, and from that
 * moment the path is TRACKED in this worktree's own index, where no later exclude rule reaches it again.
 *
 * What the user sees for that is every repo of the workspace listed as a one-line `+1` add in the agent's
 * review, back again after every land: untrackNestedRepos converges the main checkout at boot, but a
 * conversation's worktree has its own index and its own branch, and nothing converged those.
 *
 * So the enforcement runs between the staging and the commit, costing one `ls-files` on a worktree that is
 * clean. Dropping an entry that a previous turn already committed is a REMOVAL the commit then records, which
 * is what retires the phantom for good: added and removed inside the same branch, the review's anchor→tip
 * reading of it is no rows at all.
 *
 * A NESTED repo of the composition commits through plain gitCommitAll, a gitlink there is a submodule of the
 * USER's repo, and dropping it would land a deletion nobody asked for.
 */
export const commitWorktreeRemainder = async (repo: string, dir: string, message: string, git: GitRunner = defaultGit): Promise<boolean> => {
    if (repo !== "root") {
        return gitCommitAll(dir, message, AGENT_GIT_AUTHOR, git);
    }
    await git(dir, ["add", "-A"]);
    const gitlinks = await strayGitlinks(dir, git);
    if (gitlinks.length > 0) {
        await git(dir, ["update-index", "--force-remove", "--", ...gitlinks]);
    }
    // commitIndex rather than gitCommitAll's own tail: the index is already exactly what should go in, and it
    // is the only one of the two that can commit a removal the staging did not produce. Nothing to --no-verify
    // around, root's git dir is the daemon's, on /history, where the agent cannot install a hook.
    return commitIndex(dir, message, AGENT_GIT_AUTHOR, git);
};

// Returns true only when this boot freshly `gitInit`ed the repo, the caller then takes the baseline commit
// (commitRootBaseline) AFTER converging its /work-owned files, so those files land inside the baseline.
export const ensureRootRepo = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    git: GitRunner = defaultGit,
    definitionSeedEligible = true,
): Promise<boolean> => {
    const gitDir = repoGitDir(historyRoot, "root");
    const fresh = !(await exists(gitDir));
    if (fresh) {
        await gitInit(workspace.root, gitDir, git);
    } else if (!(await exists(join(workspace.root, ".git")))) {
        await writeFile(join(workspace.root, ".git"), `gitdir: ${gitDir}\n`);
    }
    // The same list as the shadow history's root scope, in $GIT_DIR/info/exclude, outside /work, so the
    // agent can't edit the rules. Derived from the discovered repo set and re-converged every boot (a daemon
    // update may change the list) and BEFORE the baseline commit, so it can never capture a repo's files,
    // credentials, or junk. History's snapshotAll keeps it current as repos appear/disappear at runtime.
    await syncRootExcludes(historyRoot, await discoverRepos(workspace.root));
    if (fresh) {
        // Repeat status scans over /work stay stat-cheap. Nothing is tracked yet, so nothing to untrack.
        await git(workspace.root, ["config", "core.untrackedCache", "true"]);
        if (definitionSeedEligible) {
            await git(workspace.root, ["config", ROOT_FRESH_CONFIG, "true"]);
        }
        return true;
    }
    await untrackNestedRepos(workspace.root, gitDir, git);
    return false;
};

/* The one write the local profile makes to a repo it did NOT create: keep the daemon's own furniture, the
 * state dir and the reference shelf, out of the user's `git status`. $GIT_DIR/info/exclude is git's own
 * place for local-only ignores: nothing in the working tree changes, nothing reaches their history, and the
 * write is append-only, a file the user also edits is grown by a marked block once, never rewritten (the
 * full-rewrite convergence syncRootExcludes does is for git dirs the daemon owns). `--git-common-dir` rather
 * than `.git` because the opened folder may itself be a worktree, where `.git` is a pointer file. */
const LOCAL_EXCLUDE_BLOCK = `# intentic: local workspace state, not project files\n/${STATE_DIR}/\n/${REFERENCE_DIR}/\n`;
const ensureLocalStateExcluded = async (root: string, git: GitRunner): Promise<void> => {
    const printed = (await git(root, ["rev-parse", "--git-common-dir"])).stdout.trim();
    const gitDir = isAbsolute(printed) ? printed : join(root, printed);
    const target = join(gitDir, "info", "exclude");
    const existing = await readFile(target, "utf8").catch(() => "");
    if (existing.includes(`/${STATE_DIR}/`)) {
        return;
    }
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(target, `${existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`}${LOCAL_EXCLUDE_BLOCK}`);
};

/* The LOCAL profile's root ensure, the workspace root is a folder the USER owns, usually their own repo.
 *
 * The container ensure above reshapes the root on sight: a separate git dir on /history, a pointer file in
 * the tree, the gitlink convergence. Every one of those moves is wrong on a repo somebody also uses outside
 * this daemon, `git init --separate-git-dir` would physically relocate their .git, and a daemon-authored
 * "untrack" commit is a mutation nobody asked for. So a root that IS already a repo is taken exactly as it
 * stands: no init, no pointer, no index surgery, no config writes. The daemon's features ride plain git,
 * worktrees, status, commits, which need none of the container shape.
 *
 * Only a folder that is NOT a repo gets one made: in-tree .git (the least-surprise shape on a user's
 * machine), the nested-repo excludes written before the caller's baseline commit can stage a discovered
 * repo's tree, and the untracked cache that keeps repeat status scans stat-cheap, ours to set because the
 * repo is ours to create. Returns true exactly when it made the repo, same contract as ensureRootRepo. */
export const ensureLocalRootRepo = async (
    workspace: WorkspacePaths,
    git: GitRunner = defaultGit,
    definitionSeedEligible = true,
): Promise<boolean> => {
    if (await exists(join(workspace.root, ".git"))) {
        await ensureLocalStateExcluded(workspace.root, git);
        return false;
    }
    await gitInit(workspace.root, undefined, git);
    // git init created .git/info; the excludes keep discovered nested repos out of the baseline's `add -A`.
    await writeFile(join(workspace.root, ".git", "info", "exclude"), `${rootExcludes(await discoverRepos(workspace.root)).join("\n")}\n`);
    await git(workspace.root, ["config", "core.untrackedCache", "true"]);
    if (definitionSeedEligible) {
        await git(workspace.root, ["config", ROOT_FRESH_CONFIG, "true"]);
    }
    return true;
};

// The baseline "Initialize workspace" commit, run once, on a fresh sandbox, AFTER the daemon has converged its
// /work-owned files (the approvals skill, baked-tool skills). Whatever exists becomes committed state so the
// Changes review starts clean and daemon-owned files don't surface as a phantom add. --allow-empty keeps HEAD
// born even on an empty workspace, no unborn-HEAD special case for root.
export const commitRootBaseline = async (workspace: WorkspacePaths, git: GitRunner = defaultGit): Promise<void> => {
    await git(workspace.root, ["add", "-A"]);
    await git(workspace.root, [
        "-c",
        `user.name=${AGENT_GIT_AUTHOR.name}`,
        "-c",
        `user.email=${AGENT_GIT_AUTHOR.email}`,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "Initialize workspace",
    ]);
    const fresh = (await git(workspace.root, ["config", "--get", ROOT_FRESH_CONFIG]).catch(() => undefined))?.stdout.trim() === "true";
    if (fresh) {
        const head = (await git(workspace.root, ["rev-parse", "HEAD"])).stdout.trim();
        await git(workspace.root, ["config", ROOT_BASELINE_CONFIG, head]);
    }
    await git(workspace.root, ["config", "--unset-all", ROOT_FRESH_CONFIG]).catch(() => undefined);
};
