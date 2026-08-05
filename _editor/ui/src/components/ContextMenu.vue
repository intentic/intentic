<!-- THE APP'S RIGHT-CLICK MENU — PrimeVue's ContextMenu at this app's density, with the row every caller was
     building by hand: a reserved gutter, the label, and the command's keyboard shortcut right-aligned.

     Five surfaces had each written this out — the chat tab strip, the terminal pill bar, the workspace file
     tabs, the file tree and the git graph — and three of them were byte-identical from the `pt` block through
     the `#item` template. Their own comments said as much ("the same dense pt and shortcut-hint row the
     workspace's file-tab menu uses"; "Dense pt matches the file tree's context menu"), which is a duplication
     that had already been noticed twice and copied anyway.

     THE GUTTER IS ALL-OR-NOTHING, per menu. A menu whose items carry icons or checkmarks reserves the column
     on EVERY row, so labels line up whether or not a given row has one; a menu with neither reserves nothing
     and sits flush. The terminal menu used to decide this per ROW (`v-if="'checked' in item"`), which meant
     its two toggle rows were indented and its eight command rows were not — a ragged edge that read as a
     rendering slip rather than as a grouping.

     `minWidth` is in rem and per call site because these menus genuinely differ: the file tree's four short
     verbs want 10rem, the terminal's "Kill 3 running terminals" wants 14. Everything else is fixed here, which
     is the point. -->
<script setup lang="ts">
import PrimeContextMenu from "primevue/contextmenu";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import type { IconName } from "../icons/iconSets.js";
import Icon from "./Icon.vue";

const {
    model,
    minWidth = 13,
    appendTo,
} = defineProps<{
    model: MenuItem[];
    /** rem — the menu's floor, so a short verb list doesn't render as a sliver. */
    minWidth?: number;
    /* Which document the menu opens in. The chat and terminal panels teleport into a real `window.open`
       document while popped out (usePopout), and a menu left behind in the opener is a menu the user cannot
       see. Undefined ⇒ PrimeVue's default. */
    appendTo?: HTMLElement | string;
}>();

const menu = ref<{ show: (event: Event) => void; hide: () => void } | undefined>();

// One column for both marks: an item is never both checked and icon-bearing, and reserving two gutters for
// the union would indent every label past a space nothing can occupy.
const hasGutter = computed(() => model.some((item) => item[`icon`] !== undefined || `checked` in item));

defineExpose({
    show: (event: Event): void => menu.value?.show(event),
    hide: (): void => menu.value?.hide(),
});
</script>

<template>
    <PrimeContextMenu
        ref="menu"
        :model="model"
        :append-to="appendTo"
        :pt="{
            root: { class: `!text-xs`, style: { minWidth: `${minWidth}rem` } },
            rootList: `!p-1`,
            itemLink: `!flex !items-center !gap-2 !rounded !px-2 !py-1 !text-xs`,
            separator: `!my-1`,
        }"
    >
        <template #item="{ item, props }">
            <a v-bind="props.action">
                <span v-if="hasGutter" class="flex w-3.5 shrink-0 justify-center">
                    <!-- A checkable row draws its state even when false — the gutter holds the space either
                         way, so the label cannot shift as the toggle flips. -->
                    <Icon v-if="`checked` in item" v-show="item['checked'] === true" name="check" class="text-2xs text-muted" />
                    <Icon v-else-if="item.icon" :name="item.icon as IconName" class="text-2xs" />
                </span>
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <kbd
                    v-if="item['shortcut']"
                    class="shrink-0 rounded border border-line bg-overlay px-1 py-px font-mono text-[0.65rem] leading-none text-muted"
                    >{{ item["shortcut"] }}</kbd
                >
            </a>
        </template>
    </PrimeContextMenu>
</template>
