<!-- THE APP'S RIGHT-CLICK MENU: PrimeVue's ContextMenu at this app's density, with the row every caller was
     building by hand: a reserved gutter, the label, and the command's keyboard shortcut right-aligned.

     Five surfaces had each written this out: the chat tab strip, the terminal pill bar, the workspace file
     tabs, the file tree and the git graph, and three of them were byte-identical from the `pt` block through
     the `#item` template. Their own comments said as much ("the same dense pt and shortcut-hint row the
     workspace's file-tab menu uses"; "Dense pt matches the file tree's context menu"), which is a duplication
     that had already been noticed twice and copied anyway.

     THE GUTTER IS ALL-OR-NOTHING, per menu. A menu whose items carry icons or checkmarks reserves the column
     on EVERY row, so labels line up whether or not a given row has one; a menu with neither reserves nothing
     and sits flush. The terminal menu used to decide this per ROW (`v-if="'checked' in item"`), which meant
     its two toggle rows were indented and its eight command rows were not: a ragged edge that read as a
     rendering slip rather than as a grouping.

     `minWidth` is in rem and per call site because these menus genuinely differ: the file tree's four short
     verbs want 10rem, the terminal's "Kill 3 running terminals" wants 14. Everything else is fixed here, which
     is the point.

     A ROW THAT GOES SOMEWHERE IS A LINK, and that is what `url` on the item buys. PrimeVue's own markup puts
     the click handler on the row's wrapper and leaves the `<a>` inside it hrefless, so a menu row that
     navigated was an anchor in name only: no address in the status bar, no "Open link in new tab" in the
     browser's own menu, no Ctrl/⌘-click, no middle-click, nothing to copy. Every destination in this app is a
     real URL, so every row that names one now says so.

     THE COMMAND STILL OWNS THE ORDINARY CLICK. `url` is the ADDRESS; `command` is what a plain click does:
     usually a router push, plus whatever else the row has to tidy up (closing the popover it lives in). So a
     plain click cancels the anchor's own navigation and lets the command run, and a MODIFIED click does the
     exact opposite: the browser takes it, the command is held back so nothing navigates this tab underneath
     the new one, and the menu closes. A row given `url` and no command is a plain link and behaves like one. -->
<script setup lang="ts">
import PrimeContextMenu from "primevue/contextmenu";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import type { IconName } from "../icons/iconSets.js";
import { browserOwnsClick } from "../lib/link.js";
import Icon from "./Icon.vue";

const {
    model,
    minWidth = 13,
    appendTo,
} = defineProps<{
    model: MenuItem[];
    /** rem: the menu's floor, so a short verb list doesn't render as a sliver. */
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

const onRowClick = (event: MouseEvent, item: MenuItem): void => {
    if (item.url === undefined) {
        return; // an ordinary command row: nothing here to intercept
    }
    if (browserOwnsClick(event)) {
        // PrimeVue's handler sits on this row's wrapper, so the command runs unless the event stops here:
        // and a command that navigates would move THIS tab while the browser opens another.
        event.stopPropagation();
        menu.value?.hide();
        return;
    }
    // A plain click on a row that has both: the command navigates in-app, so the anchor must not reload.
    if (item.command !== undefined) {
        event.preventDefault();
    }
};
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
            <a v-bind="props.action" :href="item.url" :target="item.target" @click="onRowClick($event, item as MenuItem)">
                <span v-if="hasGutter" class="flex w-3.5 shrink-0 justify-center">
                    <!-- A checkable row draws its state even when false: the gutter holds the space either
                         way, so the label cannot shift as the toggle flips. -->
                    <Icon v-if="`checked` in item" v-show="item['checked'] === true" name="check" class="text-2xs text-muted" />
                    <Icon v-else-if="item.icon" :name="item.icon as IconName" class="text-2xs" />
                </span>
                <!-- The label, and under it the row's own consequence when it has one to state. A `hint` is for
                     the menus whose rows are CHOICES rather than commands: "Fork" and "Fork chat only" differ
                     only in what happens to the files, which no verb short enough to be a label can carry, and
                     it is optional precisely so the command menus above stay the single dense line they were. -->
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate" :class="item['danger'] === true && `text-danger`">{{ item.label }}</span>
                    <span v-if="item['hint']" class="truncate text-2xs text-subtle">{{ item["hint"] }}</span>
                </span>
                <kbd
                    v-if="item['shortcut']"
                    class="shrink-0 rounded border border-line bg-overlay px-1 py-px font-mono text-3xs leading-none text-muted"
                    >{{ item["shortcut"] }}</kbd
                >
            </a>
        </template>
    </PrimeContextMenu>
</template>
