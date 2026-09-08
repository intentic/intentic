<!--
    The app's right-click menu: PrimeVue's ContextMenu at house density, with a reserved icon/check gutter that's all-or-nothing per menu. `url`
    makes a row a real anchor (status bar, new-tab, middle-click); `command` still runs on a plain click, cancelling the anchor's own navigation.
-->
<script setup lang="ts">
import PrimeContextMenu from "primevue/contextmenu";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
import type { IconName } from "../../icons/iconSets.js";
import { browserOwnsClick } from "../../lib/link.js";
import Icon from "../primitives/Icon.vue";

const {
    model,
    minWidth = 13,
    appendTo,
} = defineProps<{
    model: MenuItem[];
    /** rem: the menu's floor, so a short verb list doesn't render as a sliver. */
    minWidth?: number;
    /* Which document the menu opens in, for a caller that draws into one of its own (an iframe): a menu left
       behind in the wrong document is a menu the user cannot see. Undefined ⇒ PrimeVue's default, which is
       right for everything in the app's own window, floating panels included, since each is its own window. */
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
                    <Icon v-if="`checked` in item" v-show="item['checked'] === true" name="check" class="text-sm text-muted" />
                    <Icon v-else-if="item.icon" :name="item.icon as IconName" class="text-sm" />
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
