import { computed, ref, watch } from "vue";
import { documentTabId } from "../../../core-views/documentRegistry";
import type { DiffPayload } from "@intentic/extension-api";
import {
    closeTabs,
    diffTabId,
    type EditorPane,
    type EditorStrip,
    emptyPane,
    emptyStrip,
    type LineJump,
    moveTab,
    type OpenMode,
    otherPane,
    type PaneState,
    paneOf,
    placeTab,
    type WorkspaceTab,
} from "./workspaceTabs";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { useEditBuffers } from "../files/useEditBuffers";
import { readTabStrip, type StoredWorkspaceTab, writeTabStrip } from "../changes/workspaceSnapshot";

// Workspace editor's open tabs, a module-level singleton (like useChat/useLayout) surviving navigation between
// areas. The editor is two panes; `tabs`, `activeId`, `activeTab` and `previewId` are the focused pane's, so most
// readers get one answer to what's on screen. Only EditorPane and the desktop layout read the strip itself.

// Open items in tab order (file, diff, or generated surface); a pane's `active` is its focused tab's id.
const strip = ref<EditorStrip>(emptyStrip());
// Which pane the keyboard and untargeted opens act on; not persisted, a reload always comes back on main.
const focused = ref<EditorPane>(`main`);
// Whether a split may open at all; false on a phone or a pane too narrow, set by the layout surface.
const splitAllowed = ref(false);
// Line to scroll to from a search match, cleared on a plain open; seq++ makes a repeat click re-trigger too.
const openLine = ref<LineJump | undefined>(undefined);
let jumpSeq = 0;

const pane = (which: EditorPane): PaneState => strip.value[which];
const setPane = (which: EditorPane, next: PaneState): void => {
    strip.value = { ...strip.value, [which]: next };
};

// The focused pane's strip, which is what everything outside this view means by "the tabs".
const tabs = computed<readonly WorkspaceTab[]>(() => pane(focused.value).tabs);
// Writable: useWorkspaceRoute clears it when a bare /workspace URL deselects the open file.
const activeId = computed<string | null>({
    get: () => pane(focused.value).active,
    set: (value) => setPane(focused.value, { ...pane(focused.value), active: value }),
});
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value));
// Preview slot: id of the tab only being looked at, or null; otherwise an ordinary tab, and it survives reload.
// One slot per pane, so a companion-pane peek can't evict the document it opened from.
const previewId = computed<string | null>(() => pane(focused.value).preview);
// Split is open exactly while the side pane holds tabs; no separate flag to drift out of sync.
const splitOpen = computed(() => strip.value.side.tabs.length > 0);

// --- Tab persistence ---------------------------------------------------------------------------
// Strip restores per sandbox on reload. Sandbox id is captured at restore, not read live at write, since
// activeSandboxId can flip before sandboxScope re-scopes this state and misfile a write.
let scopedSandboxId: string | undefined;
const { activeSandboxId } = useSandbox();

const restoreTabs = (): void => {
    scopedSandboxId = activeSandboxId.value;
    const stored = readTabStrip(scopedSandboxId);
    strip.value = {
        main: stored === undefined ? emptyPane() : { tabs: stored.tabs, active: stored.active, preview: stored.preview },
        side:
            stored?.side === undefined ? emptyPane() : { tabs: stored.side.tabs, active: stored.side.active, preview: stored.side.preview },
    };
    focused.value = `main`;
    openLine.value = undefined;
};
restoreTabs();

// Re-scopes to the incoming sandbox: a path names a file in one sandbox's /work, so the outgoing tabs would
// open nothing here.
export const resetWorkspaceTabs = (): void => {
    restoreTabs();
};

