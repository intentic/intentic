import type { DiffPayload } from "@intentic/extension-api";

/* Open items in the Workspace editor area. A tab is a filesystem file (the path is its identity), a diff
 * (a synthetic id per diff source + file), or a chat plan preview (a synthetic id per conversation).
 * useWorkspaceTabs owns the list + active id; FileTabs.vue renders it; the Changes and History panels emit
 * diff payloads that Workspace.vue turns into diff tabs; the chat pushes plan previews in via
 * useWorkspaceTabs.openPlan. A `directory` tab is a repository's management surface (DirectoryOperator); a
 * `health` tab is one repo's codebase-health report (CodebaseHealth.vue). A `document` tab is the open-ended
 * one: whatever an extension's document provider has to say about a DIRECTORY — its architecture page, its git
 * history — rendered by that provider beside the code it explains rather than in a routed area away from it;
 * see core-views/documentRegistry.ts. */

// A jump to a line in the open file (a content-search match). `seq` makes every jump a fresh identity, so
// re-clicking the SAME hit after scrolling away still re-reveals — a bare line number couldn't re-fire.
export interface LineJump {
    readonly line: number;
    readonly seq: number;
}

export type WorkspaceTab =
    | { readonly kind: "file"; readonly id: string; readonly path: string }
    // Everything a diff payload carries except the two fields that only exist to BUILD the identity — `id` is
    // what `key` + `scope` + `path` resolve to (see diffTabId), so keeping them beside it would be two spellings
    // of the same fact.
    | ({ readonly kind: "diff"; readonly id: string } & Omit<DiffPayload, "key" | "scope">)
    | { readonly kind: "plan"; readonly id: string; readonly title: string; readonly text: string }
    | { readonly kind: "directory"; readonly id: string; readonly dir: string }
    | { readonly kind: "health"; readonly id: string; readonly repo: string }
    | {
          readonly kind: "document";
          readonly id: string;
          // Which provider renders it: the owning extension's id + its provider id (documentRegistry).
          readonly extension: string;
          readonly provider: string;
          // The directory the document explains, root-relative ("" = the workspace root).
          readonly path: string;
          // The strip draws itself from these rather than from the provider, so a restored tab has a name and a
          // glyph before its extension has activated — and still has them if that extension never comes back.
          readonly title: string;
          readonly icon: string;
      };

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
