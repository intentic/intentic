import type { GitChange } from "@intentic/sandbox-contract";

/* THE PARSERS BEHIND THE CHANGES REVIEW: git's `-z` porcelain listings (`--name-status`, `--numstat`,
 * `status --porcelain=v2`) read into the GitChange rows the panel renders. Pure string work, nothing is spawned
 * here; the readers that spawn git are changes.ts (the working tree), changes-commits.ts (one commit) and
 * stash.ts (one entry), and they share these so a rename or a conflict reads the same whichever listing it
 * came from. */

// `U` is git's unmerged marker, a path the merge could not resolve, which is neither staged nor unstaged but
// its own third state (there is no stage 0 for it at all; the index holds stages 1/2/3 instead).
const STATUS_OF: Record<string, GitChange["status"]> = { A: "added", M: "modified", D: "deleted", T: "type-changed", U: "conflicted" };

/* The paths in one `-z` git listing, each COPIED OUT of the string it arrived in, for callers that CACHE
 * what this returns.
 *
 * `split` answers with V8 sliced strings: views into the parent, which therefore pin the ENTIRE stdout, a
 * fleet-wide `--name-only` span runs to megabytes, for as long as ONE cached path lives. That was most of the
 * daemon's heap: the attribution caches (agents/origins.ts, agents/landed-presence.ts) held path lists whose
 * every element secretly retained a quarter-megabyte diff listing, ~180 MB per pass over the fleet's landings,
 * repinned at every new HEAD, never released. The Buffer round-trip allocates each path as its own flat string,
 * so the parent dies with this call frame. Callers that consume paths transiently can keep plain split(). */
export const materializedPaths = (stdout: string): string[] =>
    stdout
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => Buffer.from(path, "utf8").toString("utf8"));

// Parse `--name-status -z` output (from `git diff` or `git diff-tree`) into GitChanges. NUL-separated records
// are `STATUS\0path\0`, except renames/copies which span three fields (`R<score>\0old\0new\0`), a cursor walk,
// not a fixed stride. Keyed by the (new) path so a later record for the same path wins. EXCEPT that
// "conflicted" is sticky: `git diff` emits an unmerged path twice (`U` then `M`), and letting the second record
// win is what used to make a conflict render as an ordinary modification.
//
// Exported because land.ts classifies a delta by CHANGE rather than by path, and `status` + `from` is what says
// a change spans two of them (agents/land.ts DeltaChange). Reading the delta with `--name-only` instead is what
// made renames land half-applied: that output names a rename's destination and nothing else.
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

// Parse `--numstat -z` into a path → {additions, deletions} map, keyed by the (new) path so it merges onto the
// name-status list. NUL-separated: a normal record is `add\tdel\tpath\0`; a rename is `add\tdel\t\0old\0new\0`
// (the counts, an empty path, then the two names). Binary files report `-\t-`, left undefined here.
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

/* THE ONE READ THE WHOLE REVIEW IS BUILT FROM, `git status --porcelain=v2 -z --branch`, parsed into the three
 * lists the panel renders plus the two header facts (the checked-out branch, and HEAD's sha).
 *
 * v2 is what lets ONE spawn answer what five used to (the branch, HEAD, both `--name-status` passes and the
 * untracked walk): every record carries BOTH staging columns, so `XY` splits into an index-vs-HEAD change and a
 * worktree-vs-index change independently. That is not the collapse changedFiles' note (changes.ts) warns about, collapsing
 * is picking ONE status per path, which loses the `MM` case; reading two columns as two changes is what the two
 * diffs did, said once. Line counts still come from the real per-side diffs, so a row's stat still describes the
 * diff it is displayed under.
 *
 * Records are NUL-terminated: `1` an ordinary change, `2` a rename/copy (whose ORIGIN PATH is the next NUL field,
 * not part of the record), `u` an unmerged path, `?` untracked, `!` ignored. Their leading fields are fixed in
 * COUNT but not in width, and a path may contain spaces, so the path is taken as the whole remainder after
 * skipping that many spaces, never by splitting the record. */
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

// One side's letter, in the vocabulary parseNameStatusZ already established: `R` carries its origin, `C` (a copy)
// reads as a plain addition, and anything unrecognised degrades to "modified" rather than dropping the row.
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
    /* THE OBJECT NAMES THE STATUS RECORD ALREADY CARRIES, per path: HEAD's blob and the index's. Read out
     * because they are free here and expensive anywhere else, and because they are what the code-only counts are
     * cached on (code-counts.ts): the same object name means the same bytes, so a scan whose files have not
     * moved re-reads none of them. A rename keys on the NEW path, like every other reading in this file. */
    blobs: Map<string, { head?: string; index?: string }>;
}

// One space-separated field of a porcelain-v2 record, by position. The path is never read this way (it may hold
// spaces, see recordPath); the fixed-width leading fields are.
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

// `1`/`2` records are `<kind> <XY> <sub> <mH> <mI> <mW> <hH> <hI> …`, so the two object names sit at 6 and 7
// whichever of the two kinds this is. All-zero means "no blob on that side" (an addition has no HEAD blob).
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
            // `(initial)` on an unborn HEAD and `(detached)` off a branch both mean "no answer", the same thing
            // the empty output of the two commands this replaces meant.
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
        // A rename's origin is its own NUL field, so it must be consumed whether or not the record parsed,
        // leaving it would be read as the next record.
        const from = kind === "2" ? (records[cursor] ?? "") : undefined;
        if (kind === "2") {
            cursor += 1;
        }
        if (path === "") {
            continue;
        }
        if (kind === "u") {
            // An unmerged path has no stage 0, so it is neither side's, see changedFiles' note (changes.ts). v2 gives it its
            // own record kind, so it never has to be filtered back out of the two lists.
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
