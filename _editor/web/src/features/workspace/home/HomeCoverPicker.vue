<!-- The cover control: a button offering a file name to read in every folder, or, once one is chosen, a chip naming it (on the home), or the same button lit (in the explorer's toolbar). -->
<script setup lang="ts">
import { type IconName, iconForEntry, ResponsiveOverlay, type Tip, ui, useListNavigation } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, watch } from "vue";
import { useLayout } from "../../../workbench/window/useLayout";
import { withinScope } from "../../../app/projectScope";
import { useWorkspaceTree } from "../explorer/useWorkspaceTree";
import { coverChoices } from "./homeCover";

// The names offered are the ones the loaded tree repeats across folders, most folders first, which is also what says
// what this is for; any other name can be typed. Choosing is HomeView's (`choose`), since the home decides what a
// change of view clears.

const t = useT();

const { cover, compact = false } = defineProps<{
    cover: string | undefined;
    // The explorer toolbar's form: one glyph among its switches, lit while a cover is chosen, where a chip has no room.
    compact?: boolean;
}>();
const emit = defineEmits<{ choose: [name: string]; drop: [] }>();

const { entriesByPath } = useWorkspaceTree();
const layout = useLayout();

const open = ref(false);
const anchor = ref<HTMLElement>();
const field = ref<HTMLInputElement>();
const query = ref(``);

// Enough to show what a codebase is made of without scrolling; typing reaches the rest.
const CHOICES = 8;
// Counted only while the list is open: it walks everything loaded, and nothing else reads it.
const choices = computed(() => {
    if (!open.value) {
        return [];
    }
    const showIgnored = layout.explorerFilters.value.showIgnored;
    const files = [...entriesByPath.value.values()].filter(
        (entry) => entry.type === `file` && withinScope(entry.path) && (showIgnored || entry.ignored !== true),
    );
    return coverChoices(files, CHOICES);
});

type Row =
    | { readonly kind: `all` }
    | { readonly kind: `typed`; readonly name: string }
    | { readonly kind: `choice`; readonly name: string; readonly folders: number };

// The way back to the tiles first while a cover is on; then the list, narrowed; then the name as typed, when the list
// does not hold it. Last, not first: "readme" is someone on the way to README.md, which Enter should give them.
const rows = computed<readonly Row[]>(() => {
    const typed = query.value.trim();
    const needle = typed.toLowerCase();
    const listed = choices.value.filter((choice) => choice.name.toLowerCase().includes(needle));
    const back: Row[] = cover !== undefined && needle === `` ? [{ kind: `all` }] : [];
    const own: Row[] = needle !== `` && !choices.value.some((choice) => choice.name.toLowerCase() === needle) ? [{ kind: `typed`, name: typed }] : [];
    return [...back, ...listed.map((choice): Row => ({ kind: `choice`, ...choice })), ...own];
});
const keyOf = (row: Row): string => (row.kind === `all` ? `\u0000all` : `${row.kind}:${row.name}`);
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, keyOf);

const iconOf = (row: Row): IconName => (row.kind === `all` ? `th-large` : iconForEntry(row.name, `file`));
const labelOf = (row: Row): string => (row.kind === `all` ? t(`workspace.homeCover.allFiles`) : row.name);

// What the trigger says it does to a screen reader; its hover says the same as a card.
const label = computed(() => (cover === undefined ? t(`workspace.homeCover.choose`) : t(`workspace.homeCover.showing`, { name: cover })));
const tip = computed((): Tip =>
    cover === undefined
        ? { title: t(`workspace.homeCover.showAFile`), note: t(`workspace.homeCover.fromEveryFolder`) }
        : { title: t(`workspace.homeCover.inEveryFolder`), rows: [{ label: t(`workspace.homeCover.file`), value: cover }] },
);
// The toolbar's switches' own look (the funnel beside it), so a lit book reads as a filter that is on.
const compactClass = computed(() => [
    `flex shrink-0 items-center rounded-md px-1.5 py-0.5 transition-colors`,
    cover !== undefined || open.value ? `bg-primary-600/15 text-link` : `text-muted hover:text-content`,
]);

const pick = (row: Row | undefined): void => {
    if (row === undefined) {
        return;
    }
    open.value = false;
    if (row.kind === `all`) {
        emit(`drop`);
        return;
    }
    emit(`choose`, row.name);
};

const toggle = (): void => {
    open.value = !open.value;
};
// Each opening starts from an empty field, on the name already chosen when there is one.
watch(open, async (isOpen) => {
    if (!isOpen) {
        return;
    }
    query.value = ``;
    await nextTick();
    const chosen = rows.value.findIndex((row) => row.kind === `choice` && row.name === cover);
    activeIndex.value = Math.max(chosen, 0);
    field.value?.focus();
});

