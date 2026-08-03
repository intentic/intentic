<!-- The Picker's open panel (internal — hosts are Picker.vue's Popover/BottomSheet): an optional filter box
     over a grouped listbox. Rows carry icon · label · quiet description · check; keyboard follows the
     QuickOpen pattern (arrows wrap, Enter picks, Esc clears the query before it closes). The host remounts
     this per open, so the query and highlight reset for free and onMounted is the open moment. -->
<script setup lang="ts" generic="T extends string">
import { computed, nextTick, onMounted, ref } from "vue";
import { useListNavigation } from "../composables/useListNavigation.js";
import SearchBar from "./SearchBar.vue";
import { nextPickerId, normalizePickerGroups, type PickerOption, type PickerOptions } from "./picker.js";

const {
    options,
    selectedValue,
    searchThreshold = 8,
    autofocus = false,
    listLabel,
} = defineProps<{
    options: PickerOptions<T>;
    selectedValue: T | undefined;
    /** Show the filter box once the option count reaches this (0 = always). */
    searchThreshold?: number;
    /** Desktop hosts focus the panel on open; the mobile sheet must not summon the soft keyboard. */
    autofocus?: boolean;
    listLabel?: string;
}>();

const emit = defineEmits<{ pick: [option: PickerOption<T>]; close: [] }>();

const panelId = nextPickerId();

const query = ref(``);
const groups = computed(() => normalizePickerGroups(options));
const optionCount = computed(() => groups.value.reduce((count, group) => count + group.options.length, 0));
const searchable = computed(() => optionCount.value >= searchThreshold);

// The visible list: groups filtered by the query (a group's label counts as a match for all its rows, so
// "claude" finds every model under the Claude Code header), each row carrying its index in visual order —
// the keyboard highlight's coordinate system.
const shown = computed(() => {
    const needle = query.value.trim().toLowerCase();
    let index = 0;
    return groups.value
        .map((group, groupIndex) => ({
            key: group.label ?? `group-${groupIndex}`,
            label: group.label,
            rows: group.options
                .filter(
                    (option) => needle === `` || `${group.label ?? ``} ${option.label} ${option.description ?? ``}`.toLowerCase().includes(needle),
                )
                .map((option) => ({ option, index: index++ })),
        }))
        .filter((group) => group.rows.length > 0);
});
const flat = computed<readonly PickerOption<T>[]>(() => shown.value.flatMap((group) => group.rows.map((row) => row.option)));

const { activeIndex, activeRow, move, setRowEl } = useListNavigation(flat, (option) => option.value);

const searchInput = ref<{ focus: () => void } | null>(null);
const listEl = ref<HTMLElement | null>(null);

const pick = (option: PickerOption<T>): void => {
    if (option.disabled === true) {
        return;
    }
    emit(`pick`, option);
};

const onKeydown = (event: KeyboardEvent): void => {
    switch (event.key) {
        case `ArrowDown`:
            event.preventDefault();
            move(1);
            return;
        case `ArrowUp`:
            event.preventDefault();
            move(-1);
            return;
        case `Enter`:
            event.preventDefault();
            if (activeRow.value !== undefined) {
                pick(activeRow.value);
            }
            return;
        case `Escape`:
            // Esc clears the query first (restoring the full list), then closes. stopPropagation keeps the
            // host popover's own document-level Esc handler from closing it while there's a query to clear.
            if (query.value.length > 0) {
                event.stopPropagation();
                query.value = ``;
                return;
            }
            emit(`close`);
            return;
        default:
    }
};

onMounted(() => {
    // Open on the current choice, not the top: the highlight is the panel's answer to "what is it set to".
    const selectedIndex = flat.value.findIndex((option) => option.value === selectedValue);
    if (selectedIndex > 0) {
        activeIndex.value = selectedIndex;
    }
    void nextTick(() => {
        move(0); // a zero-step move scrolls the highlight into view
        if (autofocus) {
            (searchable.value ? searchInput.value : listEl.value)?.focus();
        }
    });
});
</script>

<template>
    <div class="flex min-w-0 flex-col" @keydown="onKeydown">
        <SearchBar
            v-if="searchable"
            ref="searchInput"
            v-model="query"
            :aria-controls="`${panelId}-list`"
            :aria-activedescendant="flat.length > 0 ? `${panelId}-opt-${activeIndex}` : undefined"
        />
        <div
            :id="`${panelId}-list`"
            ref="listEl"
            role="listbox"
            :aria-label="listLabel"
            tabindex="-1"
            class="scrollbar-thin max-h-72 min-w-0 overflow-y-auto py-1 focus:outline-none"
        >
            <template v-for="group in shown" :key="group.key">
                <p
                    v-if="group.label !== undefined"
                    class="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-subtle"
                    role="presentation"
                >
                    {{ group.label }}
                </p>
                <button
                    v-for="row in group.rows"
                    :id="`${panelId}-opt-${row.index}`"
                    :key="row.option.value"
                    :ref="(el) => setRowEl(row.option.value, el)"
                    type="button"
                    role="option"
                    :aria-selected="row.option.value === selectedValue"
                    class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default disabled:opacity-40 max-md:min-h-11"
                    :class="{ 'ui-row-select-on': row.index === activeIndex }"
                    :disabled="row.option.disabled === true"
                    @click="pick(row.option)"
                    @mouseenter="activeIndex = row.index"
                >
                    <slot name="icon" :option="row.option">
                        <Icon
                            v-if="row.option.icon !== undefined"
                            :name="row.option.icon"
                            class="shrink-0 text-xs"
                            :class="row.option.value === selectedValue ? `text-primary-500` : `text-muted`"
                            aria-hidden="true"
                        />
                    </slot>
                    <span
                        class="min-w-0 shrink truncate text-sm md:text-xs"
                        :class="[row.option.value === selectedValue ? `text-link` : `text-content`, row.option.mono === true ? `font-mono` : ``]"
                        >{{ row.option.label }}</span
                    >
                    <span v-if="row.option.description !== undefined" class="min-w-0 flex-1 truncate text-right text-2xs text-subtle">{{
                        row.option.description
                    }}</span>
                    <Icon
                        v-if="row.option.value === selectedValue"
                        name="check"
                        class="ml-auto shrink-0 text-2xs text-primary-500"
                        aria-hidden="true"
                    />
                </button>
            </template>
            <p v-if="flat.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">No matches.</p>
        </div>
        <div class="sr-only" aria-live="polite">{{ flat.length }} options</div>
    </div>
</template>
