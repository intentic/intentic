import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, type FileHandle, lstat, mkdir, open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { errnoCode } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { IGNORED_OUTPUTS_LISTED, type IgnoredOutput } from "@intentic/sandbox-contract";
import { REFERENCE_DIR } from "@intentic/workspace-ignore";
import { currentRepos } from "../../workspace/watch/repo-watch.js";
import { resolveRealWithin, resolveWithin } from "../../workspace/files/workspace-files-paths.js";
import { isByproductName } from "./scratch.js";

// What a conversation wrote into its copy that the repository's ignore rules exclude: the render in `out/`, the build in
// `dist/`. No land carries an ignored file and the scratch listing (`ls-files --exclude-standard`) cannot see one, so
// without this the deliverable a turn was asked for stayed in the copy, unseen.
//
// Whose file it is, read off the main tree rather than a record of the turn's writes: a copy is cut holding tracked
// files only, so every ignored file in it was written since, by the conversation or a tool it ran; the ones the owner
// already has as they are drop out by comparing with the same path in the main tree. The daemon keeps no durable
// record of a turn's writes that could stand in: the workspace watcher skips agent copies, and a turn's shell edits are
// read off git, which does not list ignored files either.

// Folders whose contents are never anybody's deliverable: installed dependencies and Python's bytecode cache, which a
// turn that ran a script leaves beside every module it imported.
const CACHE_DIRS = new Set(["node_modules", "__pycache__"]);
// Compiler caches written beside their sources, one per project a type check or an import touched.
const CACHE_EXTENSIONS = new Set([".pyc", ".tsbuildinfo"]);

// Files looked at per repository before the count stops: a build's output can run to tens of thousands, and the review
// reads this on every refresh.
const WALK_MAX = 5_000;
// Bytes read per listing telling a same-size file from main's: past it, such a file is listed, since copying one that
// was identical after all costs a write and missing a deliverable costs the owner a terminal.
const COMPARE_BUDGET = 256 * 1024 * 1024;
const COMPARE_CHUNK = 1024 * 1024;
// Files judged at once: each costs two lstats, and a few a read.
const JUDGE_BATCH = 32;

// Whether a repository-relative path can be an output at all: every segment a plain name (nothing hidden, nothing that
// climbs), outside every cache folder, and not a log, dump or cache file. Hidden files are config or secrets (`.env`),
// whose copy would replace the owner's own.
export const isOutputPath = (path: string): boolean => {
    const segments = path.split("/");
    const name = segments.at(-1) ?? "";
    return (
        segments.every((segment) => segment !== "" && !segment.startsWith(".") && !CACHE_DIRS.has(segment)) &&
        !isByproductName(name) &&
        !CACHE_EXTENSIONS.has(extname(name).toLowerCase())
    );
};

// Folders of the repository that belong to someone else: a repository nested inside it, and at the workspace's top the
// reference shelf, whose clones are reading material rather than work. Relative to the repository, each without a slash.
export const ignoredSkipOf = async (repo: string, workspaceRoot: string): Promise<string[]> => {
    const repos = await currentRepos(workspaceRoot);
    if (repo === "root") {
        return [...repos, REFERENCE_DIR];
    }
    return repos.filter((nested) => nested.startsWith(`${repo}/`)).map((nested) => nested.slice(repo.length + 1));
};

const skipped = (path: string, skip: readonly string[]): boolean => skip.some((folder) => path === folder || path.startsWith(`${folder}/`));

// The ignored rows of `git status --ignored=matching`: a folder an ignore rule names as one `dir/` row git does not
// descend into, and every other ignored file on its own, found inside new folders too. `ls-files --directory` drops an
// ignored file inside a new folder that also holds a file git would add, which is exactly where a render sits.
const ignoredRows = async (dir: string, git: GitRunner): Promise<string[]> => {
    const { stdout } = await git(dir, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--no-renames"]);
    return stdout
        .split("\0")
        .filter((record) => record.startsWith("!! "))
        .map((record) => Buffer.from(record.slice(3), "utf8").toString("utf8"));
};

// Every file under an ignored folder, outermost first, until `room` runs out; another checkout, a link and anything
// `isOutputPath` refuses are not entered. Everything in an ignored folder is ignored, so git need not be asked again.
const walkIgnored = async (dir: string, folder: string, skip: readonly string[], room: { left: number }): Promise<string[]> => {
    const found: string[] = [];
    const pending = [folder];
    while (pending.length > 0 && room.left > 0) {
        const current = pending.shift() ?? "";
        // allow(silent-catch): a folder gone or unreadable since git listed it holds nothing to offer.
        // oxlint-disable-next-line eslint/no-await-in-loop -- one folder at a time keeps the walk inside its ceiling
        const entries = await readdir(join(dir, current), { withFileTypes: true }).catch(() => []);
        if (entries.some((entry) => entry.name === ".git")) {
            continue;
        }
        for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
            const path = `${current}/${entry.name}`;
            if (room.left <= 0) {
                break;
            }
            if (!isOutputPath(path) || skipped(path, skip)) {
                continue;
            }
            if (entry.isDirectory()) {
                pending.push(path);
            } else if (entry.isFile()) {
                room.left -= 1;
                found.push(path);
            }
        }
    }
    return found;
};

