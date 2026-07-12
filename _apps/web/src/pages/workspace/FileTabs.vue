<script setup lang="ts">
import { type IconName, useExplorerStyle } from "@intentic-app/ui";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEditBuffers } from "../../composables/workspace/useEditBuffers";
import { explorerColorClass, iconForEntry } from "@intentic-app/ui";
import { STATUS_CLASS, STATUS_LETTER, type WorkspaceTab } from "./workspaceTabs";

/* The open-item tab strip (VSCode-style): one pill per open file, snapshot diff, or plan preview.
 * Presentational — selection/close are emitted up to Workspace.vue by tab id, which drives the tab list +
 * active id (useWorkspaceTabs), and embeds this strip in its tab row (which provides the bar's
 * border/background). A file tab shows its type icon, basename, and a close ×; a dirty file shows a dot in
 * the close slot (→ × on hover). A diff tab shows its status letter + basename; a plan tab shows the plan
 * icon + its title; neither is ever dirty. */

const { tabs, active } = defineProps<{ tabs: readonly WorkspaceTab[]; active?: string | null }>();
const emit = defineEmits<{ select: [id: string]; close: [id: string]; contextmenu: [id: string, event: Event] }>();

const { isDirty } = useEditBuffers();
const { explorerStyle } = useExplorerStyle();

const basename = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const fileIcon = (path: string): IconName => iconForEntry(basename(path), `file`);

const tabLabel = (tab: WorkspaceTab): string => (tab.kind === `plan` ? tab.title : tab.kind === `directory` ? basename(tab.dir) : basename(tab.path));
const tabHint = (tab: WorkspaceTab): string => {
    if (tab.kind === `plan`) {
        return tab.title;
    }
    if (tab.kind === `directory`) {
        return `${tab.dir} (management)`;
    }
    return tab.kind === `diff` ? `${tab.label} (diff)` : tab.path;
};

const onClose = (event: Event, id: string): void => {
    // The × sits inside the tab, so stop the click from also selecting it.
    event.stopPropagation();
    emit(`close`, id);
};

/* Overlay scrollbar. The native bar is hidden (it would eat 6px of the fixed-height row and shove the tab
 * text up); instead the strip scrolls via scrollLeft — mouse wheel, or dragging this thumb — and a thin thumb
 * floats over the bottom edge, revealed on hover. `thumbWidth === 0` means no overflow (thumb hidden). */
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
        return; // nothing to scroll horizontally — let the event bubble (page scroll)
    }
    event.preventDefault();
    el.scrollLeft += event.deltaY + event.deltaX;
    updateThumb();
};

// Drag the thumb: thumb travel maps to content travel by scrollWidth/clientWidth (inverse of the thumb ratio).
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

let observer: ResizeObserver | undefined;
onMounted(() => {
    updateThumb();
    observer = new ResizeObserver(updateThumb);
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
        <div ref="scroller" class="ftabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto" @scroll="updateThumb" @wheel="onWheel">
            <div
                v-for="tab in tabs"
                :key="tab.id"
                class="ftab group flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs"
                :class="{ 'ftab-on': tab.id === active }"
                :title="tabHint(tab)"
                @click="emit('select', tab.id)"
                @contextmenu.prevent.stop="emit('contextmenu', tab.id, $event)"
            >
                <Icon
                    v-if="tab.kind === 'file'"
                    :name="fileIcon(tab.path)"
                    class="text-2xs"
                    :class="explorerColorClass(explorerStyle, basename(tab.path), 'file', false)"
                />
                <Icon name="list-check" v-else-if="tab.kind === 'plan'" class="text-2xs text-link" />
                <Icon name="cog" v-else-if="tab.kind === 'directory'" class="text-2xs text-link" />
                <span v-else class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[tab.status]">{{
                    STATUS_LETTER[tab.status]
                }}</span>
                <span class="max-w-40 truncate">{{ tabLabel(tab) }}</span>
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
            class="ftabs-thumb"
            :class="{ 'ftabs-thumb--active': dragging }"
            :style="{ left: `${thumbLeft}%`, width: `${thumbWidth}%` }"
            @pointerdown="onThumbDown"
            @pointermove="onThumbMove"
            @pointerup="onThumbUp"
        ></div>
    </div>
</template>

<style scoped>
/* Hide the native horizontal scrollbar: it would take 6px off the fixed-height row and push tab text up.
 * Scrolling still works via scrollLeft (wheel handler + the overlay thumb below). */
.ftabs-scroll {
    scrollbar-width: none; /* Firefox */
}
.ftabs-scroll::-webkit-scrollbar {
    display: none;
}
.ftabs-thumb {
    position: absolute;
    bottom: 1px;
    height: 3px;
    border-radius: 9999px;
    background: transparent;
    cursor: grab;
    transition: background-color 0.15s;
}
.group\/tabs:hover .ftabs-thumb {
    background: var(--color-line-strong);
}
.group\/tabs:hover .ftabs-thumb:hover,
.ftabs-thumb--active {
    background: var(--color-muted);
    cursor: grabbing;
}
.ftab {
    color: var(--color-muted);
    cursor: pointer;
    border-right: 1px solid var(--color-line);
    border-bottom: 2px solid transparent;
    transition:
        background-color 0.15s,
        color 0.15s,
        border-color 0.15s;
}
.ftab:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
    color: var(--color-content);
}
.ftab-on {
    background: var(--color-canvas);
    color: var(--color-content);
    border-bottom-color: var(--color-primary-500);
}
</style>