// Persists every tab but a diff. Focus on a diff falls to its last surviving neighbour (closeTabs' own rule);
// focus on nothing stays nothing. The preview slot survives only if the tab it names does.
const persistedPane = (state: PaneState): { active: string | null; preview: string | null; tabs: readonly StoredWorkspaceTab[] } => {
    const persistable = state.tabs.filter((tab): tab is StoredWorkspaceTab => tab.kind !== `diff`);
    const focus = persistable.find((tab) => tab.id === state.active);
    return {
        active: state.active === null ? null : (focus?.id ?? persistable.at(-1)?.id ?? null),
        preview: persistable.find((tab) => tab.id === state.preview)?.id ?? null,
        tabs: persistable,
    };
};

// Side pane is stored only if something in it would restore; a companion holding just a diff comes back as
// no split.
const persistedStrip = (): string => {
    const main = persistedPane(strip.value.main);
    const side = persistedPane(strip.value.side);
    return JSON.stringify(side.tabs.length === 0 ? main : { ...main, side });
};
watch(persistedStrip, (json) => {
    if (scopedSandboxId !== undefined) {
        writeTabStrip(scopedSandboxId, json);
    }
});

// Promotes the preview tab to ordinary, VSCode's double-click gesture. Named by id since only the pane holding
// that tab gives up its slot.
const keepTab = (id: string): void => {
    const which = paneOf(strip.value, id);
    if (which !== undefined && pane(which).preview === id) {
        setPane(which, { ...pane(which), preview: null });
    }
};

// Editing a previewed file promotes it, the third promotion gesture beside the double-click. Without it, the
// next peek would replace the tab and discard-prompt an edit the user never asked to open.
const { dirtyPaths, forget } = useEditBuffers();
watch(dirtyPaths, (dirty) => {
    for (const which of [`main`, `side`] as const) {
        const previewed = pane(which).tabs.find((tab) => tab.id === pane(which).preview);
        if (previewed?.kind === `file` && dirty.has(previewed.path)) {
            setPane(which, { ...pane(which), preview: null });
        }
    }
});

// Called before the strip is rewritten; a replaced file tab loses its edit buffer, or stale text would overwrite
// the newer file on save. An edited preview already left the slot, so unsaved work is never touched here.
const releasePreview = (which: EditorPane, incomingId: string): void => {
    const outgoing = pane(which).tabs.find((tab) => tab.id === pane(which).preview);
    if (outgoing?.kind === `file` && outgoing.id !== incomingId) {
        forget(outgoing.path);
    }
};

// Places a tab in a pane and focuses it, in whichever mode the gesture meant. The one path every opener goes
// through, so slot, focus and pane always update together.
const place = (which: EditorPane, tab: WorkspaceTab, mode: OpenMode): void => {
    const open = pane(which).tabs.some((existing) => existing.id === tab.id);
    if (mode === `preview` && !open) {
        releasePreview(which, tab.id);
    }
    // Already-open tab is only refreshed and focused, keeping its standing; `keep` releases the slot via keepTab.
    const next = placeTab(pane(which).tabs, tab, mode === `preview` && !open ? pane(which).preview : null);
    setPane(which, { tabs: next, active: tab.id, preview: mode === `preview` && !open ? tab.id : pane(which).preview });
    focused.value = which;
    openLine.value = undefined;
};

// Opens a file per the gesture: an explorer click peeks (preview slot), a double-click/deep-link/chat jump keeps.
// An already-open file is only focused where it is, never demoted or duplicated across panes.
const openFile = (path: string, mode: OpenMode = `keep`, target?: EditorPane): void => {
    const which = target ?? paneOf(strip.value, path) ?? focused.value;
    place(which, { kind: `file`, id: path, path }, mode);
    if (mode === `keep`) {
        keepTab(path);
    }
};

const openAtLine = (path: string, line: number, mode: OpenMode = `keep`): void => {
    openFile(path, mode);
    openLine.value = { line, seq: ++jumpSeq };
};

