import type { SnapshotChange } from "@intentic-app/api-contract";

/* Open items in the Workspace editor area. A tab is a filesystem file (the path is its identity), a
 * snapshot diff (a synthetic id per snapshot+file), or a chat plan preview (a synthetic id per conversation).
 * useWorkspaceTabs owns the list + active id; FileTabs.vue renders it; HistoryPanel.vue emits diff payloads
 * that Workspace.vue turns into diff tabs; the chat pushes plan previews in via useWorkspaceTabs.openPlan. A
 * `directory` tab is a repository's management surface (DirectoryOperator), opened from the tree. */

export type WorkspaceTab =
    | { readonly kind: "file"; readonly id: string; readonly path: string }
    | {
          readonly kind: "diff";
          readonly id: string;
          readonly label: string;
          readonly status: SnapshotChange["status"];
          readonly path: string;
          readonly before?: string;
          readonly after?: string;
          readonly binary?: boolean;
          readonly truncated?: boolean;
      }
    | { readonly kind: "plan"; readonly id: string; readonly title: string; readonly text: string }
    | { readonly kind: "directory"; readonly id: string; readonly dir: string };

// What HistoryPanel hands up when a changed file is clicked; Workspace derives the diff tab's id from it.
export interface DiffTabPayload {
    readonly snapshotId: string;
    readonly scope: string;
    readonly label: string;
    readonly status: SnapshotChange["status"];
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
    readonly binary?: boolean;
    readonly truncated?: boolean;
}

export const diffTabId = (snapshotId: string, scope: string, path: string): string => `diff:${snapshotId}:${scope}/${path}`;

// Close a set of tabs (single ×, "Close Others", "Close to the Right", "Close All"). Drops the closed tabs, reports
// which file paths need their edit buffer forgotten, and only re-picks the active tab when it was one of the closed
// ones — falling back to the last remaining tab (VSCode behaviour), or null when nothing is left.
export const closeTabs = (
    tabs: readonly WorkspaceTab[],
    activeId: string | null,
    close: ReadonlySet<string>,
): { nextTabs: readonly WorkspaceTab[]; nextActiveId: string | null; forgetPaths: readonly string[] } => {
    const nextTabs = tabs.filter((tab) => !close.has(tab.id));
    const forgetPaths = tabs.flatMap((tab) => (close.has(tab.id) && tab.kind === `file` ? [tab.path] : []));
    const nextActiveId = activeId !== null && close.has(activeId) ? (nextTabs.at(-1)?.id ?? null) : activeId;
    return { nextTabs, nextActiveId, forgetPaths };
};

export const STATUS_LETTER: Record<SnapshotChange["status"], string> = { added: `A`, modified: `M`, deleted: `D`, "type-changed": `T` };
export const STATUS_CLASS: Record<SnapshotChange["status"], string> = {
    added: `text-success`,
    modified: `text-warning`,
    deleted: `text-danger`,
    "type-changed": `text-muted`,
};
