<script setup lang="ts">
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { type IconName, useExplorerStyle, ChangeStatusMark, explorerColorClass, iconForEntry } from "@intentic/ui";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEditBuffers } from "../files/useEditBuffers";
import type { WorkspaceTab } from "./workspaceTabs";
import { basename } from "@intentic/ui/path";

// Open-item tab strip (VSCode-style): one pill per open file, snapshot diff, or workspace surface. Presentational:
// selection/close emit up to Workspace.vue by tab id (useWorkspaceTabs drives the list). The preview-slot tab draws
// italic and is promoted permanent by double-click.

// `preview`: the one transient tab, if any, drawn italic until replaced by the next file looked at.
const { tabs, active, preview } = defineProps<{ tabs: readonly WorkspaceTab[]; active?: string | null; preview?: string | null }>();
// `contextmenu` id is undefined when the click lands on empty strip space; the parent decides that menu's rows.
// `keep` is the double-click that makes a preview tab permanent.
const emit = defineEmits<{
    select: [id: string];
    keep: [id: string];
    close: [id: string];
    contextmenu: [id: string | undefined, event: Event];
}>();

const { isDirty } = useEditBuffers();
const { explorerStyle } = useExplorerStyle();

// Locked files show a padlock in the tab too, matching the row that opened them (isLockedWorkspacePath).
const fileIcon = (path: string): IconName => (isLockedWorkspacePath(path) ? `lock` : iconForEntry(basename(path), `file`));

const tabLabel = (tab: WorkspaceTab): string => {
    if (tab.kind === `directory`) {
        return basename(tab.dir);
    }
    // Named for the directory it explains, not the family, or every 'Architecture' tab looks the same.
    if (tab.kind === `document`) {
        return basename(tab.path);
    }
    return tab.kind === `health` ? basename(tab.repo) : basename(tab.path);
};
const tabSubject = (tab: WorkspaceTab): string => {
    if (tab.kind === `directory`) {
        return `${tab.dir} (management)`;
    }
    if (tab.kind === `health`) {
        return `${tab.repo} · codebase health`;
    }
    if (tab.kind === `document`) {
        return `${tab.path} · ${tab.title}`;
    }
    return tab.kind === `diff` ? `${tab.label} (diff)` : tab.path;
};
// Preview tab's tooltip names the double-click gesture that keeps it; italic alone doesn't say how.
const tabHint = (tab: WorkspaceTab): string => (tab.id === preview ? `${tabSubject(tab)} · double-click to keep open` : tabSubject(tab));

const onClose = (event: Event, id: string): void => {
    // The × sits inside the tab, so stop the click from also selecting it.
    event.stopPropagation();
    emit(`close`, id);
};

// Overlay scrollbar: native bar hidden (it would shove the tab text up), so the strip scrolls via scrollLeft
// (wheel or dragging this thumb). `thumbWidth === 0` means no overflow, thumb hidden.
const scroller = ref<HTMLElement>();
const thumbLeft = ref(0); // %
const thumbWidth = ref(0); // %, 0 ⇒ everything fits, no thumb

const updateThumb = (): void => {
    const el = scroller.value;
    if (el === undefined) {
        return;
    }
    if (el.scrollWidth <= el.clientWidth) {
        thumbWidth.value = 0;
        return;
    }
    thumbWidth.value = (el.clientWidth / el.scrollWidth) * 100;
    thumbLeft.value = (el.scrollLeft / el.scrollWidth) * 100;
};

const onWheel = (event: WheelEvent): void => {
    const el = scroller.value;
    if (el === undefined || el.scrollWidth <= el.clientWidth) {
        return; // nothing to scroll horizontally: let the event bubble (page scroll)
    }
    event.preventDefault();
    el.scrollLeft += event.deltaY + event.deltaX;
    updateThumb();
};

// Drag the thumb: travel maps to content by scrollWidth/clientWidth (inverse of the thumb's ratio).
const dragging = ref(false);
let startX = 0;
let startLeft = 0;
const onThumbDown = (event: PointerEvent): void => {
    const el = scroller.value;
    if (el === undefined) {
        return;
    }
    dragging.value = true;
    startX = event.clientX;
    startLeft = el.scrollLeft;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};
const onThumbMove = (event: PointerEvent): void => {
    const el = scroller.value;
    if (!dragging.value || el === undefined) {
        return;
    }
    el.scrollLeft = startLeft + (event.clientX - startX) * (el.scrollWidth / el.clientWidth);
    updateThumb();
};
const onThumbUp = (event: PointerEvent): void => {
    dragging.value = false;
    (event.target as HTMLElement).releasePointerCapture(event.pointerId);
};