// Changed-file diff opens or refreshes in place, never stacking a duplicate. A row click previews, replacing the
// prior preview; a deliberate open (double-click, extension, workspace-open) keeps and releases the slot.
const diffTab = (payload: DiffPayload): WorkspaceTab => ({
    kind: `diff`,
    id: diffTabId(payload.key, payload.scope, payload.path),
    label: payload.label,
    status: payload.status,
    path: payload.path,
    before: payload.before,
    after: payload.after,
    binary: payload.binary,
    partial: payload.partial,
    beforeRaw: payload.beforeRaw,
    afterRaw: payload.afterRaw,
    additions: payload.additions,
    deletions: payload.deletions,
    pending: payload.pending,
});

// A diff from a document tab (e.g. a commit's file list) opens in the other pane so the list stays visible;
// anything else opens where the reader is, keyed on the active tab, not the caller.
const diffPane = (): EditorPane => {
    if (!splitAllowed.value) {
        return focused.value;
    }
    const active = tabs.value.find((tab) => tab.id === activeId.value);
    return active?.kind === `document` ? otherPane(focused.value) : focused.value;
};

const openDiff = (payload: DiffPayload, mode: OpenMode): void => {
    const tab = diffTab(payload);
    const which = paneOf(strip.value, tab.id) ?? diffPane();
    place(which, tab, mode);
    if (mode === `keep`) {
        keepTab(tab.id);
    }
};

// Fills the tab already holding a pending diff's place; never opens, or a late answer would steal the preview
// slot the reader has since moved to. Dropped silently if the tab is gone; active tab and preview stay untouched.
const fillDiff = (payload: DiffPayload): void => {
    const tab = diffTab(payload);
    const which = paneOf(strip.value, tab.id);
    if (which === undefined) {
        return;
    }
    const open = pane(which).tabs.findIndex((existing) => existing.id === tab.id);
    setPane(which, { ...pane(which), tabs: pane(which).tabs.with(open, tab) });
};

// Directory tab opens/focuses by dir path (DirectoryOperator surface), so re-selecting never stacks a duplicate.
const openDirectory = (dir: string): void => {
    const id = `dir:${dir}`;
    place(paneOf(strip.value, id) ?? focused.value, { kind: `directory`, id, dir }, `keep`);
};

// Health-report tab opens/focuses by repo, like openDirectory: re-opening never stacks a duplicate.
const openHealth = (repo: string): void => {
    const id = `health:${repo}`;
    place(paneOf(strip.value, id) ?? focused.value, { kind: `health`, id, repo }, `keep`);
};

// Document tab keyed by extension+provider+path (two providers on one directory get separate tabs). Title/icon
// are copied onto the tab, not looked up live, so a restored tab keeps its label if the extension never reactivates.
const openDocument = (extension: string, provider: string, path: string, title: string, icon: string): void => {
    const id = documentTabId(extension, provider, path);
    // Refreshed in place when already open: title can move under it (renamed package, published draft).
    place(paneOf(strip.value, id) ?? focused.value, { kind: `document`, id, extension, provider, path, title, icon }, `keep`);
};

// Selecting a tab focuses its pane: the strip clicked is the strip the keyboard acts on next.
const selectTab = (id: string): void => {
    const which = paneOf(strip.value, id);
    if (which === undefined) {
        return;
    }
    openLine.value = undefined;
    focused.value = which;
    setPane(which, { ...pane(which), active: id });
};

// --- The split ---------------------------------------------------------------------------------
const focusPane = (which: EditorPane): void => {
    if (strip.value[which].tabs.length > 0) {
        focused.value = which;
    }
};

// "Open to the Side": explicit split for pairings the store can't guess (a README beside its code, two files
// compared by eye).
const openToSide = (id?: string): void => {
    const target = id ?? activeId.value;
    if (target === null || target === undefined || !splitAllowed.value) {
        return;
    }
    const from = paneOf(strip.value, target);
    if (from === undefined) {
        return;
    }
    const moved = moveTab(strip.value, target, otherPane(from));
    strip.value = moved.strip;
    focused.value = moved.focused;
};

