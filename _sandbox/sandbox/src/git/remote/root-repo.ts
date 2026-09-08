import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathExists } from "../../path-exists.js";
import { STATE_DIR } from "@intentic/constants";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { defaultGit, gitCommitAll, gitInit, gitStageAll, type GitRunner } from "@intentic/scaffold";
import { repoGitDir, rootExcludes, syncRootExcludes } from "../../history/history.js";
import { discoverRepos } from "../../workspace/layout/repo-discovery.js";
import type { WorkspacePaths } from "../../workspace/workspace.js";
import { commitIndex } from "../changes/changes-index.js";
import { AGENT_GIT_AUTHOR } from "../git.js";

// The whole /work workspace under version control, not just nested repos, so root files commit/discard like any repo's.
// Git dir lives on /history; the in-worktree `.git` is a pointer reconverged if deleted. Idempotent: init runs once;
// pointer and excludes reconverge every boot.

// Git-dir config keys only the daemon writes, kept outside /work. `fresh` marks the unborn window the boot seed runs
// in; `baseline` names the commit made after boot convergence.
export const ROOT_FRESH_CONFIG = "intentic.fresh";
export const ROOT_BASELINE_CONFIG = "intentic.baseline";

// Index mode for a nested repo staged as a gitlink. `ls-files --stage -z` prints `<mode> <sha> <stage>\t<path>`,
// NUL-terminated, so paths with spaces or newlines parse intact.
const GITLINK_MODE = "160000 ";
const trackedGitlinks = async (root: string, git: GitRunner): Promise<string[]> =>
    (await git(root, ["ls-files", "--stage", "-z"])).stdout
        .split("\0")
        .filter((entry) => entry.startsWith(GITLINK_MODE))
        .map((entry) => entry.slice(entry.indexOf("\t") + 1));

// A gitlink declared in .gitmodules is the user's own submodule, never dropped by this convergence. Uses `git config
// -f` (git's own parser, spaces survive); no .gitmodules is an empty set, not an error.
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

// Gitlinks the invariant forbids: tracked nested repos minus declared submodules.
const strayGitlinks = async (root: string, git: GitRunner): Promise<string[]> => {
    const gitlinks = await trackedGitlinks(root, git);
    if (gitlinks.length === 0) {
        return gitlinks;
    }
    const declared = await submodulePaths(root, git);
    return gitlinks.filter((path) => !declared.has(path));
};

// A gitlink that reached root's index (add -f, a race) is dropped and the removal committed via a private index built
// from HEAD, never touching the user's staged index. Re-runs every boot; no-op once root holds no gitlink.
const untrackNestedRepos = async (root: string, gitDir: string, git: GitRunner): Promise<void> => {
    const gitlinks = await strayGitlinks(root, git);
    if (gitlinks.length === 0) {
        return;
    }
    // `update-index --force-remove`, not `git rm --cached`, which refuses once the nested HEAD no longer matches.
    const drop = ["update-index", "--force-remove", "--", ...gitlinks];
    // Unborn HEAD: nothing to commit yet, the index removal is the whole fix.
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
        // Equal trees: the gitlinks were only staged, never committed; skip an empty housekeeping commit.
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
            // Old-value guard: if HEAD moved during this run, skip; next boot converges again.
            await git(root, ["update-ref", "HEAD", commit, head]);
        }
    } finally {
        await rm(index, { force: true });
    }
    await git(root, drop);
};

// Runs the same stray-gitlink drop inside a conversation's own worktree, between staging and commit, before it lands on
// the branch. Uses gitStageAll rather than `add -A`, since an unborn nested repo would otherwise abort the whole stage.
export const commitWorktreeRemainder = async (repo: string, dir: string, message: string, git: GitRunner = defaultGit): Promise<boolean> => {
    if (repo !== "root") {
        return gitCommitAll(dir, message, AGENT_GIT_AUTHOR, git);
    }
    await gitStageAll(dir, git);
    const gitlinks = await strayGitlinks(dir, git);
    if (gitlinks.length > 0) {
        await git(dir, ["update-index", "--force-remove", "--", ...gitlinks]);
    }
    // commitIndex: the index already holds the removal staging alone wouldn't commit.
    return commitIndex(dir, message, AGENT_GIT_AUTHOR, git);
};

// Returns true only when this boot freshly `gitInit`ed the repo; the caller then takes the baseline commit only after
// converging its own /work-owned files, so they land inside it.
export const ensureRootRepo = async (
    workspace: WorkspacePaths,
    historyRoot: string,
    git: GitRunner = defaultGit,
    definitionSeedEligible = true,
): Promise<boolean> => {
    const gitDir = repoGitDir(historyRoot, "root");
    const fresh = !(await pathExists(gitDir));
    if (fresh) {
        await gitInit(workspace.root, gitDir, git);
    } else if (!(await pathExists(join(workspace.root, ".git")))) {
        await writeFile(join(workspace.root, ".git"), `gitdir: ${gitDir}\n`);
    }
    // Exclude list lives in $GIT_DIR/info/exclude, outside /work, and is re-synced before every baseline commit.
    await syncRootExcludes(historyRoot, await discoverRepos(workspace.root));
    if (fresh) {
        // Keeps repeat status scans stat-cheap; nothing is tracked yet, so nothing to untrack.
        await git(workspace.root, ["config", "core.untrackedCache", "true"]);
        if (definitionSeedEligible) {
            await git(workspace.root, ["config", ROOT_FRESH_CONFIG, "true"]);
        }
        return true;
    }
    await untrackNestedRepos(workspace.root, gitDir, git);
    return false;
};

// Appends the daemon's state dir and reference shelf to $GIT_DIR/info/exclude (git's local-only ignores), grown once
// rather than rewritten. Uses `--git-common-dir`, not `.git`, since the folder may itself be a worktree.
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

// For a workspace the user owns: an existing repo is left exactly as it stands, no init, no pointer, no index surgery.
// Only a folder that is not yet a repo gets one, in-tree, with excludes written before the baseline commit.
export const ensureLocalRootRepo = async (
    workspace: WorkspacePaths,
    git: GitRunner = defaultGit,
    definitionSeedEligible = true,
): Promise<boolean> => {
    if (await pathExists(join(workspace.root, ".git"))) {
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

// One-time baseline commit, taken after the daemon converges its own /work-owned files so they don't surface as a
// phantom add. `--allow-empty` keeps HEAD born even on an empty workspace.
export const commitRootBaseline = async (workspace: WorkspacePaths, git: GitRunner = defaultGit): Promise<void> => {
    // gitStageAll here: an uncommitted `git init` on arrival would otherwise abort the baseline forever.
    await gitStageAll(workspace.root, git);
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
