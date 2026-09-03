<script setup lang="ts">
import { STATE_DIR } from "@intentic/constants";
import { ui, useLoadingReveal } from "@intentic/ui";
import { computed, provide } from "vue";
import { useDiffStat } from "../../composables/workspace/useDiffStat";
import { useWorkspaceTabs } from "../../composables/workspace/useWorkspaceTabs";
import { useWorkspaceTree } from "../../composables/workspace/useWorkspaceTree";
import ExtensionDocument from "../../core-views/ExtensionDocument.vue";
import CodebaseHealth from "./CodebaseHealth.vue";
import DirectoryOperator from "./DirectoryOperator.vue";
import DirectoryUiHost from "./DirectoryUiHost.vue";
import FileBreadcrumb from "./FileBreadcrumb.vue";
import FileTabs from "./FileTabs.vue";
import DiffSkeleton from "./viewers/DiffSkeleton.vue";
import DiffToolbar from "./viewers/DiffToolbar.vue";
import FileDiffPane from "./viewers/FileDiffPane.vue";
import FileViewer from "./viewers/FileViewer.vue";
import WorkspaceEmptyState from "./WorkspaceEmptyState.vue";
import WorkspaceScopeGone from "./WorkspaceScopeGone.vue";
import type { EditorPane } from "./workspaceTabs";
import { CHROME_SCOPE, contextTarget } from "./viewerChrome";

/* ONE EDITOR PANE: a tab strip, the open file's context beside it, and whatever that tab renders.
 *
 * It exists because the editor area is two of these (see EditorStrip). Reading a commit is a list and a diff,
 * and in a single pane they take turns: every file clicked in the git graph replaced the graph that named it.
 * So the pane is a component, the desktop lays out two of them, and the store decides which one an open lands
 * in. Everything ABOUT THE WORKSPACE rather than about a pane, the explorer toggle, the tree's spinner, the
 * scope chip, is handed in as slots by the surface that owns those facts.
 *
 * The pane owns nothing but what is per-pane: which of its tabs is active (read from the store by pane), the
 * diff stat of the diff IT is showing, and the seat its viewer's chrome teleports into. */

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

// The two teleport seats in this pane's bar are named after it, so the companion pane's breadcrumb cannot land
// above the main pane's file (see CHROME_SCOPE).
provide(CHROME_SCOPE, pane);

const state = computed(() => strip.value[pane]);
const activeTab = computed(() => state.value.tabs.find((tab) => tab.id === state.value.active));
const focused = computed(() => focusedPane.value === pane);
// A jump to a line belongs to the pane the click came from: the store keeps one, and only the focused pane is
// where that click landed.
const line = computed(() => (focused.value ? openLine.value : undefined));

const activeFile = computed(() => (activeTab.value?.kind === `file` ? activeTab.value : undefined));
const openPath = computed(() => activeFile.value?.path);
const openMeta = computed(() => entry(openPath.value));

// A directory declares its own UI via `<dir>/.intentic/ui/index.html`; opening that file renders the directory's
// interaction surface (sandboxed iframe + action bridge) instead of the raw HTML source. undefined = a normal
// file, shown in the viewer. `directoryUiDir` is the owning dir, root-relative ("" = /work root).
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

// What the open diff is showing once its comments are out, for the bar above it: see useDiffStat.
const { stat: diffStat, onStat: setDiffStat } = useDiffStat(computed(() => activeTab.value?.id));
// The gap between clicking a changed file and its content arriving. The tab, its label and the toolbar's status
// and ± counts are already on screen by then: this decides only whether the panes below them are worth drawing
// as an outline, which for a warmed or cached diff (the common case) they are not: it lands in the same tick.
const diffPending = computed(() => activeTab.value?.kind === `diff` && activeTab.value.pending === true);
const diffOutline = useLoadingReveal(
    diffPending,
    computed(() => activeTab.value?.id ?? ``),
);
</script>

