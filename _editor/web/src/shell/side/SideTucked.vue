<script setup lang="ts">
import { vMiddleclick } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, useTemplateRef } from "vue";
import type { SideStripItem } from "./SideStrip.vue";

// WHAT WAS OPENED BESIDE, TUCKED AWAY: one icon per tab in a column at the side panel's edge, where the tabs stood
// (sideLayout.ts). A press brings the column back on that tab; the bodies never left, so it comes back as it was. A column
// of picks, so the tab on screen wears the skin's picked-row mark at its leading edge, as an index column's row does.
// Presentational, like SideStrip: the panel owns the list and answers every gesture.

const { tabs, active } = defineProps<{
    tabs: readonly SideStripItem[];
    active: string | undefined;
}>();
const emit = defineEmits<{
    reveal: [id: string];
    close: [id: string];
    contextmenu: [id: string | undefined, event: MouseEvent];
}>();

const t = useT();

const buttonEls = new Map<string, HTMLElement>();
const setButtonEl = (id: string, el: Element | ComponentPublicInstance | null): void => {
    if (el instanceof HTMLElement) {
        buttonEls.set(id, el);
    } else {
        buttonEls.delete(id);
    }
};

// Up and Down walk the icons, as the strip's arrows walk its tabs; only the focused tab's icon is a Tab stop.
const onKeydown = (event: KeyboardEvent, id: string): void => {
    const step = event.key === `ArrowDown` ? 1 : event.key === `ArrowUp` ? -1 : 0;
    if (step === 0) {
        return;
    }
    event.preventDefault();
    const at = tabs.findIndex((tab) => tab.id === id);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    if (next !== undefined) {
        buttonEls.get(next.id)?.focus();
    }
};

const root = useTemplateRef<HTMLElement>(`root`);
// The panel hands the keyboard here when it tucks the column away from a press inside it.
const focusActive = (): void => {
    (buttonEls.get(active ?? ``) ?? root.value?.querySelector(`button`))?.focus();
};
defineExpose({ focusActive });
</script>

<template>
    <div
        ref="root"
        class="side-tucked scrollbar-none flex w-8 shrink-0 flex-col items-center gap-1 overflow-y-auto bg-card py-1.5"
        role="toolbar"
        aria-orientation="vertical"
        :aria-label="t(`shell.sidePanel.tuckedTabs`)"
        @contextmenu.self="emit('contextmenu', undefined, $event)"
    >
        <button
            v-for="tab in tabs"
            :key="tab.id"
            :ref="(el) => setButtonEl(tab.id, el)"
            type="button"
            :tabindex="tab.id === active ? 0 : -1"
            :aria-label="t(`shell.sidePanel.showTab`, { title: tab.label.title })"
            :aria-current="tab.id === active ? `true` : undefined"
            class="touch-target ui-row-select flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:text-content"
            :class="tab.id === active ? `ui-row-select-on text-content` : `text-muted`"
            v-tooltip.left="tab.label.tip ?? tab.label.title"
            v-middleclick="() => emit('close', tab.id)"
            @click="emit('reveal', tab.id)"
            @keydown="onKeydown($event, tab.id)"
            @contextmenu.prevent="emit('contextmenu', tab.id, $event)"
        >
            <!-- In the glyph's own colour (a file's type), as on the strip: on a column of icons alone, it tells them apart. -->
            <Icon :name="tab.label.icon" class="text-xs" :class="tab.label.iconClass" />
        </button>
    </div>
</template>
