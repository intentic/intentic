import { computed, reactive } from "vue";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { basename, parentDir } from "@intentic/ui/path";

// What this browser has done to the workspace that the daemon's listing hasn't agreed with yet. That listing is a fresh
// walk of /work costing hundreds of milliseconds to seconds, so between an action landing and the walk returning the
// explorer would show the tree exactly as it was — and unchanged looks the same as refused. Every file operation writes
// its intent here first and the explorer draws from it, so a row appears, moves or goes the moment it is asked to.
// Each entry retires against the real listing, not a timer, so the provisional row is replaced rather than re-added.

// arriving: on its way in — bytes still moving, or a create/copy/move destination the daemon hasn't confirmed.
// landing:  the daemon confirmed it; only the listing is behind.
// failed:   nothing landed, and the row stays as the evidence. Uploads only; a tree op reverts instead.
// leaving:  on its way out (a delete, or the source of a move), so its row goes before the walk agrees it did.
export type ProvisionalState = "arriving" | "landing" | "failed" | "leaving";

// Which operation put it here, and so how long the row may reasonably sit: an upload can hold for minutes, a write for
// one round trip. Read only for the row's tooltip.
export type ProvisionalKind = "upload" | "write";

export interface Provisional {
    readonly kind: ProvisionalKind;
    readonly type: "file" | "dir";
    readonly size?: number;
    state: ProvisionalState;
    // Departures only: whether a listing has actually reported this path since it was marked. The listing the explorer
    // reconciles against is the eager walk plus whatever lazy subtrees are loaded, so it is INCOMPLETE by design — a
    // folder nobody has expanded, a path past the walk's entry budget, or the very first load all read as "absent".
    // Absence is only evidence that a delete landed if the same listing was reporting the path a moment ago.
    seenListed?: boolean;
}

export interface ArrivalSpec {
    readonly kind: ProvisionalKind;
    readonly type?: "file" | "dir";
    readonly size?: number;
}

// Bounds what one huge drop or bulk delete costs the explorer to draw; past it the listing is the only authority.
const MAX_TRACKED = 500;
// A path the tree will never reconcile (refused, locked, deleted straight after) has nothing to retire its entry.
const SETTLED_TTL_MS = 60_000;

// Root-relative path → what is happening to it. Arrivals synthesize the directories above them; departures never do.
const entries = reactive(new Map<string, Provisional>());
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const forget = (path: string): void => {
    entries.delete(path);
    const timer = timers.get(path);
    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(path);
    }
};

const bounded = (path: string): boolean => entries.size < MAX_TRACKED || entries.has(path);

/** Records something on its way in, so its row exists before the daemon's walk agrees it does. */
export const noteArriving = (path: string, spec: ArrivalSpec): void => {
    if (!bounded(path)) {
        return;
    }
    forget(path);
    entries.set(path, {
        kind: spec.kind,
        type: spec.type ?? `file`,
        ...(spec.size === undefined ? {} : { size: spec.size }),
        state: `arriving`,
    });
};

/** Records something on its way out, so its row goes at the gesture rather than a round trip later. */
export const noteLeaving = (path: string): void => {
    if (!bounded(path)) {
        return;
    }
    forget(path);
    entries.set(path, { kind: `write`, type: `file`, state: `leaving` });
};

/**
 * The daemon confirmed the write; only the listing is behind now. Arms the failsafe that retires an entry no listing
 * will ever reconcile.
 */
export const markSettled = (path: string): void => {
    const entry = entries.get(path);
    if (entry === undefined) {
        return;
    }
    if (entry.state === `arriving`) {
        entry.state = `landing`;
    }
    clearTimeout(timers.get(path));
    timers.set(
        path,
        setTimeout(() => forget(path), SETTLED_TTL_MS),
    );
};

/** Nothing landed under this path; the row stays failed until the upload card is dismissed. */
export const markFailed = (path: string): void => {
    const entry = entries.get(path);
    if (entry !== undefined) {
        entry.state = `failed`;
    }
};

/** Takes back an intent the daemon refused: the row returns to whatever the listing says, with no trace left. */
export const dropProvisional = (path: string): void => forget(path);

/**
 * Retires every entry the real listing now agrees with, called whenever a listing lands. An arrival retires once the
 * path is listed, a departure once it is not — the same rule read from both ends.
 */
export const reconcileProvisional = (isListed: (path: string) => boolean): void => {
    // Deleting the key the iterator is sitting on is defined behaviour for a Map; no copy needed.
    for (const [path, entry] of entries) {
        const listed = isListed(path);
        if (entry.state !== `leaving`) {
            if (listed) {
                forget(path);
            }
            continue;
        }
        // A departure needs the listing to have HELD the path and then dropped it. One that never held it says nothing
        // (see `seenListed`); the row stays gone, and the settle failsafe is what eventually clears the entry.
        if (listed) {
            entry.seenListed = true;
        } else if (entry.seenListed === true) {
            forget(path);
        }
    }
};

