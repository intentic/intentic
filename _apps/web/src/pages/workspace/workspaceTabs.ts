import type { GitChange, SnapshotChange } from "@intentic-app/api-contract";

/* Open items in the Workspace editor area. A tab is a filesystem file (the path is its identity), a diff
 * (a synthetic id per diff source + file), or a chat plan preview (a synthetic id per conversation).
 * useWorkspaceTabs owns the list + active id; FileTabs.vue renders it; the Changes and History panels emit
 * diff payloads that Workspace.vue turns into diff tabs; the chat pushes plan previews in via
 * useWorkspaceTabs.openPlan. A `directory` tab is a repository's management surface (DirectoryOperator); a
 * `graph` tab is one repo's git-history graph (GitGraph.vue) — a wide document, so it lives here in the main
 * area (not the narrow sidebar), the same division VSCode makes between its SCM list and the Git Graph tab.
 * A `health` tab is the third per-repo document: its codebase-health report (CodebaseHealth.vue). */

// A snapshot's parent-vs-snapshot statuses plus the working tree's (which adds "renamed").
export type ChangeStatus = SnapshotChange["status"] | GitChange["status"];

// A jump to a line in the open file (a content-search match). `seq` makes every jump a fresh identity, so
// re-clicking the SAME hit after scrolling away still re-reveals — a bare line number couldn't re-fire.
export interface LineJump {
    readonly line: number;
    readonly seq: number;
}

// A binary diff ships no text, so its two sides ride the tab as the daemon URLs their BYTES are fetched from
// (see diffRaw.ts) — the panel that opened the tab is the one that knows which diff source the row came from.
// An absent url means that side does not exist (an added file has no before).
export interface DiffRawSides {
    readonly beforeRaw?: string;
    readonly afterRaw?: string;
}

export type WorkspaceTab =
    | { readonly kind: "file"; readonly id: string; readonly path: string }
    | {
          readonly kind: "diff";
          readonly id: string;
          readonly label: string;
          readonly status: ChangeStatus;
          readonly path: string;
          readonly before?: string;
          readonly after?: string;
          readonly binary?: boolean;
          readonly truncated?: boolean;
          readonly beforeRaw?: string;
          readonly afterRaw?: string;
      }
    | { readonly kind: "plan"; readonly id: string; readonly title: string; readonly text: string }
    | { readonly kind: "directory"; readonly id: string; readonly dir: string }
    | { readonly kind: "graph"; readonly id: string; readonly repo: string }
    | { readonly kind: "health"; readonly id: string; readonly repo: string };

// What the Changes/History panels hand up when a changed file is clicked; Workspace derives the diff tab's id
// from it. `key` is the diff source's identity: a snapshot id, or `working:<repo>` for an uncommitted change.
export interface DiffTabPayload extends DiffRawSides {
    readonly key: string;
    readonly scope: string;
    readonly label: string;
    readonly status: ChangeStatus;
    readonly path: string;
    readonly before?: string;
    readonly after?: string;
    readonly binary?: boolean;
    readonly truncated?: boolean;
}

export const diffTabId = (key: string, scope: string, path: string): string => `diff:${key}:${scope}/${path}`;

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

// `!` for a conflict, git's own porcelain letter being `U` — but `U` next to `M`/`A`/`D` reads as one more
// flavour of change, and a conflict is a stop sign. Danger-coloured for the same reason.
export const STATUS_LETTER: Record<ChangeStatus, string> = {
    added: `A`,
    modified: `M`,
    deleted: `D`,
    renamed: `R`,
    "type-changed": `T`,
    conflicted: `!`,
};
export const STATUS_CLASS: Record<ChangeStatus, string> = {
    added: `text-success`,
    modified: `text-warning`,
    deleted: `text-danger`,
    renamed: `text-muted`,
    "type-changed": `text-muted`,
    conflicted: `text-danger`,
};
