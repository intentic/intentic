import { computed, reactive } from "vue";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { basename, parentDir } from "@intentic/ui/path";

// Files handed to the daemon but not yet listed by the tree it serves. That listing is a fresh walk of /work costing
// hundreds of milliseconds to seconds, so between a drop landing and the walk returning the explorer would show nothing
// where the files went — and nothing looks the same as failed. The explorer draws these as placeholder rows and each one
// retires the moment the real entry appears, so the row is continuous rather than appearing late.

export type PendingState = "uploading" | "landing" | "failed";

interface Pending {
    readonly size: number;
    state: PendingState;
}

// Bounds what one huge drop costs the explorer to draw; past it the upload card carries the count on its own.
const MAX_TRACKED = 500;
// A placeholder for a path the tree will never list (refused, locked, deleted straight after) has nothing to retire it.
const LANDED_TTL_MS = 60_000;

// Root-relative destination path → its state. Only files are tracked; the directories on the way are derived below.
const entries = reactive(new Map<string, Pending>());
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const forget = (path: string): void => {
    entries.delete(path);
    const timer = timers.get(path);
    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(path);
    }
};

/** Records a file this browser is about to send, so its row can exist before the daemon's walk agrees it does. */
export const notePendingUpload = (path: string, size: number): void => {
    if (entries.size >= MAX_TRACKED && !entries.has(path)) {
        return;
    }
    forget(path);
    entries.set(path, { size, state: `uploading` });
};

/** The bytes are on disk; the row stays until the tree lists it, or until the failsafe age runs out. */
export const markUploadLanded = (path: string): void => {
    const entry = entries.get(path);
    if (entry === undefined) {
        return;
    }
    entry.state = `landing`;
    clearTimeout(timers.get(path));
    timers.set(
        path,
        setTimeout(() => forget(path), LANDED_TTL_MS),
    );
};

/** Nothing landed under this path; the row stays failed until the upload card is dismissed. */
export const markUploadFailed = (path: string): void => {
    const entry = entries.get(path);
    if (entry !== undefined) {
        entry.state = `failed`;
    }
};

/** Retires every placeholder the real tree now lists, called whenever a listing lands. */
export const retireListedUploads = (isListed: (path: string) => boolean): void => {
    // Deleting the key the iterator is sitting on is defined behaviour for a Map; no copy needed.
    for (const path of entries.keys()) {
        if (isListed(path)) {
            forget(path);
        }
    }
};

/**
 * Drops placeholders for work that is over — a cancel, or the card being dismissed. Landed ones stay: their bytes are
 * on disk and the row is still the only sign of them until the tree catches up.
 */
export const clearUnlandedUploads = (): void => {
    for (const [path, entry] of entries) {
        if (entry.state !== `landing`) {
            forget(path);
        }
    }
};

/** Drops every placeholder, including landed ones: the tree they belonged to is gone (a sandbox switch). */
export const resetPendingUploads = (): void => {
    for (const path of entries.keys()) {
        forget(path);
    }
};

// Which state wins on a directory holding several: still-moving bytes outrank waiting ones, and both outrank a failure,
// which has its own row underneath saying so.
const RANK: Record<PendingState, number> = { uploading: 3, landing: 2, failed: 1 };

interface Placeholder {
    readonly entry: WorkspaceTreeEntry;
    readonly state: PendingState;
}

// Parent directory → placeholder children, built once per change so a row lookup costs a map hit, not a walk of every
// pending path. Directories on the way to a pending file are placeholders too: a dropped folder shows up as a folder.
const index = computed<ReadonlyMap<string, ReadonlyMap<string, Placeholder>>>(() => {
    const byDir = new Map<string, Map<string, Placeholder>>();
    const put = (dir: string, entry: WorkspaceTreeEntry, state: PendingState): void => {
        const level = byDir.get(dir) ?? new Map<string, Placeholder>();
        const held = level.get(entry.name);
        if (held === undefined || RANK[state] > RANK[held.state]) {
            level.set(entry.name, { entry, state });
        }
        byDir.set(dir, level);
    };
    for (const [path, pending] of entries) {
        const segments = path.split(`/`);
        let dir = ``;
        for (const [depth, name] of segments.entries()) {
            const at = dir === `` ? name : `${dir}/${name}`;
            const leaf = depth === segments.length - 1;
            put(dir, leaf ? { name, path: at, type: `file`, size: pending.size } : { name, path: at, type: `dir` }, pending.state);
            dir = at;
        }
    }
    return byDir;
});

/** The placeholder state for a path, or undefined when the row is a real one. */
export const pendingStateOf = (path: string): PendingState | undefined => index.value.get(parentDir(path))?.get(basename(path))?.state;

// Same order the daemon lists a directory in (folders first, then by name), so a placeholder sits where its real row
// will, and landing doesn't move it.
const byKind = (left: WorkspaceTreeEntry, right: WorkspaceTreeEntry): number =>
    left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1;

/**
 * One directory's listing with placeholders for what is still on its way merged in. Returns `listed` itself when there
 * are none, so the common case allocates nothing.
 */
export const withPendingEntries = (dir: string, listed: readonly WorkspaceTreeEntry[]): readonly WorkspaceTreeEntry[] => {
    const level = index.value.get(dir);
    if (level === undefined) {
        return listed;
    }
    const taken = new Set(listed.map((entry) => entry.name));
    const extra = [...level.values()].filter((placeholder) => !taken.has(placeholder.entry.name)).map((placeholder) => placeholder.entry);
    return extra.length === 0 ? listed : [...listed, ...extra].sort(byKind);
};
