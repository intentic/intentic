import { lstat, mkdtemp, rm, rmdir } from "node:fs/promises";
import { pathExists } from "@intentic/base/fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ScratchPath } from "@intentic/sandbox-contract/schemas/git/git";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { EMPTY_TREE } from "../../workspace/layout/git-layout.js";
import { changedFiles, headSha } from "./changes.js";
import { withScratchExcluded } from "./scratch.js";
import { identity } from "../git.js";

// Index moves of the Changes panel: stage, unstage, commit staged, discard; these write to the repo, unlike changes.ts.
// Each takes an injectable GitRunner (defaultGit shells out), unit-testable without a real repo.

// Argv is bounded by the OS (ARG_MAX); paths are chunked to stay well under it rather than truncating the list.
const ARGV_BUDGET_BYTES = 96 * 1024;

// Splits a path list into runs that fit the budget; an over-budget path still gets its own call, never dropped.
export const chunkPaths = (paths: readonly string[]): readonly (readonly string[])[] => {
    const chunks: string[][] = [];
    let current: string[] = [];
    let used = 0;
    for (const path of paths) {
        const cost = Buffer.byteLength(path, "utf8") + 1;
        if (current.length > 0 && used + cost > ARGV_BUDGET_BYTES) {
            chunks.push(current);
            current = [];
            used = 0;
        }
        current.push(path);
        used += cost;
    }
    if (current.length > 0) {
        chunks.push(current);
    }
    return chunks;
};

// Runs one git command per chunk, sequentially: concurrent writers would race for `index.lock`.
// `env` names a private index (GIT_INDEX_FILE) where the caller stages into one instead of the repo's own.
type IndexEnv = Readonly<Record<string, string>> | undefined;
const overPaths = async (dir: string, paths: readonly string[], argsFor: (chunk: readonly string[]) => string[], git: GitRunner, env?: IndexEnv): Promise<void> => {
    for (const chunk of chunkPaths(paths)) {
        await git(dir, argsFor(chunk), env);
    }
};

// Whether a folder above `path` is now a symbolic link, as `.claude/skills` became when one link replaced its per-skill
// links (store/skills/claude-skills.ts). Git counts what it tracked under there as deleted, yet `add` refuses the path
// outright ("beyond a symbolic link"). Each folder is looked up once across the whole list.
const beyondSymlink = async (dir: string, path: string, seen: Map<string, Promise<boolean>>): Promise<boolean> => {
    const parts = path.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        let linked = seen.get(folder);
        if (linked === undefined) {
            linked = lstat(join(dir, folder)).then(
                (stats) => stats.isSymbolicLink(),
                // allow(silent-catch): a folder that is gone has no link in it.
                () => false,
            );
            seen.set(folder, linked);
        }
        if (await linked) {
            return true;
        }
    }
    return false;
};

// Stages exactly `paths`: adds, edits, and deletions (`-A` covers a removal, which a bare `add` skips). A path beyond a
// symbolic link can only be a removal, which leaves the index through `rm --cached`, the one verb that takes it.
export const stagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit, env?: IndexEnv): Promise<void> => {
    const seen = new Map<string, Promise<boolean>>();
    const beyond = new Set<string>();
    for (const path of paths) {
        if (await beyondSymlink(dir, path, seen)) {
            beyond.add(path);
        }
    }
    const reachable = beyond.size === 0 ? paths : paths.filter((path) => !beyond.has(path));
    await overPaths(dir, reachable, (chunk) => ["add", "-A", "--", ...chunk], git, env);
    await overPaths(dir, [...beyond], (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk], git, env);
    for (const chunk of chunkPaths(reachable)) {
        await recordGainedExecutableBits(dir, ["--", ...chunk], git, env);
    }
};

// Stages the whole repo but `scratch` in one spawn, with no ceiling to chunk under; what a whole-repo commit resolves to.
// - --ignore-errors: one unreadable file doesn't abandon the rest (an agent may be writing while you stage).
// - advice.addEmbeddedRepo=false: a nested repo is scanned here, not warned about as a gitlink.
export const stageAll = async (dir: string, scratch: readonly ScratchPath[] = [], git: GitRunner = defaultGit): Promise<void> => {
    try {
        await withScratchExcluded(scratch, (pathspecArgs) => git(dir, ["-c", "advice.addEmbeddedRepo=false", "add", "-A", "--ignore-errors", ...pathspecArgs]));
    } finally {
        // Unscoped: the diff reads only the index, which scratch, being untracked and unstaged, is never in. Run even
        // where `add` reported a file it could not read: everything else it staged still owes its bits.
        await recordGainedExecutableBits(dir, [], git);
    }
};

