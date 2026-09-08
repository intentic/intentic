import type { GitChange } from "@intentic/sandbox-contract";

// Parsers behind the Changes review: git's -z porcelain listings into the GitChange rows the panel renders.
// Pure string work, nothing spawned; changes.ts, changes-commits.ts and stash.ts spawn git and share these readers.
// So a rename or a conflict reads the same whichever listing it came from.

// `U` is git's unmerged marker: neither staged nor unstaged, its own third state (no stage 0; index holds 1/2/3).
const STATUS_OF: Record<string, GitChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed", U: "conflicted" };

// Copies each path out of the `-z` listing's string, for callers that cache what this returns.
// `split` gives V8 sliced views that pin the whole stdout alive per cached path; the Buffer round-trip avoids that.
export const materializedPaths = (stdout: string): string[] =>
    stdout
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => Buffer.from(path, "utf8").toString("utf8"));

// Parses `--name-status -z` into GitChanges; records are STATUS\0path\0, except renames/copies (R<score>\0old\0new\0).
// Keyed by the new path, last record wins, except conflicted is sticky (git emits an unmerged path as U then M).
export const parseNameStatusZ = (stdout: string): GitChange[] => {
    const parts = stdout.split("\0");
    const changes = new Map<string, GitChange>();
    let cursor = 0;
    while (cursor + 1 < parts.length) {
        const status = parts[cursor] ?? "";
        const path = parts[cursor + 1] ?? "";
        if (status === "" || path === "") {
            break;
        }
        if (status.startsWith("R") || status.startsWith("C")) {
            const to = parts[cursor + 2] ?? "";
            cursor += 3;
            if (to === "") {
                break;
            }
            changes.set(to, status.startsWith("R") ? { path: to, status: "renamed", from: path } : { path: to, status: "added" });
            continue;
        }
        cursor += 2;
        if (changes.get(path)?.status === "conflicted") {
            continue;
        }
        changes.set(path, { path, status: STATUS_OF[status[0] ?? ""] ?? "modified" });
    }
    return [...changes.values()];
};

// Parses `--numstat -z` into path → {additions, deletions}, keyed by the new path to merge onto the name-status list.
// A rename record has an empty path then old/new NUL fields; binary files report `-\t-`, left undefined here.
export const parseNumstatZ = (stdout: string): Map<string, { additions?: number; deletions?: number }> => {
    const parts = stdout.split("\0");
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    let cursor = 0;
    while (cursor < parts.length) {
        const segment = parts[cursor];
        if (segment === undefined || segment === "") {
            cursor += 1;
            continue;
        }
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(segment);
        if (match === null) {
            cursor += 1;
            continue;
        }
        // Omit (not set to undefined) a binary file's counts, the schema's optional fields are exact.
        const stat: { additions?: number; deletions?: number } = {};
        if (match[1] !== "-") {
            stat.additions = Number(match[1]);
        }
        if (match[2] !== "-") {
            stat.deletions = Number(match[2]);
        }
        const rest = match[3] ?? "";
        if (rest === "") {
            // Rename: the old + new paths are the next two NUL fields; key on the new path.
            stats.set(parts[cursor + 2] ?? "", stat);
            cursor += 3;
        } else {
            stats.set(rest, stat);
            cursor += 1;
        }
    }
    return stats;
};

// The one read the whole review is built from: `git status --porcelain=v2 -z --branch`, into three lists plus HEAD.
// Both staging columns (`XY`) read as independent staged/unstaged changes, not collapsed, so the `MM` case isn't lost.
// Record kinds: `1` ordinary, `2` rename (origin is the next NUL field), `u` unmerged, `?` untracked, `!` ignored.
// Leading fields are fixed in count, not width; a path may hold spaces.
const LEADING_FIELDS: Record<string, number> = { "1": 8, "2": 9, u: 10 };

const recordPath = (record: string, fields: number): string => {
    let cursor = 0;
    for (let field = 0; field < fields; field += 1) {
        const next = record.indexOf(" ", cursor);
        if (next === -1) {
            return "";
        }
        cursor = next + 1;
    }
    return record.slice(cursor);
};

