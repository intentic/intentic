import { computed, ref, watch } from "vue";
import { documentTabId } from "../../core-views/documentRegistry";
import type { DiffPayload } from "@intentic/extension-api";
import { closeTabs, diffTabId, type LineJump, type OpenMode, placeTab, type WorkspaceTab } from "../../pages/workspace/workspaceTabs";
import { useSandbox } from "../sandbox/useSandbox";
import { readTabStrip, type StoredWorkspaceTab, writeTabStrip } from "./workspaceSnapshot";

/* The Workspace editor area's open tabs, as a module-level singleton (like useChat/useLayout): the chat panel
 * lives in the persistent shell and pushes plan previews in from outside the Workspace subtree, and the open
 * tabs survive navigation between areas. Workspace.vue layers the close orchestration (dirty confirm,
 * edit-buffer forget, context menu) on top of these refs. */

// Open items, in tab order — a filesystem file, a snapshot diff, or a plan preview (see workspaceTabs.ts).
// Clicking opens/focuses its tab; `activeId` is the focused tab's id (a file's path, or a synthetic
// diff/plan id).
const tabs = ref<readonly WorkspaceTab[]>([]);
const activeId = ref<string | null>(null);
const activeTab = computed(() => tabs.value.find((tab) => tab.id === activeId.value));
// The line the viewer should scroll to — set by a content-search match, cleared on any plain open/tab switch.
// Every jump is a NEW object (seq++), so the viewer reacts even when the same hit is clicked again.
const openLine = ref<LineJump | undefined>(undefined);
let jumpSeq = 0;
/* The strip's preview slot: the id of the tab that is only being LOOKED at (see OpenMode), or null. At most one
 * exists, the next preview takes its place, and nothing else about it is special — it is an ordinary tab that
 * happens to be transient, so closing, cycling and the context menu all still act on it as they do on any
 * other. Never persisted: a restored strip is the tabs the user chose to keep. */
const previewId = ref<string | null>(null);

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
    tabs.value = stored?.tabs ?? [];
    activeId.value = stored?.active ?? null;
    openLine.value = undefined;
    previewId.value = null;
};
restoreTabs();

// Re-scope to the incoming sandbox (see sandboxScope) — a path names a file in ONE sandbox's /work, so the
// outgoing sandbox's tabs would open nothing here. Its own strip takes their place.
export const resetWorkspaceTabs = (): void => {
    restoreTabs();
};

// What the strip persists: every tab but a diff, and a focus that survives the cut — one focused on a diff
// comes back on its last surviving neighbour (the rule closeTabs already uses for a closed tab), while one
// focused on nothing (a bare /workspace, where mobile browses folders) stays that way.
const persistedStrip = (): string => {
    const persistable = tabs.value.filter((tab): tab is StoredWorkspaceTab => tab.kind !== `diff`);
    const focused = persistable.find((tab) => tab.id === activeId.value);
    return JSON.stringify({
        active: activeId.value === null ? null : (focused?.id ?? persistable.at(-1)?.id ?? null),
        tabs: persistable,
    });
};
watch(persistedStrip, (json) => {
    if (scopedSandboxId !== undefined) {
        writeTabStrip(scopedSandboxId, json);
    }
});

const openFile = (path: string): void => {
    openLine.value = undefined;
    activeId.value = path;
    if (!tabs.value.some((tab) => tab.id === path)) {
        tabs.value = [...tabs.value, { kind: `file`, id: path, path }];
    }
};

const openAtLine = (path: string, line: number): void => {
    openFile(path);
    openLine.value = { line, seq: ++jumpSeq };
};

// Promote the preview tab into an ordinary one — the double-click VSCode uses, on the tab or on the row that
// opened it. Named by id because the gesture lands on a tab, and only the tab holding the slot gives it up.
const keepTab = (id: string): void => {
    if (previewId.value === id) {
        previewId.value = null;
    }
};

/* A changed file from the Changes or History panel opens as a diff tab in the main area. Re-opening the same
 * source's file refreshes its content in place rather than stacking a duplicate tab.
 *
 * Reviewing is the reading gesture the strip could not survive: a click per changed file left a tab per changed
 * file, all of them pinned by a look. So a row click opens in `preview` mode — the previous preview gives up
 * its place to this one — and the deliberate gestures (a double-click, an extension, "open in workspace") ask
 * to `keep`, which also releases the slot when the tab holding it is the one being kept. */
const openDiff = (payload: DiffPayload, mode: OpenMode): void => {
    const id = diffTabId(payload.key, payload.scope, payload.path);
    const tab: WorkspaceTab = {
        kind: `diff`,
        id,
        label: payload.label,
        status: payload.status,
        path: payload.path,
        before: payload.before,
        after: payload.after,
        binary: payload.binary,
        truncated: payload.truncated,
        beforeRaw: payload.beforeRaw,
        afterRaw: payload.afterRaw,
        additions: payload.additions,
        deletions: payload.deletions,
    };
    openLine.value = undefined;
    tabs.value = placeTab(tabs.value, tab, mode === `preview` ? previewId.value : null);
    activeId.value = id;
    if (mode === `preview`) {
        previewId.value = id;
        return;
    }
    keepTab(id);
};

