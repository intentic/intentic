<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { type JumpScope, jumpScopes, scopedQuery } from "./jumpSearch";
import { type PaletteRow, useJumpRows } from "./useJumpRows";
import { useQuickOpen } from "./useQuickOpen";
import { type IconName, Modal } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// The jump palette (Ctrl/Cmd+P, and Ctrl/Cmd+Shift+P opened on `>`): one field over agents, files, terminals and
// commands at once. Where a row comes from and how the kinds are ordered is useJumpRows and jumpSearch; this file is
// the field, the scope chips and one keyboard running over every visible row, headings ignored.

const t = useT();

const { isOpen, mode } = useQuickOpen();
const query = ref(``);
const { parsed, sections: grouped, rows, floor, searching, pending, truncated, error } = useJumpRows(query, isOpen);

const scopes = computed<readonly JumpScope[]>(() => jumpScopes());

// Each section's first row's place in the flat list, so a row can name its own index without the list being walked
// again per row.
const sections = computed(() => {
    let from = 0;
    return grouped.value.map((section) => {
        const placed = { ...section, from };
        from += section.rows.length;
        return placed;
    });
});

const input = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const rowEls = new Map<string, HTMLElement>();

// Resets the highlight to the top when the result set itself changes — keyed on the rows rather than on the array, so
// a live fleet tick (an agent's status line moving while its row stays put) can't throw the reader back to the top.
watch(
    () => rows.value.map((row) => row.key).join(`\u0000`),
    () => (activeIndex.value = 0),
);

const setRowEl = (key: string, el: unknown): void => {
    if (el) {
        rowEls.set(key, el as HTMLElement);
    } else {
        rowEls.delete(key);
    }
};

const run = (row: PaletteRow): void => {
    isOpen.value = false;
    row.run();
};

const move = (delta: number): void => {
    const count = rows.value.length;
    if (count === 0) {
        return;
    }
    activeIndex.value = (activeIndex.value + delta + count) % count;
    rowEls.get(rows.value[activeIndex.value]?.key ?? ``)?.scrollIntoView({ block: `nearest` });
};

const openActive = (): void => {
    const row = rows.value[activeIndex.value];
    if (row !== undefined) {
        run(row);
    }
};

// A chip press writes its prefix into the field rather than holding a scope beside it: one state, which is why
// Backspace is all it takes to widen the search again.
const narrow = async (scope: JumpScope): Promise<void> => {
    query.value = scopedQuery(scope.kind, parsed.value.text);
    await nextTick();
    input.value?.focus();
    const end = input.value?.value.length ?? 0;
    input.value?.setSelectionRange(end, end);
};

// Focuses the field and resets to the top row each time the palette opens. Seeds the query from the shortcut that
// opened it: `> ` for the Command Palette, empty for the unscoped jump.
const onShow = async (): Promise<void> => {
    query.value = mode.value === `commands` ? `> ` : ``;
    await nextTick();
    input.value?.focus();
    // Caret at the end, not selected, so the next keystroke can't wipe the `> ` prefix.
    if (mode.value === `commands`) {
        const end = input.value?.value.length ?? 0;
        input.value?.setSelectionRange(end, end);
    } else {
        input.value?.select();
    }
    activeIndex.value = 0;
};
</script>