/**
 * Drops upload entries for work that is over — a cancel, or the card being dismissed. Settled ones stay: their bytes
 * are on disk and the row is still the only sign of them until the tree catches up. Writes are untouched; they belong
 * to gestures the card knows nothing about.
 */
export const clearUnsettledUploads = (): void => {
    for (const [path, entry] of entries) {
        if (entry.kind === `upload` && entry.state !== `landing`) {
            forget(path);
        }
    }
};

/** Drops everything: the tree these belonged to is gone (a sandbox switch). */
export const resetProvisional = (): void => {
    for (const path of entries.keys()) {
        forget(path);
    }
};

// Which state wins on a directory holding several: still-moving work outranks waiting work, and both outrank a
// failure, which has its own row underneath saying so.
const RANK: Record<ProvisionalState, number> = { arriving: 4, landing: 3, failed: 2, leaving: 1 };

interface Placeholder {
    readonly entry: WorkspaceTreeEntry;
    readonly provisional: Provisional;
}

// Parent directory → arriving children, built once per change so a row lookup costs a map hit rather than a walk of
// every tracked path. Directories on the way to an arrival are placeholders too: a dropped folder shows as a folder.
// A departure is exact: deleting `a/b.txt` says nothing about `a`, so it never reaches this index.
const arrivals = computed<ReadonlyMap<string, ReadonlyMap<string, Placeholder>>>(() => {
    const byDir = new Map<string, Map<string, Placeholder>>();
    const put = (dir: string, entry: WorkspaceTreeEntry, provisional: Provisional): void => {
        const level = byDir.get(dir) ?? new Map<string, Placeholder>();
        const held = level.get(entry.name);
        if (held === undefined || RANK[provisional.state] > RANK[held.provisional.state]) {
            level.set(entry.name, { entry, provisional });
        }
        byDir.set(dir, level);
    };
    for (const [path, provisional] of entries) {
        if (provisional.state === `leaving`) {
            continue;
        }
        const segments = path.split(`/`);
        let dir = ``;
        for (const [depth, name] of segments.entries()) {
            const at = dir === `` ? name : `${dir}/${name}`;
            const leaf = depth === segments.length - 1;
            // An ancestor carries the leaf's state but none of its facts, so a folder reads as busy while anything
            // under it is without inheriting a file's size.
            if (leaf) {
                put(dir, { name, path: at, type: provisional.type, ...(provisional.size === undefined ? {} : { size: provisional.size }) }, provisional);
            } else {
                put(dir, { name, path: at, type: `dir` }, { kind: provisional.kind, type: `dir`, state: provisional.state });
            }
            dir = at;
        }
    }
    return byDir;
});

// Exact paths on their way out; the set the explorer filters its rows against.
const departures = computed<ReadonlySet<string>>(() => {
    const out = new Set<string>();
    for (const [path, entry] of entries) {
        if (entry.state === `leaving`) {
            out.add(path);
        }
    }
    return out;
});

/** What is happening to this path, or undefined when the listing is the whole truth about it. */
export const provisionalAt = (path: string): Provisional | undefined => {
    const entry = entries.get(path);
    if (entry?.state === `leaving`) {
        return entry;
    }
    return arrivals.value.get(parentDir(path))?.get(basename(path))?.provisional;
};

/** Whether this path's row should be drawn at all: a departure is gone from the tree the moment it is asked for. */
export const isLeaving = (path: string): boolean => departures.value.has(path);

// Same order the daemon lists a directory in (folders first, then by name), so a placeholder sits where its real row
// will, and landing doesn't move it.
const byKind = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number =>
    left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1;

/**
 * One directory's listing as the explorer should draw it now: arrivals merged in, departures taken out. Returns
 * `listed` itself when neither applies, so the common case allocates nothing.
 */
export const withProvisionalEntries = (dir: string, listed: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] => {
    const level = arrivals.value.get(dir);
    const going = departures.value;
    const staying = going.size === 0 ? listed : listed.filter((entry) => !going.has(entry.path));
    if (level === undefined) {
        return staying;
    }
    const taken = new Set(staying.map((entry) => entry.name));
    const extra = [...level.values()].filter((placeholder) => !taken.has(placeholder.entry.name)).map((placeholder) => placeholder.entry);
    return extra.length === 0 ? staying : [...staying, ...extra].sort(byKind);
};
