import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { exitCodeOf, stdoutOf } from "@intentic/base/errors";
import type { GitRunner } from "@intentic/base/git";
import { headSha } from "../../../git/changes/changes.js";
import { chunkPaths } from "../../../git/changes/changes-index.js";
import { identity } from "../../../git/git.js";
import { AGENT_GIT_AUTHOR } from "../../../git-identity.js";
import { writePatch } from "./land-patch.js";
import { UNDERIVED } from "../rederive.js";

// THE THREE-WAY WRITE A `merge` LAND MAKES (2026-10-20). A `merge` land brings a branch's work into a tree that holds
// edits of its own and leaves conflict markers where the two clash. It used to be `git apply --3way`, whose non-zero exit
// was taken to mean "markers were left": but `--3way` goes through the index and is atomic, so a file the tree had
// renamed or deleted since the branch was cut (`does not exist in index`), or an unstaged edit in the way, failed the
// whole patch with nothing written, and the land still reported markers and moved the branch's landed tip. The next
// catch-up then let the branch's commits go as landed. Now the merge is git's own (merge-ort, through `merge-tree`, which
// follows a rename, so a clash on a renamed file is written as markers in the file under its new name), computed off the
// tree: the tree's working state is snapshotted as a commit (`ours`), merged with the branch from the branch's own
// anchor, and only the difference between that snapshot and the result is written back, a patch whose pre-image is the
// tree as it stands. Nothing about the result is assumed: what a person cannot resolve with markers (a binary, a file
// one side deleted and the other kept) is held off whole before anything is written, and what was written is read back.

// A merge that can be written: every clash in it is a file holding markers, or the branch's own copy of it.
export interface ThreeWay {
    // The snapshot of the tree's working state the merge was made against.
    readonly ours: string;
    // The merged tree.
    readonly result: string;
    // Paths left for a person to finish, under their name in the merged tree (a renamed file's new name).
    readonly conflicted: readonly string[];
}

export type ThreeWayPlan = { readonly kind: "merge"; readonly merge: ThreeWay } | { readonly kind: "held"; readonly paths: readonly string[] };

const NUL = "\0";

// A git listing split on NUL, empty entries dropped.
const listed = (stdout: string): string[] => stdout.split(NUL).filter((path) => path !== "");

/**
 * The tree's working state as a commit, untracked files included, ignored ones not: staged through a copy of the tree's
 * own index (its stat cache spares rehashing what did not change), never through the index itself, which keeps what the
 * person staged. Only objects are written; no ref moves.
 */