<template>
    <Modal v-model:open="isOpen" size="md" :chrome="false" :scroll="false" position="top" @show="onShow">
        <div role="combobox" aria-haspopup="listbox" aria-expanded="true" :aria-label="t(`shell.quickOpen.jumpTo`)">
            <!-- field-bare: the search is the panel's top band, not a boxed field — the panel border and this divider are already its frame. -->
            <div class="ui-search-row relative border-b border-line">
                <Icon
                    class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-subtle"
                    aria-hidden="true"
                    :name="searching || pending ? `spinner` : `search`"
                    :spin="searching || pending"
                />
                <input
                    ref="input"
                    v-model="query"
                    type="text"
                    :placeholder="t(`shell.quickOpen.jumpToPaste`)"
                    class="field-bare w-full min-w-0 py-2.5 pl-9 pr-3"
                    role="searchbox"
                    aria-controls="quick-open-list"
                    :aria-activedescendant="activeIndex < rows.length ? `quick-open-opt-${activeIndex}` : undefined"
                    @keydown.down.prevent="move(1)"
                    @keydown.up.prevent="move(-1)"
                    @keydown.enter.prevent="openActive"
                    @keydown.esc="isOpen = false"
                />
            </div>
            <!-- The only place the prefixes are taught: a press is the mouse's way in, the glyph beside it is the keyboard's. -->
            <div class="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5" role="group" :aria-label="t(`shell.quickOpen.narrowTo`)">
                <button
                    v-for="scope in scopes"
                    :key="scope.label"
                    type="button"
                    class="ui-chip"
                    :class="{ 'ui-chip-on': parsed.kind === scope.kind }"
                    :aria-pressed="parsed.kind === scope.kind"
                    @click="narrow(scope)"
                >
                    <Icon :name="scope.icon" aria-hidden="true" />
                    {{ scope.label }}
                    <kbd v-if="scope.prefix" class="font-mono text-subtle">{{ scope.prefix }}</kbd>
                </button>
            </div>
            <div id="quick-open-list" class="max-h-80 overflow-auto py-1" role="listbox" :aria-label="t(`shell.quickOpen.jumpTo`)">
                <p
                    v-if="truncated"
                    class="mx-1.5 mb-1 inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-2xs text-warning"
                >
                    <Icon name="exclamation-triangle" class="text-[0.6rem]" /> {{ t(`shell.quickOpen.showingFirstMatchesOnly`) }}
                </p>
                <template v-for="section in sections" :key="section.heading">
                    <p class="px-3 pb-1 pt-0.5 text-2xs font-medium uppercase tracking-wide text-subtle">{{ section.heading }}</p>
                    <button
                        v-for="(row, index) in section.rows"
                        :id="`quick-open-opt-${section.from + index}`"
                        :key="row.key"
                        :ref="(el) => setRowEl(row.key, el)"
                        type="button"
                        role="option"
                        :aria-selected="section.from + index === activeIndex"
                        class="ui-row-select flex w-full items-center gap-2 px-3 py-1.5 text-left"
                        :class="{ 'ui-row-select-on': section.from + index === activeIndex }"
                        @click="run(row)"
                        @mouseenter="activeIndex = section.from + index"
                    >
                        <Icon :name="row.icon as IconName" class="shrink-0 text-2xs" :class="row.tone ?? `text-muted`" />
                        <span class="min-w-0 truncate text-sm text-content">{{ row.title }}</span>
                        <span class="min-w-0 flex-1 truncate text-2xs text-subtle">{{ row.detail }}</span>
                        <kbd v-if="row.chord" class="shrink-0 rounded border border-line bg-overlay px-1.5 py-0.5 font-mono text-2xs text-muted">{{
                            row.chord
                        }}</kbd>
                    </button>
                </template>
                <p v-if="error" class="px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
                <p v-else-if="rows.length === 0 && (searching || pending)" class="px-3 py-3 text-center text-2xs text-subtle">
                    <Icon name="spinner" spin />
                </p>
                <!-- The floor is the file half's alone, so it is only worth saying while the palette is pointed at files. -->
                <p
                    v-else-if="rows.length === 0 && parsed.kind === `file` && parsed.text.length < floor"
                    class="px-3 py-3 text-center text-2xs text-subtle"
                >
                    {{ t(`shell.quickOpen.typeAtLeastCharacters`, { floor }) }}
                </p>
                <!-- Nothing typed and nothing to list: a first session, where "nothing matches" would answer a question nobody asked. -->
                <p v-else-if="rows.length === 0 && parsed.text.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    {{ t(`shell.quickOpen.typeToSearch`) }}
                </p>
                <p v-else-if="rows.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">{{ t(`shell.quickOpen.noMatches`) }}</p>
            </div>
        </div>
    </Modal>
</template>