// Every candidate file in the copy, sorted, before any is compared with main.
const candidatesOf = async (dir: string, skip: readonly string[], git: GitRunner): Promise<string[]> => {
    const room = { left: WALK_MAX };
    const paths: string[] = [];
    for (const row of await ignoredRows(dir, git)) {
        const path = row.replace(/\/$/, "");
        if (room.left <= 0) {
            break;
        }
        if (!isOutputPath(path) || skipped(path, skip)) {
            continue;
        }
        if (row.endsWith("/")) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- the ceiling is shared, so folders are walked in turn
            paths.push(...(await walkIgnored(dir, path, skip, room)));
        } else {
            room.left -= 1;
            paths.push(path);
        }
    }
    return paths.toSorted();
};

// Whether two open files of `size` bytes hold the same bytes, read side by side and stopped at the first difference.
const sameContent = async (left: FileHandle, right: FileHandle, size: number): Promise<boolean> => {
    const one = Buffer.alloc(Math.min(COMPARE_CHUNK, size));
    const other = Buffer.alloc(one.length);
    for (let offset = 0; offset < size; offset += one.length) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a chunk at a time, so a difference stops the read
        const [read, readOther] = await Promise.all([left.read(one, 0, one.length, offset), right.read(other, 0, other.length, offset)]);
        if (read.bytesRead !== readOther.bytesRead || !one.subarray(0, read.bytesRead).equals(other.subarray(0, readOther.bytesRead))) {
            return false;
        }
        if (read.bytesRead === 0) {
            break;
        }
    }
    return true;
};

// Whether files `a` and `b`, both `size` bytes, are the same, within what `budget` has left to read.
const sameBytes = async (a: string, b: string, size: number, budget: { left: number }): Promise<boolean> => {
    if (size > budget.left) {
        return false;
    }
    budget.left -= size;
    const left = await open(a, "r");
    try {
        const right = await open(b, "r");
        try {
            return await sameContent(left, right, size);
        } finally {
            await right.close();
        }
    } finally {
        await left.close();
    }
};

// What main holds at a path: nothing (`ENOENT`), the stats of what stands there, or undefined when it cannot be read or
// a file stands where a folder would have to go, which no copy could get past.
const mainEntry = async (path: string): Promise<Stats | "absent" | undefined> => {
    try {
        return await lstat(path);
    } catch (error) {
        return errnoCode(error) === "ENOENT" ? "absent" : undefined;
    }
};

// One file of the copy against the same path in main: the conversation's when main lacks it or holds other bytes there,
// `same` when main holds it as it is, undefined when it is no file of the copy's or main has a folder or a link there,
// which a file cannot be copied over without taking it away. Same size and modification time reads as the same file
// without opening either, which is how a copy made here reads afterwards.
const judge = async (dir: string, main: string, path: string, budget: { left: number }): Promise<IgnoredOutput | "same" | undefined> => {
    // allow(silent-catch): a file gone since it was listed is no file of the copy's, which is the answer.
    const own = await lstat(join(dir, path)).catch(() => undefined);
    if (own?.isFile() !== true) {
        return undefined;
    }
    const theirs = await mainEntry(join(main, path));
    if (theirs === "absent") {
        return { path, kind: "new", bytes: own.size };
    }
    if (theirs?.isFile() !== true) {
        return undefined;
    }
    if (theirs.size === own.size && Math.trunc(theirs.mtimeMs) === Math.trunc(own.mtimeMs)) {
        return "same";
    }
    // allow(silent-catch): a side that cannot be read is no proof the two are the same, so the file is listed.
    if (theirs.size === own.size && (await sameBytes(join(dir, path), join(main, path), own.size, budget).catch(() => false))) {
        return "same";
    }
    return { path, kind: "changed", bytes: own.size };
};

const isOutput = (verdict: IgnoredOutput | "same" | undefined): verdict is IgnoredOutput => typeof verdict === "object";

const judgeAll = async (dir: string, main: string, paths: readonly string[], budget: { left: number }): Promise<IgnoredOutput[]> => {
    const judged: IgnoredOutput[] = [];
    for (let at = 0; at < paths.length; at += JUDGE_BATCH) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- batched, so a listing of thousands never opens them all at once
        const batch = await Promise.all(paths.slice(at, at + JUDGE_BATCH).map((path) => judge(dir, main, path, budget)));
        judged.push(...batch.filter(isOutput));
    }
    return judged;
};

