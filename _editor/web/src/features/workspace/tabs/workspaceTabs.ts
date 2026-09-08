import type { DiffPayload } from "@intentic/extension-api";

// Open items in the Workspace editor area, rendered by FileTabs.vue and owned by useWorkspaceTabs (list + active id):
// file → the path is its identity.
// diff → a synthetic id per diff source + file, built from a Changes/History payload.
// directory → a repository's management surface (DirectoryOperator).
// health → one repo's codebase-health report (CodebaseHealth.vue).
// document → open-ended: whatever an extension's document provider says about a directory (architecture, git
// history), rendered beside the code it explains (documentRegistry.ts).

// Jump to a line in the open file, from a content-search match. `seq` gives every jump a fresh identity, so
// re-clicking the same hit still re-reveals it.
export interface LineJump {
    readonly line: number;
    readonly seq: number;
}

export type WorkspaceTab =
    | { readonly kind: "file"; readonly id: string; readonly path: string }
    // Diff payload minus `key`/`scope`: `id` already resolves them (diffTabId); keeping both duplicates one fact.
    | ({ readonly kind: "diff"; readonly id: string } & Omit<DiffPayload, "key" | "scope">)
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
          // Copied onto the tab, not read from the provider, so a restored tab has a label before activation.
          readonly title: string;
          readonly icon: string;
      };

export const diffTabId = (key: string, scope: string, path: string): string => `diff:${key}:${scope}/${path}`;

// Two panes, not N: this exists for one document beside one file, and a third column would be narrower than
// either needs. `side` exists only while it holds tabs; emptying it is how a split closes.
export type EditorPane = "main" | "side";

export const otherPane = (pane: EditorPane): EditorPane => (pane === `main` ? `side` : `main`);

// One pane's strip: tabs in order, the focused one, and the one merely being looked at. Each pane owns its
// preview slot, so a companion-pane peek can't replace the document it was opened from.
export interface PaneState {
    readonly tabs: readonly WorkspaceTab[];
    readonly active: string | null;
    readonly preview: string | null;
}

export type EditorStrip = Record<EditorPane, PaneState>;

export const emptyPane = (): PaneState => ({ tabs: [], active: null, preview: null });
export const emptyStrip = (): EditorStrip => ({ main: emptyPane(), side: emptyPane() });

// The split has no empty half. Applied after every close and every move, so no caller has to remember either rule:
// side empties → the split is over; focus returns to the remaining pane.
// main empties → the side takes its place (VSCode collapses the group the same way).
export const normalizeStrip = (strip: EditorStrip, focused: EditorPane): { strip: EditorStrip; focused: EditorPane } => {
    if (strip.side.tabs.length === 0) {
        return { strip: { main: strip.main, side: emptyPane() }, focused: `main` };
    }
    if (strip.main.tabs.length === 0) {
        return { strip: { main: strip.side, side: emptyPane() }, focused: `main` };
    }
    return { strip, focused };
};

// Drops ids from one pane. Active only moves if it was closed, falling back to the last remaining tab (VSCode);
// a closed preview gives up its slot.
const closeInPane = (pane: PaneState, close: ReadonlySet<string>): PaneState => {
    const tabs = pane.tabs.filter((tab) => !close.has(tab.id));
    return {
        tabs,
        active: pane.active !== null && close.has(pane.active) ? (tabs.at(-1)?.id ?? null) : pane.active,
        preview: pane.preview !== null && close.has(pane.preview) ? null : pane.preview,
    };
};

// Closes tabs across both panes (a single ×, Close Others/Right/All), then normalizes. Also reports file paths
// whose edit buffer needs forgetting.
export const closeTabs = (
    strip: EditorStrip,
    focused: EditorPane,
    close: ReadonlySet<string>,
): { strip: EditorStrip; focused: EditorPane; forgetPaths: readonly string[] } => {
    const forgetPaths = [...strip.main.tabs, ...strip.side.tabs].flatMap((tab) => (close.has(tab.id) && tab.kind === `file` ? [tab.path] : []));
    const closed = { main: closeInPane(strip.main, close), side: closeInPane(strip.side, close) };
    return { ...normalizeStrip(closed, focused), forgetPaths };
};

// Which pane holds a tab, or undefined when nothing does (it was closed while a menu was open).
export const paneOf = (strip: EditorStrip, id: string): EditorPane | undefined => {
    if (strip.main.tabs.some((tab) => tab.id === id)) {
        return `main`;
    }
    return strip.side.tabs.some((tab) => tab.id === id) ? `side` : undefined;
};

// Sends a tab to the other pane ("Open to the Side"). A move, not a copy: one tab per id keeps every id-keyed
// thing (edit buffer, diff stat, reveal) tied to one place. Arrives focused and kept, never into the preview slot.
export const moveTab = (strip: EditorStrip, id: string, to: EditorPane): { strip: EditorStrip; focused: EditorPane } => {
    const from = paneOf(strip, id);
    if (from === undefined || from === to) {
        return { strip, focused: to };
    }
    const tab = strip[from].tabs.find((candidate) => candidate.id === id);
    if (tab === undefined) {
        return { strip, focused: to };
    }
    const source = closeInPane(strip[from], new Set([id]));
    const target = strip[to];
    const moved: EditorStrip = {
        ...strip,
        [from]: source,
        [to]: { tabs: [...target.tabs.filter((candidate) => candidate.id !== id), tab], active: id, preview: target.preview },
    };
    return normalizeStrip(moved, to);
};

// By gesture, not the file: `preview` is one transient slot (italic tab) the next look replaces; `keep` is an
// ordinary tab, from a double-click, Keep Open, an edit, or any non-explorer arrival.
export type OpenMode = "keep" | "preview";

// Where a newly opened tab lands: an already-open id is refreshed in place, never stacked twice. Otherwise it
// takes the replaced tab's position (the outgoing preview, so the slot stays put) or the end of the strip.
export const placeTab = (tabs: readonly WorkspaceTab[], tab: WorkspaceTab, replaceId: string | null): readonly WorkspaceTab[] => {
    const open = tabs.findIndex((existing) => existing.id === tab.id);
    if (open !== -1) {
        return tabs.with(open, tab);
    }
    const slot = replaceId === null ? -1 : tabs.findIndex((existing) => existing.id === replaceId);
    return slot === -1 ? [...tabs, tab] : tabs.with(slot, tab);
};