// Keeps the focused tab in view: most things that focus a tab (file tree, Changes, a reload) live outside this
// strip, so an overflowing strip can leave it off-screen. `nearest` moves least and no-ops if already visible.
const tabEls = new Map<string, HTMLElement>();
const setTabEl = (id: string, el: unknown): void => {
    if (el) {
        tabEls.set(id, el as HTMLElement);
    } else {
        tabEls.delete(id);
    }
};

// A newly opened tab is one tick from existing; reveal waits for the DOM the focus change produced.
const revealActive = async (): Promise<void> => {
    await nextTick();
    if (active === null || active === undefined) {
        return;
    }
    tabEls.get(active)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
};
// `immediate` covers reload: the strip can mount already focused on a tab past the right edge.
watch(() => active, revealActive, { immediate: true });

let observer: ResizeObserver | undefined;
onMounted(() => {
    updateThumb();
    observer = new ResizeObserver(() => {
        updateThumb();
        // A narrower strip (explorer reopened, window resized) can leave the focused tab behind.
        void revealActive();
    });
    if (scroller.value !== undefined) {
        observer.observe(scroller.value);
    }
});
onBeforeUnmount(() => observer?.disconnect());
// Opening/closing a tab changes the total width → recompute after the DOM updates.
watch(
    () => tabs.length,
    () => void nextTick(updateThumb),
);
</script>

<template>
    <div class="group/tabs relative flex min-w-0 flex-1">
        <!--
            Right-click past the last tab (on the scroller itself) is the strip's own menu; a tab stops its own event first.
            `.scrollbar-none` hides the native bar; scrollLeft (wheel + the thumb below) still works.
        -->
        <div
            ref="scroller"
            class="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto"
            @scroll="updateThumb"
            @wheel="onWheel"
            @contextmenu="emit('contextmenu', undefined, $event)"
        >
            <div
                v-for="tab in tabs"
                :key="tab.id"
                :ref="(el) => setTabEl(tab.id, el)"
                data-tab
                class="group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-b-2 border-r-line px-3 py-1.5 text-xs transition-colors"
                :class="
                    tab.id === active
                        ? `border-b-primary-500 bg-canvas text-content`
                        : `border-b-transparent text-muted hover:bg-content/6 hover:text-content`
                "
                v-tooltip.bottom="tabHint(tab)"
                @click="emit('select', tab.id)"
                @dblclick="emit('keep', tab.id)"
                @contextmenu.prevent.stop="emit('contextmenu', tab.id, $event)"
            >
                <Icon
                    v-if="tab.kind === 'file'"
                    :name="fileIcon(tab.path)"
                    class="text-2xs"
                    :class="explorerColorClass(explorerStyle, basename(tab.path), 'file', false)"
                />
                <Icon name="cog" v-else-if="tab.kind === 'directory'" class="text-2xs text-link" />
                <Icon name="wave-pulse" v-else-if="tab.kind === 'health'" class="text-2xs text-link" />
                <!-- Provider's own glyph, an open string; an unknown name falls back in the icon set rather than erroring. -->
                <Icon v-else-if="tab.kind === 'document'" :name="tab.icon as IconName" class="text-2xs text-link" />
                <ChangeStatusMark v-else :status="tab.status" />
                <!-- Italic slants past its box; truncate would clip the last glyph without room on the right. -->
                <span class="max-w-40 truncate" :class="tab.id === preview ? `pr-[0.2em] italic` : ``">{{ tabLabel(tab) }}</span>
                <span class="relative flex h-3 w-3 shrink-0 items-center justify-center" @click="onClose($event, tab.id)">
                    <Icon
                        name="circle-fill"
                        v-if="tab.kind === 'file' && isDirty(tab.path)"
                        class="text-[0.4rem] text-warning transition-opacity group-hover:opacity-0"
                    />
                    <Icon
                        name="times"
                        class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content"
                        :class="tab.kind === 'file' && isDirty(tab.path) ? 'group-hover:opacity-100' : 'group-hover:opacity-60'"
                    />
                </span>
            </div>
        </div>
        <!-- Overlay scrollbar: hidden until the strip overflows, faint by default, highlighted on strip hover. -->
        <div
            v-if="thumbWidth"
            class="absolute bottom-px h-0.75 rounded-full transition-colors"
            :class="
                dragging
                    ? `cursor-grabbing bg-muted`
                    : `cursor-grab group-hover/tabs:bg-line-strong group-hover/tabs:hover:cursor-grabbing group-hover/tabs:hover:bg-muted`
            "
            :style="{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }"
            @pointerdown="onThumbDown"
            @pointermove="onThumbMove"
            @pointerup="onThumbUp"
        ></div>
    </div>
</template>
