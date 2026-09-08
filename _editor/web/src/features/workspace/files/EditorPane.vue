<script setup lang="ts">
import { STATE_DIR } from "@intentic/constants";
import { ui, useLoadingReveal } from "@intentic/ui";
import { computed, provide } from "vue";
import { useDiffStat } from "../changes/useDiffStat";
import { useWorkspaceTabs } from "../tabs/useWorkspaceTabs";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import ExtensionDocument from "../../../core-views/ExtensionDocument.vue";
import CodebaseHealth from "../health/CodebaseHealth.vue";
import DirectoryOperator from "../directory-ui/DirectoryOperator.vue";
import DirectoryUiHost from "../directory-ui/DirectoryUiHost.vue";
import FileBreadcrumb from "../explorer/FileBreadcrumb.vue";
import FileTabs from "../tabs/FileTabs.vue";
import DiffSkeleton from "../viewers/DiffSkeleton.vue";
import DiffToolbar from "../viewers/DiffToolbar.vue";
import FileDiffPane from "../viewers/FileDiffPane.vue";
import FileViewer from "../viewers/FileViewer.vue";
import WorkspaceEmptyState from "../explorer/WorkspaceEmptyState.vue";
import WorkspaceScopeGone from "../explorer/WorkspaceScopeGone.vue";
import type { EditorPane } from "../tabs/workspaceTabs";
import { CHROME_SCOPE, contextTarget } from "./viewerChrome";

// One editor pane: a tab strip, the open file's context, and whatever the active tab renders. The desktop lays out two
// (EditorStrip), so a commit's list and diff no longer fight for the same pane. Owns only what's per-pane;
// workspace-wide facts arrive as slots.

const { pane, broken = false, empty = false } = defineProps<{ pane: EditorPane; broken?: boolean; empty?: boolean }>();

const emit = defineEmits<{
    select: [id: string];
    keep: [id: string];
    close: [id: string];
    contextmenu: [id: string | undefined, event: Event];
    pick: [];
}>();

const { strip, focusedPane, openLine, openFile, openHealth, focusPane, collapseSplit } = useWorkspaceTabs();
const { entry } = useWorkspaceTree();

// Teleport seats are named after this pane, so the companion's breadcrumb can't land in the wrong one.
provide(CHROME_SCOPE, pane);

const state = computed(() => strip.value[pane]);
const activeTab = computed(() => state.value.tabs.find((tab) => tab.id === state.value.active));
const focused = computed(() => focusedPane.value === pane);
// Line jump belongs to the pane the click came from; only the focused pane gets it.
const line = computed(() => (focused.value ? openLine.value : undefined));

const activeFile = computed(() => (activeTab.value?.kind === `file` ? activeTab.value : undefined));
const openPath = computed(() => activeFile.value?.path);
const openMeta = computed(() => entry(openPath.value));

// A directory declares its UI at <dir>/.intentic/ui/index.html; opening it renders the sandboxed UI, not raw HTML.
// undefined means a normal file; the owning dir is root-relative ("" = /work root).
const UI_INDEX = `${STATE_DIR}/ui/index.html`;
const directoryUiDir = computed<string | undefined>(() => {
    const path = openPath.value;
    if (path === undefined) {
        return undefined;
    }
    if (path === UI_INDEX) {
        return ``;
    }
    return path.endsWith(`/${UI_INDEX}`) ? path.slice(0, -(UI_INDEX.length + 1)) : undefined;
});

// What the open diff shows once its comments are stripped, for the bar above it (useDiffStat).
const { stat: diffStat, onStat: setDiffStat } = useDiffStat(computed(() => activeTab.value?.id));
// Gap between clicking a changed file and its content arriving; decides only whether the panes below deserve an outline
// skeleton. A warmed or cached diff lands in the same tick, so usually not.
const diffPending = computed(() => activeTab.value?.kind === `diff` && activeTab.value.pending === true);
const diffOutline = useLoadingReveal(
    diffPending,
    computed(() => activeTab.value?.id ?? ``),
);
</script>

