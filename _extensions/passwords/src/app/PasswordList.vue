<!-- The middle column: what was saved lately, then one row per password, picked with the pointer or the arrow keys. -->
<script setup lang="ts">
import { ui } from "@intentic/extension-ui";
import { nextTick, ref, watch } from "vue";
import { t } from "../i18n.js";
import ItemTile from "./ItemTile.vue";
import type { PasswordItem } from "./port.js";
import { rowLine } from "./words.js";

const { items, selected, recent, empty } = defineProps<{
    items: readonly PasswordItem[];
    selected: string | undefined;
    /** Saved this week and not yet looked at: the strip above the list. */
    recent: readonly PasswordItem[];
    /** What an empty list says. */
    empty: string;
}>();
const emit = defineEmits<{ select: [name: string]; open: [name: string]; review: [] }>();

const list = ref<HTMLElement | undefined>(undefined);

// The arrow keys move the selection the way a mail client's list does; Enter opens it, which on a narrow window is the
// way to the detail.
const onKey = (event: KeyboardEvent): void => {
    if (event.key !== `ArrowDown` && event.key !== `ArrowUp` && event.key !== `Enter`) {
        return;
    }
    const at = items.findIndex((item) => item.name === selected);
    if (event.key === `Enter`) {
        if (selected !== undefined) {
            event.preventDefault();
            emit(`open`, selected);
        }
        return;
    }
    event.preventDefault();
    const next = items[event.key === `ArrowDown` ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)];
    if (next !== undefined) {
        emit(`select`, next.name);
    }
};

// The selected row is kept in view, and keeps the focus when the keys moved it there.
watch(
    () => selected,
    async (name) => {
        await nextTick();
        const row = list.value?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name ?? ``)}"]`);
        row?.scrollIntoView({ block: `nearest` });
        if (list.value?.contains(document.activeElement) === true) {
            row?.focus();
        }
    },
);

const recentNames = (): string =>
    recent
        .slice(0, 3)
        .map((item) => item.title)
        .join(`, `);
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <div v-if="recent.length > 0" class="mb-2 flex shrink-0 items-center gap-2 rounded-lg bg-primary-tint px-3 py-2 text-xs">
            <span class="min-w-0 flex-1">{{ t(`app.list.recent`, { count: recent.length, names: recentNames() }, recent.length) }}</span>
            <button type="button" :class="ui.textButton({ size: `xs`, flush: true }, `shrink-0 font-medium`)" @click="emit(`review`)">
                {{ t(`app.list.review`) }}
            </button>
        </div>

        <p v-if="items.length === 0" class="px-2 py-6 text-xs text-muted">{{ empty }}</p>
        <div
            v-else
            ref="list"
            role="listbox"
            :aria-label="t(`app.list.label`)"
            class="ui-softscroll flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1"
            @keydown="onKey"
        >
            <button
                v-for="item in items"
                :key="item.name"
                type="button"
                role="option"
                :data-name="item.name"
                :aria-selected="item.name === selected"
                :tabindex="item.name === selected || (selected === undefined && item === items[0]) ? 0 : -1"
                class="group flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary-fill"
                :class="item.name === selected ? `bg-primary-tint` : `hover:bg-overlay`"
                @click="emit(`select`, item.name)"
                @dblclick="emit(`open`, item.name)"
            >
                <ItemTile :item="item" />
                <span class="flex min-w-0 flex-1 flex-col">
                    <span class="flex min-w-0 items-center gap-1.5">
                        <span class="truncate text-sm font-medium text-content">{{ item.title }}</span>
                        <span v-if="item.fresh" class="shrink-0 rounded-full bg-primary-fill px-1.5 text-2xs font-semibold leading-4 text-fill-content">{{ t(`app.list.new`) }}</span>
                    </span>
                    <span class="truncate text-xs text-muted">{{ rowLine(item) }}</span>
                </span>
            </button>
        </div>
    </div>
</template>
