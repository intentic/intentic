import { computed, ref, watch } from "vue";
import { documentTabId } from "../../core-views/documentRegistry";
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
} from "../../pages/workspace/workspaceTabs";
import { useSandbox } from "../sandbox/useSandbox";
import { useEditBuffers } from "./useEditBuffers";
import { readTabStrip, type StoredWorkspaceTab, writeTabStrip } from "./workspaceSnapshot";

/* The Workspace editor area's open tabs, as a module-level singleton (like useChat/useLayout), so they survive
 * navigation between areas. Workspace.vue layers the close orchestration (dirty confirm, edit-buffer forget,
 * context menu) on top of these refs.
 *
 * THE EDITOR IS TWO PANES (see EditorStrip), and almost nothing outside this file has to know it. `tabs`,
 * `activeId`, `activeTab` and `previewId` are the FOCUSED pane's, so the chat's context chip, Quick Open, the
 * URL mirror and the phone all keep asking their one question, "what is the user looking at", and keep getting
 * one answer. Only the two components that DRAW panes (EditorPane, and the desktop that lays them out) read the
 * strip itself. */

// Open items, in tab order, a filesystem file, snapshot diff, or generated workspace surface (see workspaceTabs.ts).
// Clicking opens/focuses its tab; a pane's `active` is its focused tab's id (a file's path, or a synthetic
// surface id).
const strip = ref<EditorStrip>(emptyStrip());
// Which pane the keyboard and every un-targeted open act on. Not persisted: a session comes back on its main
// pane, which is where the tabs that survive a reload are.
const focused = ref<EditorPane>(`main`);
/* WHETHER A SPLIT MAY BE OPENED AT ALL, set by the surface that draws the panes: false on a phone (no tab strip
 * to split) and on a workspace pane too narrow to hold two readable columns. Openers consult it rather than
 * asking the layout themselves, so this store stays free of geometry. */
const splitAllowed = ref(false);
// The line the viewer should scroll to, set by a content-search match, cleared on any plain open/tab switch.
// Every jump is a NEW object (seq++), so the viewer reacts even when the same hit is clicked again.
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
/* The strip's preview slot: the id of the tab that is only being LOOKED at (see OpenMode), or null. At most one
 * per pane exists, the next preview takes its place, and nothing else about it is special, it is an ordinary tab
 * that happens to be transient, so closing, cycling and the context menu all still act on it as they do on any
 * other. It survives a reload with the strip: a peek that came back pinned would be the one tab the user never
 * asked for, growing the strip by one on every session.
 *
 * One slot PER PANE, because a peek in the companion pane must not evict the document it was opened from: the
 * whole point of the split is that the graph stays put while the diffs beside it come and go. */
const previewId = computed<string | null>(() => pane(focused.value).preview);
// A split is open exactly while the side pane holds something: there is no separate "split" flag to fall out of
// step with the tabs (see normalizeStrip).
const splitOpen = computed(() => strip.value.side.tabs.length > 0);

// --- Tab persistence ---------------------------------------------------------------------------
/* The strip is where the user left off, so it comes back per sandbox on a reload (workspaceSnapshot holds the
 * shape and what a diff tab costs to store). Only the URL used to survive, which restored the ONE active file
 * and dropped every other tab the session had accumulated.
 *
 * Which sandbox the tabs belong to is recorded at restore rather than read live at write time, for the reason
 * useChat's snapshot documents: activeSandboxId flips one flush before sandboxScope re-scopes this state, and a
 * write in that window would file the outgoing sandbox's paths under the incoming sandbox's key. */
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

// Re-scope to the incoming sandbox (see sandboxScope), a path names a file in ONE sandbox's /work, so the
// outgoing sandbox's tabs would open nothing here. Its own strip takes their place.
export const resetWorkspaceTabs = (): void => {
    restoreTabs();
};

// What one pane persists: every tab but a diff, and a focus that survives the cut, one focused on a diff comes
// back on its last surviving neighbour (the rule closeTabs already uses for a closed tab), while one focused on
// nothing (a bare /workspace, where mobile browses folders) stays that way. The preview slot only survives when
// the tab holding it does: a previewed DIFF is not stored at all, so its slot has nothing to name.
const persistedPane = (state: PaneState): { active: string | null; preview: string | null; tabs: readonly StoredWorkspaceTab[] } => {
    const persistable = state.tabs.filter((tab): tab is StoredWorkspaceTab => tab.kind !== `diff`);
    const focus = persistable.find((tab) => tab.id === state.active);
    return {
        active: state.active === null ? null : (focus?.id ?? persistable.at(-1)?.id ?? null),
        preview: persistable.find((tab) => tab.id === state.preview)?.id ?? null,
        tabs: persistable,
    };
};

// The side pane is stored only when something in it would come back: a companion pane holding one diff (the
// common case) restores as no split at all, which is honest, the diff it held is not restorable either.
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

