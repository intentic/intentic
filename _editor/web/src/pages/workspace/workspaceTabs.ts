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

/* How an open treats the strip. `keep` is an ordinary tab — the user asked for it and it stays until they close
 * it. `preview` is the strip's single transient slot (VSCode's italic tab), for a look-at-this gesture like
 * clicking a row in Changes: the NEXT preview takes its place, so reading through twenty changed files leaves
 * one tab behind instead of twenty nobody meant to keep. Double-clicking promotes a preview to `keep`. */
export type OpenMode = "keep" | "preview";

// Where a newly opened tab lands. One that is already open is refreshed in place — a diff's content moves on
// between two looks, and re-opening must never stack a second tab for the same id. Otherwise it takes the
// position of the tab it replaces (the outgoing preview, so the slot stays put), or the end of the strip.
export const placeTab = (tabs: readonly WorkspaceTab[], tab: WorkspaceTab, replaceId: string | null): readonly WorkspaceTab[] => {
    const open = tabs.findIndex((existing) => existing.id === tab.id);
    if (open !== -1) {
        return tabs.with(open, tab);
    }
    const slot = replaceId === null ? -1 : tabs.findIndex((existing) => existing.id === replaceId);
    return slot === -1 ? [...tabs, tab] : tabs.with(slot, tab);
};

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