<template>
    <!--
        Focus follows the pointer into a pane; commands (Close Tab, cycle, open-to-side) act on whichever pane had it last. `focusin` covers tabbing
        in, which no pointer event sees.
    -->
    <section
        class="ws-pane relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
        :class="{ 'ws-pane-off': !focused && strip.side.tabs.length > 0 }"
        @pointerdown="focusPane(pane)"
        @focusin="focusPane(pane)"
    >
        <!--
            The pane's one bar: left slot, open tabs, the file's own context, right slot. Always rendered, so controls survive zero open tabs; the
            breadcrumb and other controls arrive here by teleport (viewerChrome).
        -->
        <div class="view-header flex items-stretch border-b border-line bg-card">
            <slot name="lead" />
            <FileTabs
                :tabs="state.tabs"
                :active="state.active"
                :preview="state.preview"
                @select="emit('select', $event)"
                @keep="emit('keep', $event)"
                @close="emit('close', $event)"
                @contextmenu="(id, event) => emit('contextmenu', id, event)"
            />
            <!--
                Where the file's breadcrumb and viewer controls land. Ruled off from the tabs (a clipped last tab would otherwise read as broken
                text) and capped at 45% of the row, since navigating other files matters more.
            -->
            <div :id="contextTarget(pane)" class="ws-context flex min-w-0 max-w-[45%] shrink items-center gap-2"></div>
            <slot name="status" />
            <!--
                Companion pane's own close, where a reader who opened a split looks for it. The main pane has none: closing it means closing its
                tabs.
            -->
            <button
                v-if="pane === 'side'"
                type="button"
                :class="ui.iconButton(`mx-1 h-7 w-7 shrink-0 self-center`)"
                @click="collapseSplit()"
                v-tooltip.bottom="'Close the split · these tabs move back into one pane'"
                aria-label="Close the split"
            >
                <Icon name="split-columns" class="text-xs" />
            </button>
        </div>
        <!-- Scope names a checkout that no longer exists; pre-empts every branch below rather than letting each fail separately. -->
        <WorkspaceScopeGone v-if="broken" />
        <template v-else-if="activeFile">
            <!-- FileViewer renders its own breadcrumb (with edit actions); the directory UI gets a bare one. -->
            <FileBreadcrumb v-if="directoryUiDir !== undefined" :path="activeFile.path" :meta="openMeta" />
            <div class="min-h-0 flex-1">
                <DirectoryUiHost v-if="directoryUiDir !== undefined" :dir="directoryUiDir" />
                <FileViewer v-else :path="activeFile.path" :meta="openMeta" :line="line" @gone="emit('close', $event)" />
            </div>
        </template>
        <!--
            Tab strip names the file; this bar says how it's being read (side-by-side/inline, comments in/out), the same bar agent review uses. Sits
            above every diff state, so even a binary or oversized diff keeps its controls.
        -->
        <template v-else-if="activeTab?.kind === 'diff'">
            <DiffToolbar
                :path="activeTab.label"
                :status="activeTab.status"
                :code="diffStat"
                :additions="activeTab.additions"
                :deletions="activeTab.deletions"
            />
            <div class="min-h-0 flex-1">
                <!--
                    Still loading; whether the file is binary isn't known yet, so this branch comes first and the viewer mounts once, with content,
                    never remounted.
                -->
                <template v-if="activeTab.pending"><DiffSkeleton v-if="diffOutline" /></template>
                <!-- Bytes, a patch, or two whole sides: FileDiffPane decides, shared with the two other surfaces rendering this diff. -->
                <FileDiffPane
                    v-else
                    :key="activeTab.id"
                    :path="activeTab.path"
                    :before="activeTab.before"
                    :after="activeTab.after"
                    :binary="activeTab.binary"
                    :partial="activeTab.partial"
                    :before-raw="activeTab.beforeRaw"
                    :after-raw="activeTab.afterRaw"
                    @stat="setDiffStat"
                />
            </div>
        </template>
        <div v-else-if="activeTab?.kind === 'directory'" class="min-h-0 flex-1">
            <DirectoryOperator :dir="activeTab.dir" />
        </div>
        <div v-else-if="activeTab?.kind === 'health'" class="min-h-0 flex-1">
            <!-- Every ranked row is an anchor: clicking one opens the file it names. -->
            <CodebaseHealth :repo="activeTab.repo" @open-file="openFile" @switch-repo="openHealth" />
        </div>
        <!-- A directory's document, rendered by whichever extension has something to say about it. -->
        <div v-else-if="activeTab?.kind === 'document'" class="min-h-0 flex-1">
            <ExtensionDocument :extension="activeTab.extension" :provider="activeTab.provider" :path="activeTab.path" :title="activeTab.title" />
        </div>
        <!--
            `empty` picks the silence: nothing in the workspace gets every way in, between files gets just the drop target. Gated on the tree having
            loaded, so a full workspace never flashes the newcomer's screen first.
        -->
        <WorkspaceEmptyState v-else :empty="empty" @pick="emit('pick')" />
    </section>
</template>

<style scoped>
/*
 * Which pane the keyboard is in: dims the bar of the one not listening, rather than ringing the one that is (a ring
 * would read as a diff selection).
 */
.ws-pane-off .view-header {
    opacity: 0.75;
}

/*
 * `:empty` (not a v-if) draws the rule only when the teleported seat is filled, since this component can't know that
 * itself. Matches a tab's own right divider, so a clipped last tab still reads as a strip, not broken text.
 */
.ws-context:not(:empty) {
    border-left: 1px solid var(--color-line);
    padding-left: 0.5rem;
}
</style>