const snapshotTree = async (dir: string, scratch: string, name: string, git: GitRunner): Promise<string> => {
    const index = join(scratch, `${name}.index`);
    const own = (await git(dir, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
    const head = await headSha(dir, git);
    const env = { GIT_INDEX_FILE: index };
    // allow(silent-catch): a tree with no index yet (nothing ever staged) is staged afresh from HEAD below.
    const copied = await copyFile(own, index).then(
        () => true,
        () => false,
    );
    if (!copied) {
        await git(dir, head === undefined ? ["read-tree", "--empty"] : ["read-tree", head], env);
    }
    await git(dir, ["add", "-A", "--", ":/"], env);
    const tree = (await git(dir, ["write-tree"], env)).stdout.trim();
    const parents = head === undefined ? [] : ["-p", head];
    return (await git(dir, [...identity(AGENT_GIT_AUTHOR), "commit-tree", tree, ...parents, "-m", "intentic: the tree a merge lands into"])).stdout.trim();
};

// `merge-tree --write-tree`: exit 0 clean, 1 with conflicts (both print the merged tree), anything else a failure.
const mergeTree = async (dir: string, base: string, ours: string, theirs: string, git: GitRunner): Promise<{ result: string; conflicted: string[] }> => {
    const args = ["merge-tree", "--write-tree", "--name-only", "-z", `--merge-base=${base}`, ours, theirs];
    let stdout: string;
    try {
        ({ stdout } = await git(dir, args));
    } catch (error) {
        const printed = stdoutOf(error);
        if (exitCodeOf(error) !== 1 || printed === undefined) {
            throw error;
        }
        stdout = printed;
    }
    // The tree, then each conflicted path, then an empty entry before the messages, which nothing here reads.
    const [head = ""] = stdout.split(`${NUL}${NUL}`);
    const [result = "", ...conflicted] = listed(head);
    return { result, conflicted: [...new Set(conflicted)] };
};

// Paths of `paths` the repository derives (`merge=derived`): a land never writes one, its fixers do (rederive.ts).
const derivedOf = async (dir: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const derived = new Set<string>();
    for (const chunk of chunkPaths(paths)) {
        // `-z`: path, attribute, value, repeated.
        const fields = (await git(dir, ["check-attr", "-z", "merge", "--", ...chunk])).stdout.split(NUL);
        for (let at = 0; at + 2 < fields.length; at += 3) {
            if (fields[at + 2] === "derived") {
                derived.add(fields[at] ?? "");
            }
        }
    }
    return derived;
};

// The conflicted paths whose merged copy holds conflict markers: the ones a person finishes by editing.
const markered = async (dir: string, result: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const found = new Set<string>();
    for (const chunk of chunkPaths(paths)) {
        let stdout = "";
        try {
            ({ stdout } = await git(dir, ["grep", "-l", "-z", "-I", "-E", "-e", "^(<{7}|>{7})( |$)", result, "--", ...chunk]));
        } catch (error) {
            // Exit 1 is "no match": nothing in this chunk holds a marker.
            if (exitCodeOf(error) !== 1) {
                throw error;
            }
        }
        for (const hit of listed(stdout)) {
            found.add(hit.startsWith(`${result}:`) ? hit.slice(result.length + 1) : hit);
        }
    }
    return found;
};

// The conflicted paths whose merged copy differs from the branch's own: with no markers either, the branch's version
// is not in the merge at all (a binary kept as the tree had it, a deletion the tree's edit outvoted).
const unlikeTip = async (dir: string, tip: string, result: string, paths: readonly string[], git: GitRunner): Promise<ReadonlySet<string>> => {
    const unlike = new Set<string>();
    for (const chunk of chunkPaths(paths)) {
        for (const path of listed((await git(dir, ["diff", "--name-only", "--no-renames", "-z", tip, result, "--", ...chunk])).stdout)) {
            unlike.add(path);
        }
    }
    return unlike;
};

/**
 * The merge of `from`..`tip` into `dir`'s working tree, read-only: written by `writeThreeWay`, or `held` naming every
 * clash a merge cannot hand a person as markers, so nothing at all is written for it.
 */
export const planThreeWay = async (dir: string, from: string, tip: string, scratch: string, name: string, git: GitRunner): Promise<ThreeWayPlan> => {
    const ours = await snapshotTree(dir, scratch, name, git);
    const merged = await mergeTree(dir, from, ours, tip, git);
    const derived = merged.conflicted.length === 0 ? new Set<string>() : await derivedOf(dir, merged.conflicted, git);
    const conflicted = merged.conflicted.filter((path) => !derived.has(path));
    if (conflicted.length > 0) {
        const withMarkers = await markered(dir, merged.result, conflicted, git);
        const unlike = await unlikeTip(dir, tip, merged.result, conflicted, git);
        const held = conflicted.filter((path) => !withMarkers.has(path) && unlike.has(path));
        if (held.length > 0) {
            return { kind: "held", paths: held };
        }
    }
    return { kind: "merge", merge: { ours, result: merged.result, conflicted } };
};

// What a merge writes: every path its result holds differently from the snapshot it was made against, derived ones aside.
const writtenBy = async (dir: string, merge: ThreeWay, git: GitRunner): Promise<string[]> =>
    listed((await git(dir, ["diff", "--name-only", "--no-renames", "-z", merge.ours, merge.result, ...UNDERIVED])).stdout);

/** Writes a planned merge into `dir`'s working tree (the index untouched): the snapshot-to-result patch, applied. */
export const writeThreeWay = async (dir: string, merge: ThreeWay, patchPath: string, git: GitRunner): Promise<void> => {
    if ((await writePatch(dir, patchPath, [merge.ours, merge.result, ...UNDERIVED], git)) > 0) {
        await git(dir, ["apply", patchPath]);
    }
};

/**
 * The paths a written merge did not leave as its result says, read back off the tree by content: empty exactly when the
 * tree now holds the merge on every path it wrote. Anything else is a write that cannot be called landed.
 */
export const unwrittenThreeWay = async (dir: string, merge: ThreeWay, scratch: string, name: string, git: GitRunner): Promise<string[]> => {
    const written = await writtenBy(dir, merge, git);
    if (written.length === 0) {
        return [];
    }
    const now = await snapshotTree(dir, scratch, `${name}.after`, git);
    const differing = new Set(listed((await git(dir, ["diff", "--name-only", "--no-renames", "-z", now, merge.result, ...UNDERIVED])).stdout));
    return written.filter((path) => differing.has(path));
};