// The daemon reads modes with core.fileMode=false (GIT_GLOBAL_ARGS), so a bit an upload or a Windows sync stripped is
// never an edit. Under that setting git also stages every NEW file as 100644 whatever its disk mode, so a script made
// executable here reached every other checkout (a conversation's worktree, a clone, CI) as "permission denied". After
// staging, a file executable on disk that the index holds as 100644 is recorded 100755: a bit gained is kept, a bit lost
// still is not. `--raw` against the worktree under core.fileMode=true names exactly those, from the index's stat cache.
const recordGainedExecutableBits = async (dir: string, pathspecArgs: readonly string[], git: GitRunner, env?: IndexEnv): Promise<void> => {
    const { stdout } = await git(dir, ["-c", "core.fileMode=true", "diff", "--raw", "-z", "--no-renames", "--no-abbrev", ...pathspecArgs], env);
    const gained = gainedExecutablePaths(stdout);
    await overPaths(dir, gained, (chunk) => ["update-index", "--chmod=+x", "--", ...chunk], git, env);
};

// Every tracked file the index holds as 100644 that is executable on disk: what a repair records +x (exec-bit-repair.ts).
export const executableOnDiskPaths = async (dir: string, git: GitRunner = defaultGit): Promise<readonly string[]> => {
    const { stdout } = await git(dir, ["-c", "core.fileMode=true", "diff", "--raw", "-z", "--no-renames", "--no-abbrev"]);
    return gainedExecutablePaths(stdout);
};

// Records +x in the index for `paths`, nothing else: the repair's write, an ordinary staged mode change.
export const markExecutable = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    await overPaths(dir, paths, (chunk) => ["update-index", "--chmod=+x", "--", ...chunk], git);
};

// `diff --raw -z` rows: `:<src mode> <dst mode> <src sha> <dst sha> <status>` NUL `<path>` NUL (no renames asked for).
const gainedExecutablePaths = (raw: string): readonly string[] => {
    const fields = raw.split("\0");
    const paths: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
        const [src, dst] = fields[i]!.slice(1).split(" ");
        if (src === "100644" && dst === "100755") {
            paths.push(fields[i + 1]!);
        }
    }
    return paths;
};

// Unstages exactly `paths`, worktree untouched; on an unborn HEAD the entry is dropped instead (`rm --cached`).
// Path-limited even for the whole index: a bare `git reset` clears MERGE_HEAD, abandoning a mid-merge or rebase.
export const unstagePaths = async (dir: string, paths: readonly string[], git: GitRunner = defaultGit): Promise<void> => {
    if (paths.length === 0) {
        return;
    }
    const head = await headSha(dir, git);
    await overPaths(
        dir,
        paths,
        head !== undefined
            ? (chunk) => ["reset", "-q", "--", ...chunk]
            : (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk],
        git,
    );
};

// Commits whatever is staged, touching nothing else; the only way the panel records a commit.
// False means the index is already clean; a whole-index commit also works mid-merge, unlike `commit --only`.
// `--no-textconv`/`--no-ext-diff` on the emptiness check: this image reads every binary extension through fileq, and
// two different documents whose readings match would otherwise answer "nothing changed" and go uncommitted.
// `hooks: "skip"` is for a capture: provenance, not authorship, so a repo's commit hooks must not refuse it.
export const commitIndex = async (
    dir: string,
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
    hooks: "run" | "skip" = "run",
): Promise<boolean> => {
    const head = await headSha(dir, git);
    try {
        await git(dir, ["diff", "--cached", "--quiet", "--no-textconv", "--no-ext-diff", head ?? EMPTY_TREE]);
        return false;
    } catch {
        // The index differs from HEAD, fall through to commit.
    }
    await git(dir, [...identity(author), "commit", "-q", ...(hooks === "skip" ? ["--no-verify"] : []), "-m", message]);
    return true;
};

