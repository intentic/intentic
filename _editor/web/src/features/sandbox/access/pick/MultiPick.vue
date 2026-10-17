<script setup lang="ts">
import { Button, ResponsiveOverlay, SearchBar, ui, useDevice, useListNavigation } from "@intentic/ui";
import Checkbox from "primevue/checkbox";
import { computed, nextTick, ref, useId, type VNode } from "vue";
import {
    allOptions,
    CHIP_LIMIT,
    chipsOf,
    filterSections,
    INLINE_LIMIT,
    type PickableRow,
    pickable,
    type PickOption,
    type PickSection,
    type PickState,
    rowsOf,
    stateOf,
    valuesOf,
    withValues,
} from "./multiPick";
import { useT } from "@intentic/ui/i18n";

// PICKING SOME OF MANY, sized to how many there are. A short list is drawn whole, a tick per row, since every option
// is one press and reads with its detail. A long one would be a wall of rows the owner scrolls past to find the two they
// meant, and could not read back at a glance afterwards; so past INLINE_LIMIT the panel shows only what is picked, as
// chips (a whole family or section picked is one chip), and everything else is one search away in a list that opens
// over the page (a sheet on a phone), grouped, with each group pickable at once.

const t = useT();

const {
    sections,
    picked,
    searchLabel,
    tally = false,
    disabled = false,
    inlineLimit = INLINE_LIMIT,
    ariaLabel,
} = defineProps<{
    sections: readonly PickSection[];
    picked: readonly string[];
    /** What the search finds ("Find a connection or secret"): the closed trigger's words and the open field's hint. */
    searchLabel: string;
    /** Say "n of m picked" with Select all and Clear over a short list too; a long one always says it. */
    tally?: boolean;
    disabled?: boolean;
    inlineLimit?: number;
    /** Names the list for assistive tech. */
    ariaLabel?: string;
}>();
const emit = defineEmits<{ change: [picked: string[]] }>();
// `mark` draws an option's glyph (a service's logo, a key), at the pixel size the place it sits in asks for.
defineSlots<{ mark?: (props: { value: string; size: number }) => VNode[] }>();

const options = computed(() => allOptions(sections));
const held = computed(() => new Set(picked));
const total = computed(() => options.value.length);
const count = computed(() => options.value.filter((option) => held.value.has(option.value)).length);
const long = computed(() => total.value > inlineLimit);

const set = (values: readonly string[], on: boolean): void => emit(`change`, withValues(picked, values, on));
const flip = (values: readonly string[]): void => set(values, stateOf(values, held.value) !== `all`);
const everyOne = (): void => set(valuesOf(sections.flatMap((section) => section.entries)), true);
const noneOf = (): void => emit(`change`, []);

/* THE SHORT LIST: rows, as every other access answer draws them. */

const inlineSections = computed(() => sections.map((section) => ({ ...section, options: allOptions([section]) })));

/* THE LONG LIST: chips for what is picked, and a search that opens the rest. */

const chips = computed(() => chipsOf(sections, held.value));
const allChips = ref(false);
const shownChips = computed(() => (allChips.value ? chips.value : chips.value.slice(0, CHIP_LIMIT)));
const foldedChips = computed(() => chips.value.length - shownChips.value.length);

const trigger = ref<HTMLButtonElement | null>(null);
const open = ref(false);
const query = ref(``);
const width = ref(0);
const { mobile } = useDevice();
const search = ref<{ focus: () => void } | null>(null);
const listId = useId();

const openList = (seed = ``): void => {
    if (disabled) {
        return;
    }
    query.value = seed;
    activeIndex.value = 0;
    // As wide as the field it opens from, within a comfortable reading measure.
    width.value = Math.min(Math.max(trigger.value?.offsetWidth ?? 0, 288), 512);
    open.value = true;
    void nextTick(() => {
        if (!mobile.value) {
            search.value?.focus();
        }
    });
};

// Typing on the closed field starts the search with what was typed, the way a real field would.
const onTriggerKey = (event: KeyboardEvent): void => {
    if (event.key === `ArrowDown` || (event.key.length === 1 && event.key !== ` ` && !event.ctrlKey && !event.metaKey && !event.altKey)) {
        event.preventDefault();
        openList(event.key === `ArrowDown` ? `` : event.key);
    }
};

const shown = computed(() => filterSections(sections, query.value));
const rows = computed(() => rowsOf(shown.value));
const walkable = computed<readonly PickableRow[]>(() => rows.value.filter(pickable));
const shownValues = computed(() => valuesOf(shown.value.flatMap((section) => section.entries)));
const searching = computed(() => query.value.trim() !== ``);
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(walkable, (row) => row.key);
const indexOf = (row: PickableRow): number => walkable.value.indexOf(row);
const optionId = (row: PickableRow): string => `${listId}-${indexOf(row)}`;

const onListKey = (event: KeyboardEvent): void => {
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
                flip(activeRow.value.values);
            }
            return;
        case `Escape`:
            // The query goes first, so Escape on a search steps back to the whole list before it closes anything.
            if (searching.value) {
                event.stopPropagation();
                query.value = ``;
                return;
            }
            open.value = false;
            return;
        default:
    }
};

