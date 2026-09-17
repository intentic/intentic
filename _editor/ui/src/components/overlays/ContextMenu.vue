<!-- The app's right-click menu: PrimeVue's ContextMenu at house density, with a reserved icon/check gutter that's all-or-nothing per menu. -->
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
    /* Which document the menu opens in, for a caller that draws into one of its own (an iframe). */
    appendTo?: HTMLElement | string;
}>();

const menu = ref<{ show: (event: Event) => void; hide: () => void } | undefined>();

// One column for both marks: an item is never both checked and icon-bearing, and reserving two gutters for
// the union would indent every label past a space nothing can occupy.
const hasGutter = computed(() => model.some((item) => item[`icon`] !== undefined || `checked` in item));

/** px kept between the menu and the viewport edge. */
const edgeGap = 8;

// PrimeVue opens the menu at the pointer and only ever flips it whole, so a model longer than the screen (a fleet's
// worth of conversations) is drawn straight past the bottom edge with no way to reach its last rows. Cap the list to
// the roomier side of the click before it renders — PrimeVue measures after this style lands — and let it scroll.
const maxHeight = ref<string>();
const capToViewport = (event: Event): void => {
    // Duck-typed, not `instanceof MouseEvent`: an extension's menu is opened by an event from its own iframe realm.
    // A keyboard-opened menu reports no pointer, and 0 is where PrimeVue puts it anyway.
    const y = (event as Partial<MouseEvent>).clientY ?? 0;
    const below = window.innerHeight - y;
    maxHeight.value = `${Math.max(below, y) - edgeGap}px`;
};

defineExpose({
    show: (event: Event): void => {
        capToViewport(event);
        menu.value?.show(event);
    },
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
            rootList: { class: `!p-1 overflow-y-auto overscroll-contain`, style: { maxHeight } },
            itemLink: `!flex !items-center !gap-2 !rounded !px-2 !py-1 !text-xs`,
            separator: `!my-1`,
        }"
    >
        <template #item="{ item, props }">
            <a v-bind="props.action" :href="item.url" :target="item.target" @click="onRowClick($event, item as MenuItem)">
                <span v-if="hasGutter" class="flex w-3.5 shrink-0 justify-center">
                    <!-- Checkable rows reserve the gutter even when unchecked so labels do not shift. -->
                    <Icon v-if="`checked` in item" v-show="item['checked'] === true" name="check" class="text-sm text-muted" />
                    <Icon v-else-if="item.icon" :name="item.icon as IconName" class="text-sm" />
                </span>
                <!-- The label, and under it the row's own consequence when it has one to state. -->
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate" :class="item['danger'] === true && `text-danger`">{{ item.label }}</span>
                    <span v-if="item['hint']" class="truncate text-2xs text-subtle">{{ item["hint"] }}</span>
                </span>
                <Icon v-if="item.items?.length" name="chevron-right" class="text-sm text-muted" />
                <kbd
                    v-if="item['shortcut']"
                    class="shrink-0 rounded border border-line bg-overlay px-1 py-px font-mono text-3xs leading-none text-muted"
                    >{{ item["shortcut"] }}</kbd
                >
            </a>
        </template>
    </PrimeContextMenu>
</template>