const onFieldKey = (event: KeyboardEvent): void => {
    if (event.key === `ArrowDown` || event.key === `ArrowUp`) {
        event.preventDefault();
        move(event.key === `ArrowDown` ? 1 : -1);
        return;
    }
    if (event.key === `Enter`) {
        event.preventDefault();
        pick(activeRow.value);
        return;
    }
    // A typed name is cleared before the list closes, the way every filter field here answers Escape.
    if (event.key === `Escape` && query.value !== ``) {
        event.stopPropagation();
        query.value = ``;
    }
};
</script>

<template>
    <!-- Keys and clicks stay here: the home reads both, and a chip's Enter is not a folder being entered. -->
    <div class="flex shrink-0 items-center" @click.stop @keydown.stop @contextmenu.stop>
        <button
            v-if="compact || cover === undefined"
            ref="anchor"
            type="button"
            :class="compact ? compactClass : ui.iconButton({ on: open })"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-pressed="compact ? cover !== undefined : undefined"
            :aria-label="label"
            v-tooltip.bottom="tip"
            @click="toggle"
        >
            <Icon name="book" :class="compact ? `text-xs` : ``" />
        </button>
        <!-- The chosen name, lit, as the one state the home is in that its tiles would not explain; × goes back to them. -->
        <span v-else :class="ui.chip({ on: true }, `h-6 cursor-default gap-0 p-0`)" v-tooltip.bottom="tip">
            <!-- The anchor is this button, not the chip: a chooser closed without a choice hands the keyboard back to it. -->
            <button
                ref="anchor"
                type="button"
                class="flex h-full items-center gap-1.5 rounded-l-full pr-1 pl-2.5 focus-visible:outline-none"
                aria-haspopup="dialog"
                :aria-expanded="open"
                :aria-label="t(`workspace.homeCover.showing`, { name: cover })"
                @click="toggle"
            >
                <Icon name="book" aria-hidden="true" />
                <span class="max-w-40 truncate font-mono font-medium">{{ cover }}</span>
                <Icon name="chevron-down" class="text-4xs" aria-hidden="true" />
            </button>
            <button
                type="button"
                class="flex h-full items-center rounded-r-full pr-2 pl-1 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-none"
                :aria-label="t(`workspace.homeCover.showAllFiles`)"
                @click="emit(`drop`)"
            >
                <Icon name="times" class="text-3xs" />
            </button>
        </span>

        <ResponsiveOverlay v-model="open" :anchor="anchor" side="bottom" cross="end" :header="t(`workspace.homeCover.choose`)" panel-class="w-72 p-1">
            <input
                ref="field"
                v-model="query"
                type="text"
                :placeholder="t(`workspace.homeCover.typeName`)"
                :aria-label="t(`workspace.homeCover.typeName`)"
                class="ui-field-box ui-field-sm w-full"
                spellcheck="false"
                autocomplete="off"
                @keydown="onFieldKey"
            />
            <p class="px-2 pt-2 pb-1 text-2xs text-subtle">{{ t(`workspace.homeCover.choose`) }}</p>
            <ul role="listbox" class="max-h-72 overflow-y-auto" :aria-label="t(`workspace.homeCover.choose`)">
                <li
                    v-for="(row, index) in rows"
                    :key="keyOf(row)"
                    :ref="(el) => setRowEl(keyOf(row), el)"
                    role="option"
                    :aria-selected="index === activeIndex"
                    class="ui-row-select flex h-8 items-center gap-2 rounded-md px-2 text-xs"
                    :class="index === activeIndex ? `ui-row-select-on` : ``"
                    @pointermove="activeIndex = index"
                    @click="pick(row)"
                >
                    <Icon :name="iconOf(row)" class="shrink-0 text-sm text-muted" aria-hidden="true" />
                    <span class="min-w-0 flex-1 truncate" :class="row.kind === `all` ? `` : `font-mono`">{{ labelOf(row) }}</span>
                    <span v-if="row.kind === `choice`" class="shrink-0 text-2xs tabular-nums text-subtle">{{
                        t(`workspace.homeCover.inFolders`, { count: row.folders }, row.folders)
                    }}</span>
                    <span v-else-if="row.kind === `typed`" class="shrink-0 text-2xs text-subtle">{{ t(`workspace.homeCover.asTyped`) }}</span>
                    <Icon v-if="row.kind === `choice` && row.name === cover" name="check" class="shrink-0 text-2xs text-link" aria-hidden="true" />
                </li>
            </ul>
            <p v-if="rows.length === 0" class="px-2 py-2 text-2xs text-subtle">{{ t(`workspace.homeCover.noChoices`) }}</p>
        </ResponsiveOverlay>
    </div>
</template>