// One side's letter, in parseNameStatusZ's vocabulary: `R` carries its origin, `C` reads as an addition, else modified.
const changeAt = (letter: string, path: string, from: string | undefined): GitChange =>
    letter === "R" && from !== undefined
        ? { path, status: "renamed", from }
        : { path, status: letter === "C" ? "added" : (STATUS_OF[letter] ?? "modified") };

export interface StatusV2 {
    branch?: string;
    head?: string;
    conflicted: GitChange[];
    staged: GitChange[];
    unstaged: GitChange[];
    untracked: string[];
    // HEAD's and the index's object names per path, free here; code-counts.ts caches on them (same name, same bytes).
    blobs: Map<string, { head?: string; index?: string }>;
}

// One space-separated field of a v2 record, by position; the path (may hold spaces) is read via recordPath instead.
const recordField = (record: string, index: number): string | undefined => {
    let cursor = 0;
    for (let field = 0; field < index; field += 1) {
        const next = record.indexOf(" ", cursor);
        if (next === -1) {
            return undefined;
        }
        cursor = next + 1;
    }
    const end = record.indexOf(" ", cursor);
    return end === -1 ? undefined : record.slice(cursor, end);
};

// `1`/`2` records place the two object names at fields 6 and 7 either way; all-zero means no blob on that side.
const ZERO_OID = /^0+$/;
const blobsOf = (record: string): { head?: string; index?: string } => {
    const head = recordField(record, 6);
    const index = recordField(record, 7);
    return {
        ...(head !== undefined && !ZERO_OID.test(head) ? { head } : {}),
        ...(index !== undefined && !ZERO_OID.test(index) ? { index } : {}),
    };
};

export const parseStatusV2 = (stdout: string): StatusV2 => {
    const records = stdout.split("\0");
    const conflicted: GitChange[] = [];
    const staged: GitChange[] = [];
    const unstaged: GitChange[] = [];
    const untracked: string[] = [];
    const blobs = new Map<string, { head?: string; index?: string }>();
    let branch: string | undefined;
    let head: string | undefined;
    let cursor = 0;
    while (cursor < records.length) {
        const record = records[cursor] ?? "";
        cursor += 1;
        const kind = record[0] ?? "";
        if (kind === "#") {
            const [, key, value] = record.split(" ");
            // `(initial)` (unborn HEAD) and `(detached)` (no branch) both mean no answer, as before.
            if (key === "branch.oid" && value !== undefined && value !== "(initial)") {
                head = value;
            }
            if (key === "branch.head" && value !== undefined && value !== "(detached)") {
                branch = value;
            }
            continue;
        }
        if (kind === "?") {
            const path = record.slice(2);
            if (path !== "") {
                untracked.push(path);
            }
            continue;
        }
        const fields = LEADING_FIELDS[kind];
        if (fields === undefined) {
            // `!` (ignored, never requested here) and the empty trailing record after the final NUL.
            continue;
        }
        const path = recordPath(record, fields);
        // A rename's origin is its own NUL field; consumed even if the record didn't parse, or it reads as the next.
        const from = kind === "2" ? (records[cursor] ?? "") : undefined;
        if (kind === "2") {
            cursor += 1;
        }
        if (path === "") {
            continue;
        }
        if (kind === "u") {
            // An unmerged path has no stage 0 (changes.ts); its record kind alone keeps it out of the two lists.
            conflicted.push({ path, status: "conflicted" });
            continue;
        }
        blobs.set(path, blobsOf(record));
        const index = record[2] ?? ".";
        const worktree = record[3] ?? ".";
        if (index !== ".") {
            staged.push(changeAt(index, path, from));
        }
        if (worktree !== ".") {
            unstaged.push(changeAt(worktree, path, from));
        }
    }
    return { ...(branch !== undefined ? { branch } : {}), ...(head !== undefined ? { head } : {}), conflicted, staged, unstaged, untracked, blobs };
};
