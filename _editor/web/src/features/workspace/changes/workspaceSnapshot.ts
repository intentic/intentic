import { z } from "zod";
import type { WorkspaceTab } from "../tabs/workspaceTabs";
import { readWindowState, writeWindowState } from "../../../shell/window/windowStore";

// Per-window "where I was" state (open tree folders, open tabs); per sandbox, since a path names a file in
// only one sandbox's /work. Two separate keys since the tree and tab-strip composables own their halves independently.
// Nothing here is validated against the filesystem: a stale reference just renders inert, or 404s in the viewer.

const expandedKey = (sandboxId: string): string => `intentic.workspaceTree.${sandboxId}`;

// Ceiling on the stored set; the shallowest paths survive a cut, since an ancestor makes everything under it reachable.
const MAX_EXPANDED = 500;

const parseExpanded = (raw: string): readonly string[] | undefined => {
    let stored: unknown;
    try {
        stored = JSON.parse(raw);
    } catch {
        return undefined;
    }
    return Array.isArray(stored) ? stored.filter((path): path is string => typeof path === `string` && path !== ``) : undefined;
};

const depth = (path: string): number => path.split(`/`).length;

// The folders this window last had open in a sandbox's tree, or none.
export const readExpandedDirs = (sandboxId: string | undefined): readonly string[] =>
    (sandboxId === undefined ? undefined : readWindowState(expandedKey(sandboxId), parseExpanded)) ?? [];

export const writeExpandedDirs = (sandboxId: string, paths: readonly string[]): void => {
    const capped = paths.length <= MAX_EXPANDED ? paths : paths.toSorted((left, right) => depth(left) - depth(right)).slice(0, MAX_EXPANDED);
    writeWindowState(expandedKey(sandboxId), JSON.stringify(capped));
};

const tabsKey = (sandboxId: string): string => `intentic.workspaceTabs.${sandboxId}`;

// Every tab kind except diff: a diff carries both file sides as content and reflects a git/snapshot state that's
// likely stale by the next load. Everything else restores from identity alone (a path, dir, or repo).
export type StoredWorkspaceTab = Exclude<WorkspaceTab, { kind: "diff" }>;

export interface StoredPane {
    // Which tab is focused, or null — a legitimate state, not a missing value (e.g. the last tab just closed).
    readonly active: string | null;
    // The transient preview tab (see OpenMode), or null; stored so a session that ends mid-peek resumes mid-peek, not
    // pinned.
    readonly preview: string | null;
    readonly tabs: readonly StoredWorkspaceTab[];
}

// Main pane is the blob itself; the companion pane sits under `side`, absent when it held nothing worth
// restoring (usually a diff, which this file never stores).
export interface WorkspaceTabStrip extends StoredPane {
    readonly side?: StoredPane;
}

// Every name-bearing field is required and non-empty, except `dir` and a document's `path` (the /work root is `""`).
const named = z.string().min(1);

const StoredTabSchema: z.ZodType<StoredWorkspaceTab> = z.discriminatedUnion(`kind`, [
    z.object({ kind: z.literal(`file`), id: named, path: named }),
    z.object({ kind: z.literal(`directory`), id: named, dir: z.string() }),
    z.object({ kind: z.literal(`health`), id: named, repo: named }),
    // Restored on identity and its own label, not on the provider being back; a disabled extension's tab shows its
    // own "unavailable" instead of vanishing.
    z.object({ kind: z.literal(`document`), id: named, extension: named, provider: named, path: z.string(), title: named, icon: named }),
]);

interface RawPane {
    active?: unknown;
    preview?: unknown;
    tabs?: unknown;
}

// Skips unreadable tabs rather than failing the whole pane. `seen` is shared across both panes so one tab id
// can't appear in both, which would collide on key and edit buffer.
const parsePane = (raw: RawPane | undefined, seen: Set<string>): StoredPane | undefined => {
    if (raw === undefined || !Array.isArray(raw.tabs)) {
        return undefined;
    }
    const mine = new Set<string>();
    const tabs: StoredWorkspaceTab[] = [];
    for (const entry of raw.tabs) {
        const tab = StoredTabSchema.safeParse(entry).data;
        if (tab !== undefined && !seen.has(tab.id)) {
            seen.add(tab.id);
            mine.add(tab.id);
            tabs.push(tab);
        }
    }
    if (tabs.length === 0) {
        return undefined;
    }
    const names = (id: unknown): string | null => (typeof id === `string` && mine.has(id) ? id : null);
    return { active: names(raw.active), preview: names(raw.preview), tabs };
};

const parseStrip = (raw: string): WorkspaceTabStrip | undefined => {
    let stored: RawPane & { side?: unknown };
    try {
        stored = JSON.parse(raw) as RawPane & { side?: unknown };
    } catch {
        return undefined;
    }
    const seen = new Set<string>();
    const main = parsePane(stored, seen);
    if (main === undefined) {
        return undefined;
    }
    // A side pane with no readable tabs is simply no split; the main pane stands alone.
    const side = parsePane(typeof stored.side === `object` && stored.side !== null ? (stored.side as RawPane) : undefined, seen);
    return side === undefined ? main : { ...main, side };
};

// This window's tabs for the sandbox, or the last window's as a seed when this one has never opened it.
export const readTabStrip = (sandboxId: string | undefined): WorkspaceTabStrip | undefined =>
    sandboxId === undefined ? undefined : readWindowState(tabsKey(sandboxId), parseStrip);

// Takes the pre-serialized string since the caller already computed it for its own change check.
export const writeTabStrip = (sandboxId: string, json: string): void => {
    writeWindowState(tabsKey(sandboxId), json);
};
