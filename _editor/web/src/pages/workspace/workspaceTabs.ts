import type { DiffPayload } from "@intentic/extension-api";

/* Open items in the Workspace editor area. A tab is a filesystem file (the path is its identity) or a diff
 * (a synthetic id per diff source + file).
 * useWorkspaceTabs owns the list + active id; FileTabs.vue renders it; the Changes and History panels emit
 * diff payloads that Workspace.vue turns into diff tabs. A `directory` tab is a repository's management surface
 * (DirectoryOperator); a `health` tab is one repo's codebase-health report (CodebaseHealth.vue). A `document` tab is the open-ended
 * one: whatever an extension's document provider has to say about a DIRECTORY, its architecture page, its git
 * history, rendered by that provider beside the code it explains rather than in a routed area away from it;
 * see core-views/documentRegistry.ts. */

// A jump to a line in the open file (a content-search match). `seq` makes every jump a fresh identity, so
// re-clicking the SAME hit after scrolling away still re-reveals, a bare line number couldn't re-fire.
export interface LineJump {
    readonly line: number;
    readonly seq: number;
}

export type WorkspaceTab =
    | { readonly kind: "file"; readonly id: string; readonly path: string }
    // Everything a diff payload carries except the two fields that only exist to BUILD the identity, `id` is
    // what `key` + `scope` + `path` resolve to (see diffTabId), so keeping them beside it would be two spellings
    // of the same fact.
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
          // The strip draws itself from these rather than from the provider, so a restored tab has a name and a
          // glyph before its extension has activated, and still has them if that extension never comes back.
          readonly title: string;
          readonly icon: string;
      };

export const diffTabId = (key: string, scope: string, path: string): string => `diff:${key}:${scope}/${path}`;

/* THE EDITOR AREA IS TWO PANES, and it is two rather than N on purpose. The reading this exists for is one
 * document beside one file: a commit's changed-file list beside the diff it names, a README beside the code it
 * describes. A third column in the workspace pane (which already gives width to the explorer, and often to the
 * chat) is narrower than either half of a diff needs, so the split is a pair and the seam between them is the
 * only geometry there is.
 *
 * `side` is the companion. It exists only while it holds tabs: emptying it is how the split closes, and nothing
 * else has to remember that a split was ever open. */
export type EditorPane = "main" | "side";

export const otherPane = (pane: EditorPane): EditorPane => (pane === `main` ? `side` : `main`);

// One pane's strip: its tabs in order, which of them is focused, and which one is merely being looked at (see
// OpenMode). Each pane has a preview slot of its OWN: a peek in the companion pane must not replace the
// document the reader is peeking FROM.
export interface PaneState {
    readonly tabs: readonly WorkspaceTab[];
    readonly active: string | null;
    readonly preview: string | null;
}

export type EditorStrip = Record<EditorPane, PaneState>;

export const emptyPane = (): PaneState => ({ tabs: [], active: null, preview: null });
export const emptyStrip = (): EditorStrip => ({ main: emptyPane(), side: emptyPane() });

/* THE SPLIT HAS NO EMPTY HALF. Two rules, both of which exist so a pane can never sit there as a blank column
 * with a × the reader has to find:
 *
 *   the side empties  → the split is simply over, and the focus goes back to the pane that is left;
 *   the main empties  → the side takes its place (VSCode collapses the group the same way), rather than leaving
 *                       an empty column on the left of the thing being read.
 *
 * Applied after every close and every move, so no caller has to remember either one. */
export const normalizeStrip = (strip: EditorStrip, focused: EditorPane): { strip: EditorStrip; focused: EditorPane } => {
    if (strip.side.tabs.length === 0) {
        return { strip: { main: strip.main, side: emptyPane() }, focused: `main` };
    }
    if (strip.main.tabs.length === 0) {
        return { strip: { main: strip.side, side: emptyPane() }, focused: `main` };
    }
    return { strip, focused };
};

// Drop a set of ids from one pane. The active id only moves when it was one of the closed ones, falling back to
// the last remaining tab (VSCode behaviour); a closed preview gives up the slot.
const closeInPane = (pane: PaneState, close: ReadonlySet<string>): PaneState => {
    const tabs = pane.tabs.filter((tab) => !close.has(tab.id));
    return {
        tabs,
        active: pane.active !== null && close.has(pane.active) ? (tabs.at(-1)?.id ?? null) : pane.active,
        preview: pane.preview !== null && close.has(pane.preview) ? null : pane.preview,
    };
};

// Close a set of tabs across BOTH panes (a single ×, "Close Others", "Close to the Right", "Close All"), then
// normalize. Also reports which file paths need their edit buffer forgotten, the one part of a close the model
// has no business doing (see useEditBuffers).
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

/* Send a tab to the other pane ("Open to the Side", and the command behind it). It is a MOVE, not a copy: one
 * tab per id in the whole editor keeps every id-keyed thing in this view (the edit buffer, the diff stat, the
 * reveal) about one place on screen.
 *
 * The moved tab arrives focused and kept: asking for it in the other pane is a deliberate gesture, so it must
 * not land in a slot the next peek would take. */
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

/* How an open treats the strip, decided by the GESTURE, not by the caller's opinion of the file.
 *
 * `preview` is the strip's single transient slot (VSCode's italic tab), for a look-at-this: a click in the
 * explorer, a search hit, a row in Changes. The NEXT preview takes its place, so reading through twenty files
 * leaves one tab behind instead of twenty nobody meant to keep.
 *
 * `keep` is an ordinary tab, the user asked for THIS file and it stays until they close it. Three gestures ask:
 * a double-click (on the row or on the tab), the tab menu's Keep Open, and typing into a previewed file. So does
 * every arrival from outside the explorer, a deep link, a file mention in the chat, Quick Open, because none of
 * those is browsing, and VSCode keeps those too. */
export type OpenMode = "keep" | "preview";

// Where a newly opened tab lands. One that is already open is refreshed in place, a diff's content moves on
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

