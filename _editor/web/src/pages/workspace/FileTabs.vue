<script setup lang="ts">
import { isLockedWorkspacePath } from "@intentic/sandbox-contract";
import { type IconName, useExplorerStyle, ChangeStatusMark, explorerColorClass, iconForEntry } from "@intentic/ui";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEditBuffers } from "../../composables/workspace/useEditBuffers";
import type { WorkspaceTab } from "./workspaceTabs";
import { basename } from "@intentic/ui/path";

/* The open-item tab strip (VSCode-style): one pill per open file, snapshot diff, or generated workspace surface.
 * Presentational: selection/close are emitted up to Workspace.vue by tab id, which drives the tab list +
 * active id (useWorkspaceTabs), and embeds this strip in its tab row (which provides the bar's
 * border/background). A file tab shows its type icon, basename, and a close ×; a dirty file shows a dot in
 * the close slot (→ × on hover). A diff tab shows its status letter + basename and is never dirty. The one tab
 * in the preview slot is drawn italic and promoted out of
 * it by a double-click, exactly as VSCode does. */

// `preview` is the one transient tab, if any (see OpenMode): drawn italic, like VSCode's, because it is going
// to be replaced by the next file the user looks at.
const { tabs, active, preview } = defineProps<{ tabs: readonly WorkspaceTab[]; active?: string | null; preview?: string | null }>();
// `contextmenu` carries the right-clicked tab's id, or undefined when the click landed on the strip's empty
// space: the parent owns both menus, so it decides which rows a tab-less right-click deserves. `keep` is the
// double-click that makes a preview tab permanent.
const emit = defineEmits<{
    select: [id: string];
    keep: [id: string];
    close: [id: string];
    contextmenu: [id: string | undefined, event: Event];
}>();

const { isDirty } = useEditBuffers();
const { explorerStyle } = useExplorerStyle();

// A file the sandbox keeps to itself wears the padlock in the strip too, so the tab matches the row that opened
// it and the reason is on screen from the moment it appears (isLockedWorkspacePath; FileLocked says the rest).
const fileIcon = (path: string): IconName => (isLockedWorkspacePath(path) ? `lock` : iconForEntry(basename(path), `file`));

const tabLabel = (tab: WorkspaceTab): string => {
    if (tab.kind === `directory`) {
        return basename(tab.dir);
    }
    // A document is named for the DIRECTORY it explains, not for the document family: the strip is a list of
    // subjects, and "Architecture" three times over would name none of them. The family is in the tooltip.
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
// The preview tab's tooltip carries the gesture that keeps it: a double-click is the one affordance the tab
// itself has no room to show, and the italic alone doesn't say what to do about it.
const tabHint = (tab: WorkspaceTab): string => (tab.id === preview ? `${tabSubject(tab)} · double-click to keep open` : tabSubject(tab));

const onClose = (event: Event, id: string): void => {
    // The × sits inside the tab, so stop the click from also selecting it.
    event.stopPropagation();
    emit(`close`, id);
};

/* Overlay scrollbar. The native bar is hidden (it would eat 6px of the fixed-height row and shove the tab
 * text up); instead the strip scrolls via scrollLeft: mouse wheel, or dragging this thumb, and a thin thumb
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
        return; // nothing to scroll horizontally: let the event bubble (page scroll)
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

/* Keeping the focused tab in view. Almost nothing that focuses a tab is inside this strip: a row in the file
 * tree, a Changes or Checkpoints row, a restored strip on reload, so once the strip overflows, the tab any of
 * them opens can sit past its right edge, and a strip that stays put reads as a click that did nothing.
 * `nearest` moves the least it can and no-ops on a tab already visible, so clicking a tab here never shifts it
 * out from under the pointer. */
const tabEls = new Map<string, HTMLElement>();
const setTabEl = (id: string, el: unknown): void => {
    if (el) {
        tabEls.set(id, el as HTMLElement);
    } else {
        tabEls.delete(id);
    }
};

// A newly opened tab is one tick away from existing, so the reveal waits for the DOM the focus change produced.
const revealActive = async (): Promise<void> => {
    await nextTick();
    if (active === null || active === undefined) {
        return;
    }
    tabEls.get(active)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
};
// `immediate` is the reload: the strip mounts already focused, on a tab that may be well past the right edge.
watch(() => active, revealActive, { immediate: true });

let observer: ResizeObserver | undefined;
onMounted(() => {
    updateThumb();
    observer = new ResizeObserver(() => {
        updateThumb();
        // A strip that just got narrower (explorer reopened, window resized) can leave the focused tab behind it.
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
        <!-- A right-click that lands on the scroller ITSELF (past the last tab) is the strip's own menu; a tab
             stops its own event before it gets here. -->
        <div
            ref="scroller"
            class="ftabs-scroll flex min-w-0 flex-1 items-stretch overflow-x-auto"
            @scroll="updateThumb"
            @wheel="onWheel"
            @contextmenu="emit('contextmenu', undefined, $event)"
        >
            <div
                v-for="tab in tabs"
                :key="tab.id"
                :ref="(el) => setTabEl(tab.id, el)"
                class="ftab group flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs"
                :class="{ 'ftab-on': tab.id === active }"
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
                <!-- The provider's own glyph, an open string like every extension-supplied icon (a bundle may name
                     one this app has never heard of): an unknown name renders the set's fallback, never an error. -->
                <Icon v-else-if="tab.kind === 'document'" :name="tab.icon as IconName" class="text-2xs text-link" />
                <ChangeStatusMark v-else :status="tab.status" />
                <span class="max-w-40 truncate" :class="{ 'ftab-label--preview': tab.id === preview }">{{ tabLabel(tab) }}</span>
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
/* Italic slants past its box; truncate clips the last glyph unless we leave room on the right. */
.ftab-label--preview {
    font-style: italic;
    padding-right: 0.2em;
}
</style>
