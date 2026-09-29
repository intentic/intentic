import { isSafeRelativePath } from "./residue.js";

// WHAT A COPY-FIRST PROJECT'S SANDBOX CHANGED, worked out from two listings of the same folder: this device's copy and
// the sandbox's, each path with its size and sha256. Pure, so every rule below is a test rather than a branch inside a
// process spawner (project-local.ts walks this device, project-remote.ts the sandbox).

// One regular file as a listing holds it. `hash` is absent only where the comparison did not need it: a local file whose
// size already differs from the sandbox's copy is not read (project-local.ts `wantsHash`).
export interface FileStamp {
    readonly size: number;
    readonly hash?: string | undefined;
}

// A path's entry: a regular file, or anything else there (a link, a socket), which is never compared and never offered:
// a link that replaced a file in the sandbox must not read as that file's deletion.
export type Listed = FileStamp | "other";
export type Listing = ReadonlyMap<string, Listed>;

export type ChangeKind = "added" | "modified" | "deleted";

// One entry of `sync changes`: `size` is the sandbox copy's, what bringing it back writes here. `held` is set on a
// `modified` path bring-back will not write over, saying why (its JSON is `conflict: true`).
export interface ProjectChange {
    readonly path: string;
    readonly kind: ChangeKind;
    readonly size?: number;
    readonly held?: string;
}

// The first this many changes are listed; the rest are counted out as `truncated`.
export const CHANGES_MAX = 5_000;

// Mutagen's own scratch files (staging, atomic writes, capability probes) carry this prefix and it never syncs them; a
// listing taken mid-cycle must not offer one either.
const MUTAGEN_TEMPORARY = ".mutagen-temporary-*";