// Folds the companion pane into main, keeping every tab: triggered when room for two panes goes away (chat opens,
// window narrows). Closing them instead would lose the reader's place for an unrelated reason.
const collapseSplit = (): void => {
    if (strip.value.side.tabs.length === 0) {
        return;
    }
    const active = strip.value.side.active;
    let next = strip.value;
    for (const tab of strip.value.side.tabs) {
        next = moveTab(next, tab.id, `main`).strip;
    }
    strip.value = { main: { ...next.main, active: active ?? next.main.active }, side: emptyPane() };
    focused.value = `main`;
};

// --- Reopen closed tab -------------------------------------------------------------------------
// Undo stack: one entry per close, not per tab, so a bulk close undoes as one unit, in order and position.
// In-memory and bounded: a diff's full content is never persisted, so a reload starts with no history.
const MAX_CLOSED = 20;

interface TabClose {
    // In strip order, each with the pane and position it held at close time.
    readonly entries: readonly { readonly tab: WorkspaceTab; readonly pane: EditorPane; readonly index: number }[];
    readonly focus: string;
}

const closedTabs = ref<readonly TabClose[]>([]);

// Closes tabs, remembering them for reopenClosedTab; returns paths whose edit buffers the caller should forget.
const closeTabIds = (ids: ReadonlySet<string>): readonly string[] => {
    const active = activeId.value;
    const entries = ([`main`, `side`] as const).flatMap((which) =>
        strip.value[which].tabs.flatMap((tab, index) => (ids.has(tab.id) ? [{ tab, pane: which, index }] : [])),
    );
    const last = entries.at(-1);
    if (last !== undefined) {
        // The closed tab that held the focus, else the rightmost of the group (what the strip fell back to).
        const focus = entries.find(({ tab }) => tab.id === active)?.tab.id ?? last.tab.id;
        closedTabs.value = [...closedTabs.value, { entries, focus }].slice(-MAX_CLOSED);
    }
    const result = closeTabs(strip.value, focused.value, ids);
    strip.value = result.strip;
    focused.value = result.focused;
    return result.forgetPaths;
};

// Undoes the last close: each tab returns to its own pane and old position, focused as it was. A tab already
// reopened by other means is left alone, but the entry still leaves the stack, the keystroke still landed.
const reopenClosedTab = (): void => {
    const last = closedTabs.value.at(-1);
    if (last === undefined) {
        return;
    }
    closedTabs.value = closedTabs.value.slice(0, -1);
    openLine.value = undefined;
    const next: Record<EditorPane, WorkspaceTab[]> = { main: [...strip.value.main.tabs], side: [...strip.value.side.tabs] };
    for (const entry of last.entries) {
        // A pane no longer allowed (window narrowed since close) folds back into main instead of reopening a split.
        const which = entry.pane === `side` && !splitAllowed.value ? `main` : entry.pane;
        if (!next.main.some((open) => open.id === entry.tab.id) && !next.side.some((open) => open.id === entry.tab.id)) {
            // The strip may have shrunk since the close, so the remembered index can point past its end, clamp.
            next[which].splice(Math.min(entry.index, next[which].length), 0, entry.tab);
        }
    }
    strip.value = {
        main: { ...strip.value.main, tabs: next.main },
        side: { ...strip.value.side, tabs: next.side },
    };
    const home = paneOf(strip.value, last.focus);
    if (home !== undefined) {
        selectTab(last.focus);
    }
};

export function useWorkspaceTabs() {
    return {
        tabs,
        activeId,
        activeTab,
        openLine,
        previewId,
        openFile,
        openAtLine,
        openDiff,
        fillDiff,
        openDirectory,
        openHealth,
        openDocument,
        selectTab,
        keepTab,
        closedTabs,
        closeTabIds,
        reopenClosedTab,
        // The split: read by the two components that draw panes, written by the gestures that open one.
        strip,
        focusedPane: focused,
        splitOpen,
        splitAllowed,
        focusPane,
        openToSide,
        collapseSplit,
    };
}