// Promote the preview tab into an ordinary one, the double-click VSCode uses, on the tab or on the row that
// opened it. Named by id because the gesture lands on a tab, and only the pane holding that tab gives its slot up.
const keepTab = (id: string): void => {
    const which = paneOf(strip.value, id);
    if (which !== undefined && pane(which).preview === id) {
        setPane(which, { ...pane(which), preview: null });
    }
};

/* Typing into a previewed file keeps it, VSCode's third promotion gesture beside the double-click and the menu.
 * It is the one that matters most: a preview tab is replaced by the next file looked at, so without this the
 * user's own edit would be what the next peek closed, and they would have to answer a discard prompt about a
 * file they never chose to open as more than a glance. */
const { dirtyPaths, forget } = useEditBuffers();
watch(dirtyPaths, (dirty) => {
    for (const which of [`main`, `side`] as const) {
        const previewed = pane(which).tabs.find((tab) => tab.id === pane(which).preview);
        if (previewed?.kind === `file` && dirty.has(previewed.path)) {
            setPane(which, { ...pane(which), preview: null });
        }
    }
});

/* Handing the slot to a new tab, called BEFORE the strip is rewritten. The tab in the slot is not closed, it is
 * REPLACED in place (placeTab puts the newcomer at its index), and a replaced file tab has to give up what a
 * closed one gives up: its edit buffer. Left behind, that buffer stands in for the file's real contents the next
 * time it is opened, the editor seeds from the buffer first, so a file peeked at, changed on disk by an agent,
 * and peeked at again would come back as the stale text, and saving would write it over the newer file.
 *
 * Never drops unsaved work: an edited preview has already left the slot (the dirty watch above), so the tab
 * being replaced here is by construction one nobody has typed into. */
const releasePreview = (which: EditorPane, incomingId: string): void => {
    const outgoing = pane(which).tabs.find((tab) => tab.id === pane(which).preview);
    if (outgoing?.kind === `file` && outgoing.id !== incomingId) {
        forget(outgoing.path);
    }
};

// Put a tab in a pane and focus it, in whichever of the two modes the gesture meant. The one path every opener
// below goes through, so the preview slot, the focus and the pane can never be updated by three different halves
// of three different verbs.
const place = (which: EditorPane, tab: WorkspaceTab, mode: OpenMode): void => {
    const open = pane(which).tabs.some((existing) => existing.id === tab.id);
    if (mode === `preview` && !open) {
        releasePreview(which, tab.id);
    }
    // A tab that is ALREADY open is only focused and refreshed: it keeps whatever standing it had, so peeking at
    // something the reader deliberately kept never demotes it, and peeking twice at the same row never promotes
    // it either. The `keep` gestures release the slot explicitly, through keepTab.
    const next = placeTab(pane(which).tabs, tab, mode === `preview` && !open ? pane(which).preview : null);
    setPane(which, { tabs: next, active: tab.id, preview: mode === `preview` && !open ? tab.id : pane(which).preview });
    focused.value = which;
    openLine.value = undefined;
};

/* Opening a file, in whichever of the two modes the GESTURE meant (see OpenMode), a click in the explorer is a
 * peek that takes the preview slot, a double-click, a deep link or a jump from the chat asks to keep.
 *
 * A file that is ALREADY open is only focused, in whichever pane has it: it keeps whatever standing it had, so
 * peeking at a file the user deliberately kept never demotes that tab back into the transient slot, and a file
 * open in the companion pane is not opened a second time in the pane the click came from. */
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

/* A changed file from the Changes or History panel opens as a diff tab in the main area. Re-opening the same
 * source's file refreshes its content in place rather than stacking a duplicate tab.
 *
 * Reviewing is the reading gesture the strip could not survive: a click per changed file left a tab per changed
 * file, all of them pinned by a look. So a row click opens in `preview` mode, the previous preview gives up
 * its place to this one, and the deliberate gestures (a double-click, an extension, "open in workspace") ask
 * to `keep`, which also releases the slot when the tab holding it is the one being kept. */
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

/* WHERE A DIFF LANDS, and the one rule that makes reading a commit bearable: a diff asked for BY A DOCUMENT
 * goes in the other pane.
 *
 * A document tab is a whole surface with its own list of files, a commit's changed files in the git graph, a
 * package's architecture page, and clicking a row in one used to replace the very list that was clicked. So the
 * diff opens beside it, the list stays on screen, and the next row replaces the diff rather than the document.
 * Everything else (a row in Changes, a search hit, an extension acting on its own) opens where the reader is,
 * because those lists live in the sidebar and were never covered up.
 *
 * Deliberately keyed on the ACTIVE TAB rather than on who called: the second file clicked arrives with the
 * companion pane focused and a diff active, which is not a document, so it lands right where the first one did. */
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