// One pattern of the spellings a project's ignore list uses (ssh.ts PROJECT_IGNORES), as Mutagen reads it: a single
// name, `*` matching within it, that matches the name at any depth, or only at the root when it starts with `/`. A
// matched directory takes everything under it along. Anything else (`!`, `?`, `**`, `[...]`, an inner or trailing `/`)
// is refused rather than approximated: a pattern read too narrowly would offer an ignored file, a secret among them, for
// bringing back.
const PATTERN = /^\/?[^/*?[\]!\\{}]*(?:\*[^/*?[\]!\\{}]*)*$/;

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// The pattern as a regular expression over a whole relative path, which the sandbox's walk runs as it is (project-remote.ts).
export const ignoreExpression = (pattern: string): string => {
    const bare = pattern.replace(/^\//, "");
    if (!PATTERN.test(pattern) || bare === "" || bare.includes("**")) {
        throw new Error(`the ignore pattern ${JSON.stringify(pattern)} is not one this agent can match exactly, so it will not compare the folder with the sandbox's copy`);
    }
    const name = bare.split("*").map(escaped).join("[^/]*");
    return `${pattern.startsWith("/") ? "^" : "(?:^|/)"}${name}(?:/|$)`;
};

// The pairing's ignore list, plus Mutagen's scratch files, as the expressions both walks prune by.
export const ignoreExpressions = (patterns: readonly string[]): string[] => [...patterns, MUTAGEN_TEMPORARY].map(ignoreExpression);

export const ignoreMatcher = (patterns: readonly string[]): ((path: string) => boolean) => {
    const rules = ignoreExpressions(patterns).map((source) => new RegExp(source));
    return (path) => rules.some((rule) => rule.test(path));
};

// A path either side may carry: relative, forward-slashed, no empty, `.` or `..` segment, no backslash (a name that holds
// one on Linux has no spelling on Windows, nor in this format). Anything else is left out of both listings.
export const isPortablePath = (path: string): boolean => isSafeRelativePath(path) && !/^[a-z]:/i.test(path);

const HASH = /^[0-9a-f]{64}$/;

// The sandbox's listing as its walk prints it (project-remote.ts): `path NUL size NUL sha256 NUL` per entry, `-` for
// both numbers of an entry that is not a regular file. NUL is the one byte no file name holds, so names with spaces,
// quotes and newlines come through whole. A listing that stops mid-entry was cut short and is refused whole.
export const parseListing = (raw: string): Map<string, Listed> => {
    const fields = raw.split("\0");
    if (fields.pop() !== "" || fields.length % 3 !== 0) {
        throw new Error("the sandbox's file listing ended early");
    }
    const listing = new Map<string, Listed>();
    for (let at = 0; at < fields.length; at += 3) {
        const [path = "", size = "", hash = ""] = fields.slice(at, at + 3);
        if (!isPortablePath(path)) {
            continue;
        }
        const bytes = Number(size);
        const entry: Listed | undefined = size === "-" && hash === "-" ? "other" : Number.isSafeInteger(bytes) && bytes >= 0 && HASH.test(hash) ? { size: bytes, hash } : undefined;
        if (entry === undefined || listing.has(path)) {
            throw new Error(`the sandbox's file listing is not one this agent wrote (at ${JSON.stringify(path)})`);
        }
        listing.set(path, entry);
    }
    return listing;
};

const sameFile = (here: FileStamp, there: FileStamp): boolean => here.size === there.size && here.hash !== undefined && here.hash === there.hash;

// What says who changed a path the two copies hold differently, gathered as the listing was taken (project-transfer.ts).
export interface Evidence {
    // The session had just run a whole cycle (it was running, and a flush finished): only then are this device's own
    // edits known to have reached the sandbox wherever the sandbox would take them.
    readonly current: boolean;
    // For each file Mutagen reported in conflict (it reports ten at most): whether this device's copy is still exactly
    // what the two last agreed on, by Mutagen's own record of that agreement.
    readonly unchangedHere: ReadonlyMap<string, boolean>;
}

// The words bring-back skips a held path with.
export const HELD_NOT_RUNNING = "the sync was not running, so whether this folder's copy changed too cannot be told; it is left as it is";
export const HELD_CHANGED_HERE = "it changed here too since the two copies last agreed; this folder's copy is left as it is";
export const HELD_UNKNOWN = "no listing has seen the two copies agree on it, so whether it changed here too is not known; this folder's copy is left as it is";

// NEVER OVER A NEWER EDIT. A path both copies hold differently is written over here only when this device's copy is
// still what the two last agreed on, so what the sandbox holds is a change made to it: Mutagen's own record says so for
// the files it reports, the listing record for the rest. Anything else (both moved, no record of agreeing, or a session
// that was not running a cycle to carry this device's edits over) is a conflict, listed and never overwritten.
const heldBecause = (path: string, here: FileStamp, agreed: string | undefined, evidence: Evidence): string | undefined => {
    if (!evidence.current) {
        return HELD_NOT_RUNNING;
    }
    const reported = evidence.unchangedHere.get(path);
    if (reported !== undefined) {
        return reported ? undefined : HELD_CHANGED_HERE;
    }
    if (agreed === undefined) {
        return HELD_UNKNOWN;
    }
    return here.hash === agreed ? undefined : HELD_CHANGED_HERE;
};

// WHAT THE SANDBOX DID, not merely what differs. `agreed` is each path's content when the two copies were last seen
// equal, so a difference the sandbox did not move away from (an edit here still on its way) is not offered at all. A
// file this device alone holds is offered as deleted only when the sandbox had exactly this device's copy of it, and
// one only the sandbox holds is always safe to add: nothing here is written over.
const changeOf = (path: string, here: FileStamp | undefined, there: FileStamp | undefined, agreed: string | undefined, evidence: Evidence): ProjectChange | undefined => {
    if (there === undefined) {
        return agreed !== undefined && here?.hash === agreed ? { path, kind: "deleted" } : undefined;
    }
    if (agreed !== undefined && there.hash === agreed) {
        return undefined;
    }
    if (here === undefined) {
        return { path, kind: "added", size: there.size };
    }
    const held = heldBecause(path, here, agreed, evidence);
    return held === undefined ? { path, kind: "modified", size: there.size } : { path, kind: "modified", size: there.size, held };
};

export interface Classified {
    // Every change, by path.
    readonly changes: readonly ProjectChange[];
    // The next record of agreement: a path's content where the two copies are equal now, its old record where they differ.
    readonly agreed: ReadonlyMap<string, string>;
}

export const classify = (local: Listing, remote: Listing, agreed: ReadonlyMap<string, string>, evidence: Evidence): Classified => {
    const changes: ProjectChange[] = [];
    const next = new Map<string, string>();
    for (const path of [...new Set([...local.keys(), ...remote.keys()])].toSorted()) {
        const here = local.get(path);
        const there = remote.get(path);
        if (here === "other" || there === "other") {
            continue;
        }
        if (here !== undefined && there !== undefined && sameFile(here, there) && there.hash !== undefined) {
            next.set(path, there.hash);
            continue;
        }
        const before = agreed.get(path);
        if (before !== undefined) {
            next.set(path, before);
        }
        const change = changeOf(path, here, there, before, evidence);
        if (change !== undefined) {
            changes.push(change);
        }
    }
    return { changes, agreed: next };
};

export interface CappedChanges {
    readonly changes: readonly ProjectChange[];
    readonly truncated: boolean;
}

// What `sync changes` prints: the first CHANGES_MAX, and whether there were more.
export const capped = (changes: readonly ProjectChange[]): CappedChanges => ({
    changes: changes.slice(0, CHANGES_MAX),
    truncated: changes.length > CHANGES_MAX,
});

export interface Selection {
    readonly selected: readonly ProjectChange[];
    // The paths asked for that name no change.
    readonly unmatched: readonly string[];
}

// Which changes a `--path` names: the file itself, or everything under a folder. A path that names none is reported
// back rather than dropped, so a stale selection says so.
export const selectChanges = (changes: readonly ProjectChange[], paths: readonly string[]): Selection => {
    if (paths.length === 0) {
        return { selected: changes, unmatched: [] };
    }
    const wanted = paths.map((path) => path.replace(/\/+$/, ""));
    const names = (path: string, change: ProjectChange): boolean => change.path === path || change.path.startsWith(`${path}/`);
    return {
        selected: changes.filter((change) => wanted.some((path) => names(path, change))),
        unmatched: wanted.filter((path) => !changes.some((change) => names(path, change))),
    };
};
