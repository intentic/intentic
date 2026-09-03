import { z } from "zod";
import type { WorkspaceTab } from "../../pages/workspace/workspaceTabs";
import { readWindowState, writeWindowState } from "../windowStore";

/* Where the workspace view's "where I was" lives between page loads: the file tree's open folders and the
 * editor's open tabs, as this window's own state seeded by the last window's (windowStore holds the two-store
 * mechanics and why). Per SANDBOX, like the chat's tab snapshot, a path names a file in one sandbox's /work,
 * so carrying it to another would restore a tree of folders that aren't there.
 *
 * Two keys rather than one blob, because the two halves have different owners (useWorkspaceTree holds the open
 * folders, useWorkspaceTabs the strip) and a single key would make each of them read-modify-write the other's
 * state on every toggle.
 *
 * Nothing here is validated against the real filesystem, and it can't be: the tree the paths name is fetched
 * from the daemon long after this is read, and an agent may have deleted half of it meanwhile. A stale open
 * folder is inert (it names no row, so it renders nothing) and a stale tab reports its own 404 through the
 * viewer, which is the same thing the user would see if the file vanished while they watched. */

// --- open folders ------------------------------------------------------------------------------

const expandedKey = (sandboxId: string): string => `intentic.workspaceTree.${sandboxId}`;

// A ceiling on the stored set, so a long session spent opening folders can't grow one sandbox's blob without
// bound (and take the tab strip's write down with it when the quota goes). The SHALLOWEST paths survive a cut:
// an ancestor is what makes everything under it reachable, so dropping a leaf costs one folder while dropping
// an ancestor costs its whole branch.
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

// --- open tabs ---------------------------------------------------------------------------------

const tabsKey = (sandboxId: string): string => `intentic.workspaceTabs.${sandboxId}`;

/* Every tab kind EXCEPT a diff, which is deliberately not persisted for two reasons that point the same way:
 * it carries both sides of the file as content (megabytes, for the strip that is most likely to hold several),
 * and what it shows is a snapshot of a git/snapshot state that the agent has probably moved on from by the
 * next page load, a restored diff would quietly display a comparison that is no longer true. The Changes and
 * Checkpoints panels re-open a live one in a click. Every other kind restores from identity alone (a path, a
 * dir, or a repo). */
export type StoredWorkspaceTab = Exclude<WorkspaceTab, { kind: "diff" }>;

export interface StoredPane {
    // Which tab is focused, or null, a legitimate state, not a missing value: closing the last tab leaves the
    // strip empty, and a bare /workspace URL deselects a file tab while its neighbours stay open.
    readonly active: string | null;
    // The transient tab (see OpenMode), or null when nothing is merely being looked at. Stored so a session that
    // ends mid-peek comes back mid-peek: restoring it as an ordinary tab would pin the one file the user never
    // asked to keep, once per reload.
    readonly preview: string | null;
    readonly tabs: readonly StoredWorkspaceTab[];
}

/* The main pane is the blob itself, and the companion pane hangs off it under `side`, absent whenever there is
 * nothing in it worth restoring, which is most of the time: the split's usual occupant is a diff, and no diff is
 * stored. So the common shape on disk is exactly what it was before there were two panes, and a window that
 * comes back unsplit came back that way because its split held only things this file refuses to keep. */
export interface WorkspaceTabStrip extends StoredPane {
    readonly side?: StoredPane;
}

// Every field that NAMES something is required and non-empty, an entry missing one names nothing this build
// can reopen. The exceptions are `dir` and a document's `path`: the /work root is a directory like any other
// and its path is the empty string, so those two are plain strings.
const named = z.string().min(1);

const StoredTabSchema: z.ZodType<StoredWorkspaceTab> = z.discriminatedUnion(`kind`, [
    z.object({ kind: z.literal(`file`), id: named, path: named }),
    z.object({ kind: z.literal(`directory`), id: named, dir: z.string() }),
    z.object({ kind: z.literal(`health`), id: named, repo: named }),
    /* An extension's document. Restored on identity + the strip's own label, never on the provider being back:
     * extensions activate after this is read, and one that has since been switched off should still leave the
     * tab where the user left it, it renders its own "no longer available" rather than vanishing silently. */
    z.object({ kind: z.literal(`document`), id: named, extension: named, provider: named, path: z.string(), title: named, icon: named }),
]);

interface RawPane {
    active?: unknown;
    preview?: unknown;
    tabs?: unknown;
}

/* Parse one pane out of the blob: readable tabs only (an unreadable one is skipped rather than fatal, it must
 * not cost the user every other file they had open), each id once ACROSS BOTH PANES (`seen` is shared, because
 * one tab in two panes would render as two tabs sharing a key and an edit buffer), and a focus and a preview
 * slot that each name one of this pane's own tabs. */
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
    // A side pane whose every tab was unreadable (or absent entirely) is simply no split: the main pane is a
    // whole strip on its own, and there is nothing to fill a second column with.
    const side = parsePane(typeof stored.side === `object` && stored.side !== null ? (stored.side as RawPane) : undefined, seen);
    return side === undefined ? main : { ...main, side };
};

// This window's editor tabs for a sandbox, else the last window's (the seed) when this one has never opened it.
export const readTabStrip = (sandboxId: string | undefined): WorkspaceTabStrip | undefined =>
    sandboxId === undefined ? undefined : readWindowState(tabsKey(sandboxId), parseStrip);

// Persist this window's strip. Takes the serialized snapshot because the caller watches that string: it is what
// makes "anything about any tab changed" a single cheap comparison, so re-serializing here would only repeat it.
export const writeTabStrip = (sandboxId: string, json: string): void => {
    writeWindowState(tabsKey(sandboxId), json);
};