// A plan the chat agent proposed opens as a rendered markdown preview (Claude Code VSCode style). One preview
// per chat conversation: a revised plan (after "keep planning") refreshes the same tab in place, openDiff-style.
const openPlan = (conversationId: string, title: string, text: string): void => {
    const id = `plan:${conversationId}`;
    const tab: WorkspaceTab = { kind: `plan`, id, title, text };
    openLine.value = undefined;
    tabs.value = placeTab(tabs.value, tab, null);
    activeId.value = id;
};

// A repository directory opened from the tree renders its management surface (DirectoryOperator) in the main
// area as a tab — open-or-focus by dir path, so re-selecting the same directory doesn't stack duplicates.
const openDirectory = (dir: string): void => {
    const id = `dir:${dir}`;
    openLine.value = undefined;
    activeId.value = id;
    if (!tabs.value.some((tab) => tab.id === id)) {
        tabs.value = [...tabs.value, { kind: `directory`, id, dir }];
    }
};

// One repo's codebase-health report — its hotspots and key modules. Open-or-focus by repo, like openDirectory:
// re-opening the same repo's report focuses its tab rather than stacking a duplicate.
const openHealth = (repo: string): void => {
    const id = `health:${repo}`;
    openLine.value = undefined;
    activeId.value = id;
    if (!tabs.value.some((tab) => tab.id === id)) {
        tabs.value = [...tabs.value, { kind: `health`, id, repo }];
    }
};

/* A directory's document, contributed by an extension (documentRegistry) and opened from the row that offers it.
 * Open-or-focus by provider + path, so re-clicking the same folder's icon focuses the tab it already has — but
 * two providers explaining the SAME directory get a tab each, which is why the id carries both.
 *
 * Title and icon are copied onto the tab rather than looked up on render: the strip has to draw a restored tab
 * before the owning extension has activated, and must not lose its label if that extension never comes back. */
const openDocument = (extension: string, provider: string, path: string, title: string, icon: string): void => {
    const id = documentTabId(extension, provider, path);
    const tab: WorkspaceTab = { kind: `document`, id, extension, provider, path, title, icon };
    openLine.value = undefined;
    // Refreshed in place when it is already open: the offer's title can move under it (a package renamed, a draft
    // published), and the tab should say what the row says.
    tabs.value = placeTab(tabs.value, tab, null);
    activeId.value = id;
};

const selectTab = (id: string): void => {
    openLine.value = undefined;
    activeId.value = id;
};

// --- Reopen closed tab -------------------------------------------------------------------------
/* The strip's undo stack. One entry per CLOSE, not per tab: a single × pushes one tab, and a bulk close (Close
 * Others / to the Right / All) pushes its whole set as one entry, so the keystroke undoes the action the user
 * took rather than dribbling tabs back one press at a time. Each tab carries the index it held, and a group
 * re-inserts left to right, so the strip comes back in its old ORDER — restoring at the end would leave the
 * user hunting for the tab they just recovered. `focus` is the tab that had the focus when it went away, so an
 * undone close also gives the editor back.
 *
 * In memory only, and bounded: a diff tab carries both sides of its file as content, so an unbounded stack
 * would hold megabytes of text the user already dismissed, and persisting it would grow the very blob the
 * strip's snapshot keeps small on purpose. A reload starts with the tabs that survived and no history. */
const MAX_CLOSED = 20;

interface TabClose {
    // In strip order, each with the position it held at close time.
    readonly entries: readonly { readonly tab: WorkspaceTab; readonly index: number }[];
    readonly focus: string;
}

const closedTabs = ref<readonly TabClose[]>([]);

// Close a set of tabs, remembering them for reopenClosedTab. Returns the paths whose edit buffers the caller
// should forget — the one part of a close this store has no business doing (see useEditBuffers).
const closeTabIds = (ids: ReadonlySet<string>): readonly string[] => {
    const { nextTabs, nextActiveId, forgetPaths } = closeTabs(tabs.value, activeId.value, ids);
    const entries = tabs.value.flatMap((tab, index) => (ids.has(tab.id) ? [{ tab, index }] : []));
    const last = entries.at(-1);
    if (last !== undefined) {
        // The closed tab that held the focus, else the rightmost of the group (what the strip fell back to).
        const focus = entries.find(({ tab }) => tab.id === activeId.value)?.tab.id ?? last.tab.id;
        closedTabs.value = [...closedTabs.value, { entries, focus }].slice(-MAX_CLOSED);
    }
    tabs.value = nextTabs;
    activeId.value = nextActiveId;
    if (previewId.value !== null && ids.has(previewId.value)) {
        previewId.value = null;
    }
    return forgetPaths;
};

// Undo the last close: every tab it removed comes back at its old position, focused as it was. A tab that is
// open again by other means (the user re-clicked the file) is left where it is, and the entry still leaves the
// stack either way — the keystroke landed.
const reopenClosedTab = (): void => {
    const last = closedTabs.value.at(-1);
    if (last === undefined) {
        return;
    }
    closedTabs.value = closedTabs.value.slice(0, -1);
    openLine.value = undefined;
    const next = [...tabs.value];
    for (const { tab, index } of last.entries) {
        if (!next.some((open) => open.id === tab.id)) {
            // The strip may have shrunk since the close, so the remembered index can point past its end — clamp.
            next.splice(Math.min(index, next.length), 0, tab);
        }
    }
    tabs.value = next;
    activeId.value = last.focus;
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
        openPlan,
        openDirectory,
        openHealth,
        openDocument,
        selectTab,
        keepTab,
        closedTabs,
        closeTabIds,
        reopenClosedTab,
    };
}
