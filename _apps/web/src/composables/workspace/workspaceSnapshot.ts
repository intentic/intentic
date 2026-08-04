import { z } from "zod";
import type { WorkspaceTab } from "../../pages/workspace/workspaceTabs";
import { readWindowState, writeWindowState } from "../windowStore";

/* Where the workspace view's "where I was" lives between page loads: the file tree's open folders and the
 * editor's open tabs, as this window's own state seeded by the last window's (windowStore holds the two-store
 * mechanics and why). Per SANDBOX, like the chat's tab snapshot — a path names a file in one sandbox's /work,
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
 * next page load — a restored diff would quietly display a comparison that is no longer true. The Changes and
 * Checkpoints panels re-open a live one in a click. Every other kind restores from identity alone (a path, a
 * dir, a repo) or, for a plan, from the small markdown it already carries. */
export type StoredWorkspaceTab = Exclude<WorkspaceTab, { kind: "diff" }>;

// A plan preview past this size is dropped rather than truncated: half a plan restored as if it were whole is
// worse than a tab the user re-opens from the chat message that proposed it — and one oversized blob must not
// cost them the rest of the strip when the write hits the quota.
const MAX_PLAN_TEXT = 64_000;

export interface WorkspaceTabStrip {
    // Which tab is focused, or null — a legitimate state, not a missing value: closing the last tab leaves the
    // strip empty, and a bare /workspace URL deselects a file tab while its neighbours stay open.
    readonly active: string | null;
    readonly tabs: readonly StoredWorkspaceTab[];
}

// Every field that NAMES something is required and non-empty — an entry missing one names nothing this build
// can reopen. The exceptions are `dir` and a document's `path`: the /work root is a directory like any other
// and its path is the empty string, so those two are plain strings.
const named = z.string().min(1);

const StoredTabSchema: z.ZodType<StoredWorkspaceTab> = z.discriminatedUnion(`kind`, [
    z.object({ kind: z.literal(`file`), id: named, path: named }),
    z.object({ kind: z.literal(`directory`), id: named, dir: z.string() }),
    z.object({ kind: z.literal(`health`), id: named, repo: named }),
    /* An extension's document. Restored on identity + the strip's own label, never on the provider being back:
     * extensions activate after this is read, and one that has since been switched off should still leave the
     * tab where the user left it — it renders its own "no longer available" rather than vanishing silently. */
    z.object({ kind: z.literal(`document`), id: named, extension: named, provider: named, path: z.string(), title: named, icon: named }),
    z.object({ kind: z.literal(`plan`), id: named, title: named, text: named.max(MAX_PLAN_TEXT) }),
]);

// Parse one stored blob into a coherent strip: readable tabs only (an unreadable one is skipped rather than
// fatal — it must not cost the user every other file they had open), each id once (a duplicate would render as
// two tabs sharing a key), and a focus that names one of them.
const parseStrip = (raw: string): WorkspaceTabStrip | undefined => {
    let stored: { active?: unknown; tabs?: unknown };
    try {
        stored = JSON.parse(raw) as { active?: unknown; tabs?: unknown };
    } catch {
        return undefined;
    }
    if (!Array.isArray(stored.tabs)) {
        return undefined;
    }
    const seen = new Set<string>();
    const tabs: StoredWorkspaceTab[] = [];
    for (const entry of stored.tabs) {
        const tab = StoredTabSchema.safeParse(entry).data;
        if (tab !== undefined && !seen.has(tab.id)) {
            seen.add(tab.id);
            tabs.push(tab);
        }
    }
    if (tabs.length === 0) {
        return undefined;
    }
    return { active: typeof stored.active === `string` && seen.has(stored.active) ? stored.active : null, tabs };
};

// This window's editor tabs for a sandbox, else the last window's (the seed) when this one has never opened it.
export const readTabStrip = (sandboxId: string | undefined): WorkspaceTabStrip | undefined =>
    sandboxId === undefined ? undefined : readWindowState(tabsKey(sandboxId), parseStrip);

// Persist this window's strip. Takes the serialized snapshot because the caller watches that string: it is what
// makes "anything about any tab changed" a single cheap comparison, so re-serializing here would only repeat it.
export const writeTabStrip = (sandboxId: string, json: string): void => {
    writeWindowState(tabsKey(sandboxId), json);
};