<template>
    <!-- Focus follows the pointer INTO a pane, and the keyboard follows the focus: Close Tab, the cycle chords
         and "open to the side" all act on the pane the reader last touched. `focusin` covers the keyboard's own
         way in (tabbing into the viewer), which no pointer event sees. -->
    <section
        class="ws-pane relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
        :class="{ 'ws-pane-off': !focused && strip.side.tabs.length > 0 }"
        @pointerdown="focusPane(pane)"
        @focusin="focusPane(pane)"
    >
        <!-- THE PANE'S ONE BAR: whatever the surface hangs on the left (the explorer toggle), this pane's open
             tabs, the open file's own context, and whatever the surface hangs on the right (the workspace's
             status and scope). Always rendered so the controls survive zero open tabs.

             It absorbed two bands. The breadcrumb used to sit under it repeating the active tab's filename, and
             a markdown file put a third band under THAT for three toggles; both now arrive in the seat below by
             teleport (see viewerChrome), which is why a viewer this component never renders directly can still
             put controls on its bar. -->
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
            <!-- Where the open file's breadcrumb and its viewer's controls land.
                 RULED OFF FROM THE TABS, and it earns the line: the strip scrolls its overflow, so on a
                 busy row the last tab is clipped mid-word, and against a bare crumb that reads as
                 broken text rather than as a strip continuing under a boundary. Capped at a share of
                 the row for the same reason: this region is what a file brings WITH it, and no file's
                 context is worth more than half the space for reaching the other files. -->
            <div :id="contextTarget(pane)" class="ws-context flex min-w-0 max-w-[45%] shrink items-center gap-2"></div>
            <slot name="status" />
            <!-- The companion pane's own way out, where a reader who opened a split looks for it: on the pane,
                 not in a menu. The main pane has no such button, closing the editor is closing its tabs. -->
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
        <!-- Nothing in this view can be read: the scope names a checkout that no longer exists. It
             pre-empts every branch below rather than letting each one fail in its own words. -->
        <WorkspaceScopeGone v-if="broken" />
        <template v-else-if="activeFile">
            <!-- FileViewer renders its own breadcrumb (with edit actions); the directory UI gets a bare one. -->
            <FileBreadcrumb v-if="directoryUiDir !== undefined" :path="activeFile.path" :meta="openMeta" />
            <div class="min-h-0 flex-1">
                <DirectoryUiHost v-if="directoryUiDir !== undefined" :dir="directoryUiDir" />
                <FileViewer v-else :path="activeFile.path" :meta="openMeta" :line="line" @gone="emit('close', $event)" />
            </div>
        </template>
        <!-- The tab strip names the file; this bar says how it is being READ (side-by-side or inline,
             comments in or out): the same bar the agent review renders, so one habit carries across
             both surfaces. Above every diff state, so a binary or oversized one still has its controls. -->
        <template v-else-if="activeTab?.kind === 'diff'">
            <DiffToolbar
                :path="activeTab.label"
                :status="activeTab.status"
                :code="diffStat"
                :additions="activeTab.additions"
                :deletions="activeTab.deletions"
            />
            <div class="min-h-0 flex-1">
                <!-- Still being read. Nothing below it can be decided yet, whether the file is binary is
                     part of the answer, so this branch comes first, and the viewer mounts once, with
                     content, rather than being remounted when the content replaces the empty panes. -->
                <template v-if="activeTab.pending"><DiffSkeleton v-if="diffOutline" /></template>
                <!-- Bytes, a patch of the changed regions, or two whole sides: FileDiffPane decides,
                     for this surface and for the two others that render the same diff. -->
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
            <!-- Every ranked row is an anchor: clicking one opens the file it names, because a ranking
                 whose rows don't go anywhere just makes the reader retype a path. -->
            <CodebaseHealth :repo="activeTab.repo" @open-file="openFile" @switch-repo="openHealth" />
        </div>
        <!-- A directory's document, rendered by the extension that has something to say about it: the
             open-ended member of this family, beside the code it explains. -->
        <div v-else-if="activeTab?.kind === 'document'" class="min-h-0 flex-1">
            <ExtensionDocument :extension="activeTab.extension" :provider="activeTab.provider" :path="activeTab.path" :title="activeTab.title" />
        </div>
        <!-- `empty` splits the two silences this pane covers: a workspace with nothing in it gets every
             way of getting code in, a workspace between files gets the drop target. Gated on the tree
             having LOADED, so the first paint of a full workspace never flashes the newcomer's screen. -->
        <WorkspaceEmptyState v-else :empty="empty" @pick="emit('pick')" />
    </section>
</template>

<style scoped>
/* WHICH PANE THE KEYBOARD IS IN, stated the way an editor states it: not at all until there are two, and then
 * by dimming the bar of the one that is NOT listening rather than by ringing the one that is. A ring around a
 * pane holding a diff would read as a selection inside the diff. */
.ws-pane-off .view-header {
    opacity: 0.75;
}

/* The seat the open file's context is teleported into, ruled off from the tab strip beside it. THE RULE IS
 * CONDITIONAL ON THERE BEING SOMETHING THERE, and `:empty` is what states that rather than a `v-if` on a class:
 * this seat is filled from elsewhere (see viewerChrome), so the component that draws the border is not the one
 * that knows whether anything arrived, and a diff, a health report or an empty strip would each have to
 * remember to say so. A stray 1px rule floating in a bar is exactly the kind of thing nobody files a bug for
 * and everybody sees.
 *
 * The line matches a tab's own right divider, deliberately: the strip scrolls its overflow, so a busy row clips
 * its last tab mid-word, and the eye needs to read that as a strip continuing under a boundary rather than as
 * broken text running into a path. */
.ws-context:not(:empty) {
    border-left: 1px solid var(--color-line);
    padding-left: 0.5rem;
}
</style>
