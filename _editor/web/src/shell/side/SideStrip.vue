<script setup lang="ts">
import { type Tip, ui, vMiddleclick } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, nextTick, useTemplateRef, watch } from "vue";
import type { SideViewLabel } from "./sideViews";

// The side panel's strip: one tab per thing opened beside, in the workspace file strip's idiom (FileTabs.vue) so the two
// read as one habit. Presentational: the panel owns the list and answers every gesture. The peek draws italic until
// kept, by the double-click or the panel's Keep open.

export interface SideStripItem {
    readonly id: string;
    readonly label: SideViewLabel;
}

const { tabs, active, peek, domId } = defineProps<{
    tabs: readonly SideStripItem[];
    active: string | undefined;
    peek: string | null;
    // Each tab's element id; its body's is the same with `-body`, so a tab names the panel it controls.
    domId: (id: string) => string;
}>();
const emit = defineEmits<{
    select: [id: string];
    keep: [id: string];
    close: [id: string];
    contextmenu: [id: string, event: MouseEvent];
}>();

const t = useT();

// The hover: the tab's own explanation, and for the peek, the gesture that keeps it, since italic alone doesn't say.
const hint = (tab: SideStripItem): Tip => {
    const tip = tab.label.tip ?? { title: tab.label.title };
    return tab.id === peek ? { ...tip, note: t(`shell.sidePanel.doubleClickToKeep`) } : tip;
};

const scroller = useTemplateRef<HTMLElement>(`scroller`);
// Each tab's element by id, for focusing and revealing one; a tab's id is JSON, no fit for a selector.
const tabEls = new Map<string, HTMLElement>();
const setTabEl = (id: string, el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof HTMLElement) {
        tabEls.set(id, el);
    } else {
        tabEls.delete(id);
    }
};

// A wheel over the strip scrolls it sideways, the only way it can move.
const onWheel = (event: WheelEvent): void => {
    const strip = scroller.value;
    if (strip === null || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) {
        return;
    }
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
};

// Arrow keys walk the tabs from one that has focus, the way a tablist moves.
const onKeydown = (event: KeyboardEvent, id: string): void => {
    const at = tabs.findIndex((tab) => tab.id === id);
    const step = event.key === `ArrowRight` ? 1 : event.key === `ArrowLeft` ? -1 : 0;
    if (step !== 0) {
        const next = tabs[(at + step + tabs.length) % tabs.length];
        if (next !== undefined) {
            event.preventDefault();
            emit(`select`, next.id);
            void nextTick(() => tabEls.get(next.id)?.focus());
        }
        return;
    }
    if (event.key === `Enter` || event.key === ` `) {
        event.preventDefault();
        emit(`select`, id);
        return;
    }
    if (event.key === `Delete`) {
        event.preventDefault();
        emit(`close`, id);
    }
};

const onClose = (event: Event, id: string): void => {
    // The × sits inside the tab, so the press must not also select it.
    event.stopPropagation();
    emit(`close`, id);
};

// A tab just opened past the strip's end is brought into view.
watch(
    () => active,
    async (id) => {
        await nextTick();
        if (id !== undefined) {
            tabEls.get(id)?.scrollIntoView?.({ block: `nearest`, inline: `nearest` });
        }
    },
    { immediate: true },
);
</script>

<template>
    <div ref="scroller" class="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" :aria-label="t(`shell.sidePanel.label`)" @wheel="onWheel">
        <div
            v-for="tab in tabs"
            :key="tab.id"
            :ref="(el) => setTabEl(tab.id, el)"
            role="tab"
            :id="domId(tab.id)"
            :aria-selected="tab.id === active"
            :aria-controls="`${domId(tab.id)}-body`"
            :tabindex="tab.id === active ? 0 : -1"
            class="group flex max-w-48 shrink-0 items-center gap-1.5 border-r border-r-line px-3 text-xs outline-offset-[-2px]"
            :class="ui.tab(tab.id === active, tab.id === active ? `bg-canvas` : `hover:bg-content/6`)"
            v-tooltip.bottom="hint(tab)"
            v-middleclick="() => emit('close', tab.id)"
            @click="emit('select', tab.id)"
            @dblclick="emit('keep', tab.id)"
            @keydown="onKeydown($event, tab.id)"
            @contextmenu.prevent="emit('contextmenu', tab.id, $event)"
        >
            <Icon :name="tab.label.icon" class="shrink-0 text-2xs" :class="tab.label.iconClass ?? `text-muted`" />
            <!-- Italic slants past its box; the padding keeps truncation from clipping the last glyph. -->
            <span class="min-w-0 truncate" :class="tab.id === peek ? `pr-[0.2em] italic` : ``">{{ tab.label.title }}</span>
            <span
                class="flex h-3 w-3 shrink-0 items-center justify-center rounded transition-opacity group-hover:opacity-60"
                :class="tab.id === active ? `opacity-60` : `opacity-0`"
                aria-hidden="true"
                @click="onClose($event, tab.id)"
            >
                <Icon name="times" class="text-[0.6rem] hover:text-content" />
            </span>
        </div>
    </div>
</template>