/* The second half of a `pending` open: the content arrived, so put it in the tab that is holding its place.
 *
 * REFRESHES, NEVER OPENS, that distinction is the whole reason this is a separate verb rather than a second
 * openDiff. Reading down a change list outruns the network, and a plain re-open of a late answer would take the
 * preview slot away from whatever the reader has moved on to: click file A, click file B, and A's content lands
 * to find B in the slot it was going to be placed in. So a tab that has since been closed, replaced or scrolled
 * out of the strip takes nothing, and the answer is simply dropped, the cache kept it anyway, so going back to
 * that file paints instantly rather than re-reading.
 *
 * It touches neither the active tab nor the preview slot for the same reason: filling a tab is not a gesture the
 * user made, and stealing the focus back to a file they have already moved on from would be the loudest possible
 * way to say "your click was slow". */
const fillDiff = (payload: DiffPayload): void => {
    const tab = diffTab(payload);
    const which = paneOf(strip.value, tab.id);
    if (which === undefined) {
        return;
    }
    const open = pane(which).tabs.findIndex((existing) => existing.id === tab.id);
    setPane(which, { ...pane(which), tabs: pane(which).tabs.with(open, tab) });
};

// A repository directory opened from the tree renders its management surface (DirectoryOperator) in the main
// area as a tab, open-or-focus by dir path, so re-selecting the same directory doesn't stack duplicates.
const openDirectory = (dir: string): void => {
    const id = `dir:${dir}`;
    place(paneOf(strip.value, id) ?? focused.value, { kind: `directory`, id, dir }, `keep`);
};

// One repo's codebase-health report, its hotspots and key modules. Open-or-focus by repo, like openDirectory:
// re-opening the same repo's report focuses its tab rather than stacking a duplicate.
const openHealth = (repo: string): void => {
    const id = `health:${repo}`;
    place(paneOf(strip.value, id) ?? focused.value, { kind: `health`, id, repo }, `keep`);
};

/* A directory's document, contributed by an extension (documentRegistry) and opened from the row that offers it.
 * Open-or-focus by provider + path, so re-clicking the same folder's icon focuses the tab it already has, but
 * two providers explaining the SAME directory get a tab each, which is why the id carries both.
 *
 * Title and icon are copied onto the tab rather than looked up on render: the strip has to draw a restored tab
 * before the owning extension has activated, and must not lose its label if that extension never comes back. */
const openDocument = (extension: string, provider: string, path: string, title: string, icon: string): void => {
    const id = documentTabId(extension, provider, path);
    // Refreshed in place when it is already open: the offer's title can move under it (a package renamed, a draft
    // published), and the tab should say what the row says.
    place(paneOf(strip.value, id) ?? focused.value, { kind: `document`, id, extension, provider, path, title, icon }, `keep`);
};

// Selecting a tab focuses its own pane: the strip a click landed in is the strip the keyboard should act on next.
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

// "Open to the Side" (and the command behind it): the explicit way into a split, for the pairings this store
// cannot guess, a README beside the code it describes, two files compared by eye.
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

/* Fold the companion pane back into the main one, keeping every tab it held. Two callers, and both are the same
 * event: the room for two panes went away (the chat opened, the window narrowed). Closing those tabs instead
 * would lose the reader's place for a reason that has nothing to do with them. */
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
/* The strip's undo stack. One entry per CLOSE, not per tab: a single × pushes one tab, and a bulk close (Close
 * Others / to the Right / All) pushes its whole set as one entry, so the keystroke undoes the action the user
 * took rather than dribbling tabs back one press at a time. Each tab carries the pane and index it held, and a
 * group re-inserts left to right, so the strip comes back in its old ORDER, restoring at the end would leave the
 * user hunting for the tab they just recovered. `focus` is the tab that had the focus when it went away, so an
 * undone close also gives the editor back.
 *
 * In memory only, and bounded: a diff tab carries both sides of its file as content, so an unbounded stack
 * would hold megabytes of text the user already dismissed, and persisting it would grow the very blob the
 * strip's snapshot keeps small on purpose. A reload starts with the tabs that survived and no history. */
const MAX_CLOSED = 20;

interface TabClose {
    // In strip order, each with the pane and position it held at close time.
    readonly entries: readonly { readonly tab: WorkspaceTab; readonly pane: EditorPane; readonly index: number }[];
    readonly focus: string;
}

const closedTabs = ref<readonly TabClose[]>([]);

// Close a set of tabs, remembering them for reopenClosedTab. Returns the paths whose edit buffers the caller
// should forget, the one part of a close this store has no business doing (see useEditBuffers).
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

// Undo the last close: every tab it removed comes back in its own pane at its old position, focused as it was. A
// tab that is open again by other means (the user re-clicked the file) is left where it is, and the entry still
// leaves the stack either way, the keystroke landed.
const reopenClosedTab = (): void => {
    const last = closedTabs.value.at(-1);
    if (last === undefined) {
        return;
    }
    closedTabs.value = closedTabs.value.slice(0, -1);
    openLine.value = undefined;
    const next: Record<EditorPane, WorkspaceTab[]> = { main: [...strip.value.main.tabs], side: [...strip.value.side.tabs] };
    for (const entry of last.entries) {
        // A pane that may no longer be allowed (the window narrowed since the close) folds back into main rather
        // than reopening a split the surface cannot draw.
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