export interface IgnoredOutputs {
    // Sorted by path, at most IGNORED_OUTPUTS_LISTED.
    readonly paths: IgnoredOutput[];
    // How many more there are past those, a floor when the walk stopped at its ceiling; 0 when every one is listed.
    readonly more: number;
}

// What a copy that is gone, or wrote nothing ignored, has to offer.
export const NO_IGNORED_OUTPUTS: IgnoredOutputs = { paths: [], more: 0 };

// The ignored files the copy at `dir` holds that `main`, the same repository's main tree, lacks or holds differently.
// `skip` names folders that are another repository's (ignoredSkipOf).
export const ignoredOutputsOf = async (dir: string, main: string, skip: readonly string[], git: GitRunner = defaultGit): Promise<IgnoredOutputs> => {
    const paths = await candidatesOf(dir, skip, git);
    const judged = await judgeAll(dir, main, paths, { left: COMPARE_BUDGET });
    return { paths: judged.slice(0, IGNORED_OUTPUTS_LISTED), more: Math.max(0, judged.length - IGNORED_OUTPUTS_LISTED) };
};

// A named path where it really is on both sides, refused when it leaves either repository: lexically (`..`, an
// absolute path), through a link in the copy (a listed path never crosses one, since the walk enters none), or through
// a link in main that leads out.
const contained = async (dir: string, main: string, path: string): Promise<boolean> => {
    if (resolveWithin(dir, path) === undefined || resolveWithin(main, path) === undefined) {
        return false;
    }
    const [own, theirs] = await Promise.all([resolveRealWithin(dir, path), resolveRealWithin(main, path)]);
    return own !== undefined && own.realRel.split("\\").join("/") === path && theirs !== undefined;
};

export interface NamedOutputs {
    // Paths that leave the repository on either side.
    readonly outside: string[];
    // Paths inside it that are not an ignored file of the conversation's that main lacks or holds differently.
    readonly not: string[];
    // The rest, each as the listing would show it.
    readonly named: IgnoredOutput[];
    // Ignored files of the conversation's that main already holds byte for byte: nothing to copy.
    readonly same: string[];
}

// Each named path judged as the listing judges it, path by path, so a file past the listing's ceilings can still be
// named and a stale list cannot reach a file that is not an ignored output now.
export const namedIgnoredOutputs = async (
    dir: string,
    main: string,
    paths: readonly string[],
    skip: readonly string[],
    git: GitRunner = defaultGit,
): Promise<NamedOutputs> => {
    const result: NamedOutputs = { outside: [], not: [], named: [], same: [] };
    const inside: string[] = [];
    for (const path of new Set(paths)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of paths, each resolved through its links
        if (!(await contained(dir, main, path))) {
            result.outside.push(path);
        } else if (!isOutputPath(path) || skipped(path, skip)) {
            result.not.push(path);
        } else {
            inside.push(path);
        }
    }
    if (inside.length === 0) {
        return result;
    }
    // The runner reads every name after `--` literally, so a name holding `*` or `[` is that file, not a pattern.
    const { stdout } = await git(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...inside]);
    const ignored = new Set(stdout.split("\0").filter((path) => path !== ""));
    // No budget: a press names its files, and each is compared in full rather than guessed at.
    const budget = { left: Number.POSITIVE_INFINITY };
    for (let at = 0; at < inside.length; at += JUDGE_BATCH) {
        const batch = inside.slice(at, at + JUDGE_BATCH);
        // oxlint-disable-next-line eslint/no-await-in-loop -- batched, so a press of a thousand never opens them all at once
        const verdicts = await Promise.all(batch.map(async (path) => (ignored.has(path) ? await judge(dir, main, path, budget) : undefined)));
        for (const [index, path] of batch.entries()) {
            const verdict = verdicts[index];
            if (verdict === "same") {
                result.same.push(path);
            } else if (verdict === undefined) {
                result.not.push(path);
            } else {
                result.named.push(verdict);
            }
        }
    }
    return result;
};

// One file into place: through a hidden sibling renamed over the target, so nobody reading the main tree meets half a
// render, and with the source's times, so the listing then reads the two as the same file.
const copyOne = async (from: string, to: string): Promise<void> => {
    const temporary = join(dirname(to), `.${basename(to)}.${randomUUID()}.copying`);
    await mkdir(dirname(to), { recursive: true });
    try {
        await copyFile(from, temporary, constants.COPYFILE_FICLONE);
        const { atime, mtime } = await stat(from);
        await utimes(temporary, atime, mtime);
        await rename(temporary, to);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
};

// Copies each output to the same path in `main`, making the folders it needs and replacing a file already there. Never
// through git: an ignored file stays out of the index.
export const copyIntoMain = async (dir: string, main: string, outputs: readonly IgnoredOutput[]): Promise<void> => {
    for (const output of outputs) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time; a render can be hundreds of megabytes
        await copyOne(join(dir, output.path), join(main, output.path));
    }
};