const stateOfRow = (row: PickableRow): PickState => stateOf(row.values, held.value);
const optionNote = (option: PickOption, inFamily: boolean): string | undefined => (inFamily ? undefined : option.note);
</script>

<template>
    <!-- SHORT: every option a row. -->
    <div v-if="!long" class="flex flex-col gap-2.5">
        <div v-if="tally" class="flex items-center gap-3">
            <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.reachPickedCount`, { picked: count, total }) }}</span>
            <span class="ml-auto flex items-center gap-3">
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="disabled" @click="everyOne">
                    {{ t(`sandbox.sandboxAccess.selectAll`) }}
                </button>
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="disabled" @click="noneOf">
                    {{ t(`ui.action.clear`) }}
                </button>
            </span>
        </div>
        <div v-for="section in inlineSections" :key="section.key" class="flex flex-col gap-1">
            <span v-if="section.label !== undefined" :class="ui.sectionLabel({ size: `xs` })">{{ section.label }}</span>
            <div class="-mx-2.5 flex flex-col gap-0.5" role="group" :aria-label="section.label ?? ariaLabel">
                <label
                    v-for="option in section.options"
                    :key="option.value"
                    class="ui-row-select flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5"
                    :class="{ 'ui-row-select-on': held.has(option.value), 'pointer-events-none opacity-60': disabled }"
                >
                    <Checkbox
                        :model-value="held.has(option.value)"
                        binary
                        size="small"
                        :disabled="disabled"
                        @update:model-value="(on: unknown) => set([option.value], on === true)"
                    />
                    <slot name="mark" :value="option.value" :size="22" />
                    <span class="flex min-w-0 flex-1 items-baseline gap-2">
                        <span class="truncate text-content" :class="option.mono ? `font-mono text-xs` : `text-sm`">{{ option.label }}</span>
                        <span v-if="option.detail" class="truncate font-mono text-2xs text-subtle">{{ option.detail }}</span>
                    </span>
                    <span v-if="option.note" class="inline-flex shrink-0 items-center gap-1 text-xs text-subtle">
                        <Icon v-if="option.noteIcon" :name="option.noteIcon" class="text-2xs" />{{ option.note }}
                    </span>
                </label>
            </div>
        </div>
    </div>

    <!-- LONG: a search to pick from, then what is picked. -->
    <div v-else class="flex flex-col gap-2.5">
        <button
            ref="trigger"
            type="button"
            class="ui-field-box flex w-full cursor-pointer items-center gap-2 text-left disabled:cursor-default"
            :disabled="disabled"
            aria-haspopup="listbox"
            :aria-expanded="open"
            :aria-label="ariaLabel ?? searchLabel"
            @click="open ? (open = false) : openList()"
            @keydown="onTriggerKey"
        >
            <Icon name="search" class="shrink-0 text-xs text-subtle" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-subtle">{{ searchLabel }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ total }}</span>
            <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
        </button>

        <div class="flex items-center gap-3">
            <span class="text-xs text-muted" role="status">{{ t(`sandbox.sandboxAccess.reachPickedCount`, { picked: count, total }) }}</span>
            <button v-if="count > 0" type="button" class="ml-auto" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="disabled" @click="noneOf">
                {{ t(`ui.action.clear`) }}
            </button>
        </div>

        <ul v-if="chips.length > 0" class="flex flex-wrap gap-1.5" :aria-label="ariaLabel">
            <li
                v-for="chip in shownChips"
                :key="chip.key"
                class="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-canvas py-0.5 pl-1.5 pr-0.5 text-xs text-content"
            >
                <slot v-if="chip.lead !== undefined" name="mark" :value="chip.lead" :size="16" />
                <Icon v-else-if="chip.icon !== undefined" :name="chip.icon" class="shrink-0 text-2xs text-subtle" />
                <span class="min-w-0 truncate" :class="{ 'font-mono text-2xs': chip.mono }">{{ chip.label }}</span>
                <span v-if="chip.count !== undefined" class="shrink-0 text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.pickAllCount`, { count: chip.count }) }}</span>
                <button
                    type="button"
                    :class="ui.iconButton({ size: `xs`, tone: `subtle` })"
                    :disabled="disabled"
                    :aria-label="t(`sandbox.sandboxAccess.unpick`, { name: chip.label })"
                    @click="set(chip.values, false)"
                >
                    <Icon name="times" class="text-3xs" />
                </button>
            </li>
            <li v-if="foldedChips > 0 || allChips" class="inline-flex">
                <button type="button" :class="ui.chip()" @click="allChips = !allChips">
                    {{ allChips ? t(`sandbox.sandboxAccess.fewerChips`) : t(`sandbox.sandboxAccess.moreChips`, { count: foldedChips }) }}
                </button>
            </li>
        </ul>

        <ResponsiveOverlay v-model="open" :anchor="trigger ?? undefined" :header="searchLabel" side="bottom">
            <div class="flex min-h-0 min-w-0 flex-col" :style="mobile ? undefined : { width: `min(${width}px, calc(100vw - 1rem))` }" @keydown="onListKey">
                <SearchBar
                    ref="search"
                    v-model="query"
                    :placeholder="searchLabel"
                    :aria-label="searchLabel"
                    :aria-controls="listId"
                    :aria-activedescendant="activeRow === undefined ? undefined : optionId(activeRow)"
                />
                <div class="flex items-center gap-3 border-b border-line px-3 py-1.5">
                    <span class="text-2xs tabular-nums text-subtle">{{ t(`sandbox.sandboxAccess.reachPickedCount`, { picked: count, total }) }}</span>
                    <span class="ml-auto flex items-center gap-3">
                        <button
                            type="button"
                            :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                            :disabled="shownValues.length === 0"
                            @click="set(shownValues, true)"
                        >
                            {{ searching ? t(`sandbox.sandboxAccess.pickShown`, { count: shownValues.length }) : t(`sandbox.sandboxAccess.selectAll`) }}
                        </button>
                        <button
                            type="button"
                            :class="ui.textButton({ tone: `quiet`, size: `xs` })"
                            :disabled="stateOf(shownValues, held) === `none`"
                            @click="set(shownValues, false)"
                        >
                            {{ searching ? t(`sandbox.sandboxAccess.unpickShown`) : t(`ui.action.clear`) }}
                        </button>
                    </span>
                </div>
                <div
                    :id="listId"
                    role="listbox"
                    aria-multiselectable="true"
                    :aria-label="ariaLabel ?? searchLabel"
                    class="min-h-0 overflow-y-auto py-1 md:max-h-80"
                >
                    <template v-for="row in rows" :key="row.key">
                        <p v-if="row.kind === `label`" role="presentation" class="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-subtle">
                            {{ row.text }}
                        </p>
                        <button
                            v-else
                            :id="optionId(row)"
                            :ref="(el) => setRowEl(row.key, el)"
                            type="button"
                            role="option"
                            tabindex="-1"
                            :aria-selected="stateOfRow(row) === `all`"
                            class="ui-row-select ui-off flex w-full items-center gap-2 pr-3 text-left max-md:min-h-11"
                            :class="[
                                { 'ui-row-select-on': indexOf(row) === activeIndex },
                                row.kind === `option` && row.inFamily ? `pl-8` : `pl-3`,
                                row.kind === `section` ? `pb-1 pt-2` : `py-1.5`,
                            ]"
                            @click="flip(row.values)"
                            @mouseenter="activeIndex = indexOf(row)"
                        >
                            <!-- The box a checkbox would draw, inside a row that is the press: a header's can be half-ticked. -->
                            <span
                                aria-hidden="true"
                                class="flex size-3.5 shrink-0 items-center justify-center rounded-sm border transition-colors"
                                :class="stateOfRow(row) === `none` ? `border-line-strong bg-canvas` : `border-primary-fill bg-primary-fill text-fill-content`"
                            >
                                <Icon v-if="stateOfRow(row) === `all`" name="check" class="text-4xs" />
                                <Icon v-else-if="stateOfRow(row) === `some`" name="minus" class="text-4xs" />
                            </span>
                            <template v-if="row.kind === `section`">
                                <span class="min-w-0 flex-1 truncate text-2xs font-medium uppercase tracking-wide text-subtle">{{ row.section.label }}</span>
                                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ stateOfRow(row) === `none` ? row.values.length : `${row.values.filter((value) => held.has(value)).length}/${row.values.length}` }}</span>
                            </template>
                            <template v-else-if="row.kind === `family`">
                                <slot name="mark" :value="row.family.lead" :size="18" />
                                <span class="min-w-0 flex-1 truncate text-sm font-medium text-content md:text-xs">{{ row.family.label }}</span>
                                <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ stateOfRow(row) === `none` ? row.values.length : `${row.values.filter((value) => held.has(value)).length}/${row.values.length}` }}</span>
                            </template>
                            <template v-else>
                                <slot name="mark" :value="row.option.value" :size="18" />
                                <span class="flex min-w-0 flex-1 items-baseline gap-2">
                                    <span class="truncate text-content" :class="row.option.mono ? `font-mono text-xs` : `text-sm md:text-xs`">{{ row.option.label }}</span>
                                    <span v-if="row.option.detail" class="truncate font-mono text-2xs text-subtle">{{ row.option.detail }}</span>
                                </span>
                                <span v-if="optionNote(row.option, row.inFamily)" class="inline-flex shrink-0 items-center gap-1 text-2xs text-subtle">
                                    <Icon v-if="row.option.noteIcon" :name="row.option.noteIcon" class="text-3xs" />{{ optionNote(row.option, row.inFamily) }}
                                </span>
                            </template>
                        </button>
                    </template>
                    <p v-if="walkable.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">{{ t(`ui.pickerPanel.noMatches`) }}</p>
                </div>
                <div class="sr-only" aria-live="polite">{{ t(`ui.pickerPanel.options`, { count: shownValues.length }) }}</div>
                <div class="flex justify-end border-t border-line px-2 py-1.5">
                    <Button :label="t(`ui.action.done`)" size="small" tier="quiet" @click="open = false" />
                </div>
            </div>
        </ResponsiveOverlay>
    </div>
</template>