// Commits the working-tree state of exactly `paths` (adds, edits, deletions), disregarding whatever else is staged and
// leaving that staging as it was. The paths are staged in the repo's own index (the panel reads them clean afterwards)
// and, the commit's own copy, in a private index read from HEAD, which is committed whole; false when they already
// match HEAD. Never `commit --only`: it re-reads the paths from disk under core.fileMode=false, so a script the staging
// had just recorded +x was committed 100644, and every checkout cut from that commit ran it as "Permission denied"
// (2026-11, 30 conversations on one sandbox). A partial commit during a merge is refused, as `--only` refused it.
export const commitOnly = async (
    dir: string,
    paths: readonly string[],
    message: string,
    author: { readonly name: string; readonly email: string },
    git: GitRunner = defaultGit,
): Promise<boolean> => {
    if (paths.length === 0) {
        return false;
    }
    await stagePaths(dir, paths, git);
    const gitDir = (await git(dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    if (await pathExists(join(gitDir, "MERGE_HEAD"))) {
        throw new Error("fatal: cannot do a partial commit during a merge.");
    }
    const head = await headSha(dir, git);
    const scratch = await mkdtemp(join(tmpdir(), "intentic-commit-only-"));
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
        await git(dir, head === undefined ? ["read-tree", "--empty"] : ["read-tree", head], env);
        await stagePaths(dir, paths, git, env);
        try {
            await git(dir, ["diff", "--cached", "--quiet", "--no-textconv", "--no-ext-diff", head ?? EMPTY_TREE], env);
            return false;
            // allow(silent-catch): `diff --quiet` exits 1 exactly when the private index differs from HEAD, the answer.
        } catch {
            // The private index differs from HEAD: commit it.
        }
        await git(dir, [...identity(author), "commit", "-q", "-m", message], env);
        return true;
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
};

// Discards uncommitted work: everything, or exactly `paths`; tracked content returns to HEAD, untracked is deleted.
// Ignored files always survive (no -x); the doubled -f also removes an embedded repo a single -f would skip.
export const discardPaths = async (dir: string, paths: readonly string[] | undefined, git: GitRunner = defaultGit): Promise<void> => {
    const head = await headSha(dir, git);
    if (paths === undefined) {
        if (head !== undefined) {
            await git(dir, ["reset", "-q", "--hard"]);
        } else {
            await git(dir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "."]);
        }
        await git(dir, ["clean", "-q", "-f", "-f", "-d"]);
        return;
    }
    // A staged rename spans two paths; discarding either leg must undo both, so `from` is read off the staged side.
    const { staged } = await changedFiles(dir, git);
    const targets = new Set<string>(paths);
    for (const change of staged) {
        if (change.from !== undefined && targets.has(change.path)) {
            targets.add(change.from);
        }
    }
    const list = [...targets];
    if (list.length === 0) {
        return;
    }
    // Unstages targets first so the re-scan sees plain worktree-vs-HEAD states (a rename decomposes into two).
    await overPaths(
        dir,
        list,
        head !== undefined
            ? (chunk) => ["reset", "-q", "--", ...chunk]
            : (chunk) => ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...chunk],
        git,
    );
    // Targets are now on the unstaged side; "added" means untracked (delete), anything else tracked (restore).
    const after = (await changedFiles(dir, git)).unstaged.filter((change) => targets.has(change.path));
    const tracked = after.filter((change) => change.status !== "added").map((change) => change.path);
    const untracked = after.filter((change) => change.status === "added").map((change) => change.path);
    await overPaths(dir, tracked, (chunk) => ["checkout", "-q", "-f", "HEAD", "--", ...chunk], git);
    await overPaths(dir, untracked, (chunk) => ["clean", "-q", "-f", "-f", "-d", "--", ...chunk], git);
    // A path-scoped clean deletes files and leaves the directories they emptied, which git then cannot see at all.
    await pruneEmptiedDirs(dir, untracked);
};

// Git tracks no directories, so a removal's emptied parents are debris nothing else would ever report. Scoped to
// `removed`'s own parents, bottom up, stopping at the first that still holds anything and at `root` itself.
export const pruneEmptiedDirs = async (root: string, removed: readonly string[]): Promise<void> => {
    const top = resolve(root);
    for (const path of removed) {
        for (let dir = dirname(resolve(top, path)); dir !== top && dir.startsWith(top); dir = dirname(dir)) {
            try {
                await rmdir(dir);
            } catch {
                break;
            }
        }
    }
};
