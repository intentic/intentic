import { computed, ref } from "vue";
import { type DiffTabPayload, diffTabId, type LineJump, type WorkspaceTab } from "../../pages/workspace/workspaceTabs";

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

// A changed file from the Changes or History panel opens as a diff tab in the main area. Re-opening the same
// source's file refreshes its content in place rather than stacking a duplicate tab.
const openDiff = (payload: DiffTabPayload): void => {
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
    };
    openLine.value = undefined;
    tabs.value = tabs.value.some((existing) => existing.id === id)
        ? tabs.value.map((existing) => (existing.id === id ? tab : existing))
        : [...tabs.value, tab];
    activeId.value = id;
};

// A plan the chat agent proposed opens as a rendered markdown preview (Claude Code VSCode style). One preview
// per chat conversation: a revised plan (after "keep planning") refreshes the same tab in place, openDiff-style.
const openPlan = (conversationId: string, title: string, text: string): void => {
    const id = `plan:${conversationId}`;
    const tab: WorkspaceTab = { kind: `plan`, id, title, text };
    openLine.value = undefined;
    tabs.value = tabs.value.some((existing) => existing.id === id)
        ? tabs.value.map((existing) => (existing.id === id ? tab : existing))
        : [...tabs.value, tab];
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

// One repo's git-history graph opens as a document tab in the main area (VSCode "Git Graph"-style), scoped to
// "root" (the /work repo) or a nested repo's dir. Open-or-focus by repo, like openDirectory — re-opening the
// same repo's graph focuses its tab rather than stacking a duplicate.
const openGraph = (repo: string): void => {
    const id = `graph:${repo}`;
    openLine.value = undefined;
    activeId.value = id;
    if (!tabs.value.some((tab) => tab.id === id)) {
        tabs.value = [...tabs.value, { kind: `graph`, id, repo }];
    }
};

const selectTab = (id: string): void => {
    openLine.value = undefined;
    activeId.value = id;
};

export function useWorkspaceTabs() {
    return { tabs, activeId, activeTab, openLine, openFile, openAtLine, openDiff, openPlan, openDirectory, openGraph, selectTab };
}
