<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { type JumpScope, jumpScopes, scopedQuery } from "../../workbench/commands/jumpSearch";
import { type PaletteRow, useFileJumpRows, useJumpRows } from "./useJumpRows";
import { useQuickOpen } from "../../workbench/commands/useQuickOpen";
import { type IconName, Modal, Notice, SearchBar, SectionHeader, ui, useListNavigation } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// The jump palette (Ctrl/Cmd+P, and Ctrl/Cmd+Shift+P opened on `>`): one field over agents, files, terminals and
// commands at once. Where a row comes from and how the kinds are ordered is useJumpRows and jumpSearch; this file is
// the field, the scope chips and one keyboard running over every visible row, headings ignored.

const t = useT();

// Given `openFile`, the palette is files alone, each opened by it: a local window's (local/LocalFiles.vue), which has
// no agents, terminals or commands to jump to and no route but its own. Read once, as a window is one kind or the other.
const { openFile } = defineProps<{ openFile?: (path: string) => void }>();
const filesOnly = openFile !== undefined;
const titleId = useId();
const label = computed(() => filesOnly ? t(`local.quickOpen.goToFile`) : t(`shell.quickOpen.jumpTo`));

const { isOpen, mode, seed, mounted } = useQuickOpen();
onMounted(() => {
    mounted.value = true;
});
onBeforeUnmount(() => {
    mounted.value = false;
});
const query = ref(``);
const {
    parsed,
    sections: grouped,
    rows,
    floor,
    searching,
    pending,
    truncated,
    error,
} = openFile === undefined ? useJumpRows(query, isOpen) : useFileJumpRows(query, isOpen, openFile);

const scopes = computed<readonly JumpScope[]>(() => (filesOnly ? [] : jumpScopes()));

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

const input = ref<InstanceType<typeof SearchBar> | null>(null);
// The highlight resets to the top only when the result set itself changes (keyed on the rows, not the array), so a live
// fleet tick (an agent's status line moving while its row stays put) can't throw the reader back to the top.
const { activeIndex, activeRow, move, setRowEl } = useListNavigation(rows, (row) => row.key);

const run = (row: PaletteRow): void => {
    isOpen.value = false;
    row.run();
};

const openActive = (): void => {
    if (activeRow.value !== undefined) {
        run(activeRow.value);
    }
};

// A chip press writes its prefix into the field rather than holding a scope beside it: one state, which is why
// Backspace is all it takes to widen the search again.
const narrow = async (scope: JumpScope): Promise<void> => {
    query.value = scopedQuery(scope.kind, parsed.value.text);
    await nextTick();
    input.value?.focus(`end`);
};

// Focuses the field and resets to the top row each time the palette opens. Seeds the query from the shortcut that
// opened it: `> ` for the Command Palette, empty for the unscoped jump.
const onShow = async (): Promise<void> => {
    // Words handed over by whatever opened it (searchInQuickOpen) are the search already under way, kept like a prefix.
    const seeded = seed.value;
    seed.value = undefined;
    query.value = seeded ?? (mode.value === `commands` && !filesOnly ? `> ` : ``);
    await nextTick();
    // Caret at the end, not selected, so the next keystroke can't wipe the `> ` prefix.
    input.value?.focus(seeded !== undefined || (mode.value === `commands` && !filesOnly) ? `end` : true);
    activeIndex.value = 0;
};
</script>

<template>
    <Modal v-model:open="isOpen" size="md" :chrome="false" :scroll="false" :labelled-by="titleId" position="top" @show="onShow">
        <div>
            <h2 :id="titleId" class="sr-only">{{ label }}</h2>
            <!-- The panel's top band, not a boxed field: the panel border and the divider under it are already its frame. -->
            <SearchBar
                ref="input"
                v-model="query"
                :placeholder="filesOnly ? t(`local.quickOpen.fileName`) : t(`shell.quickOpen.jumpToPaste`)"
                :busy="searching || pending"
                role="combobox"
                :aria-label="label"
                aria-expanded="true"
                aria-autocomplete="list"
                aria-controls="quick-open-list"
                :aria-activedescendant="activeIndex < rows.length ? `quick-open-opt-${activeIndex}` : undefined"
                @keydown.down.prevent="move(1)"
                @keydown.up.prevent="move(-1)"
                @keydown.enter.prevent="openActive"
                @keydown.esc="isOpen = false"
            />
            <!-- The only place the prefixes are taught: a press is the mouse's way in, the glyph beside it is the keyboard's. -->
            <div
                v-if="scopes.length > 0"
                class="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5"
                role="group"
                :aria-label="t(`shell.quickOpen.narrowTo`)"
            >
                <button
                    v-for="scope in scopes"
                    :key="scope.label"
                    type="button"
                    :class="ui.chip({ on: parsed.kind === scope.kind })"
                    :aria-pressed="parsed.kind === scope.kind"
                    @click="narrow(scope)"
                >
                    <Icon :name="scope.icon" aria-hidden="true" />
                    {{ scope.label }}
                    <kbd v-if="scope.prefix" class="font-mono text-subtle">{{ scope.prefix }}</kbd>
                </button>
            </div>
            <div class="max-h-80 overflow-auto py-1">
                <Notice v-if="truncated" tone="warning" size="xs" class="mx-1.5 mb-1">{{ t(`shell.quickOpen.showingFirstMatchesOnly`) }}</Notice>
                <div id="quick-open-list" role="listbox" :aria-label="label" :aria-busy="searching || pending">
                    <div v-for="section in sections" :key="section.heading" role="group" :aria-label="section.heading">
                        <SectionHeader aria-hidden="true" :label="section.heading" density="dense" class="px-3 pb-1 pt-0.5" />
                        <button
                            v-for="(row, index) in section.rows"
                            :id="`quick-open-opt-${section.from + index}`"
                            :key="row.key"
                            :ref="(el) => setRowEl(row.key, el)"
                            type="button"
                            role="option"
                            tabindex="-1"
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
                    </div>
                </div>
                <p v-if="error" role="alert" class="px-3 py-3 text-center text-2xs text-danger">{{ error }}</p>
                <p v-else-if="rows.length === 0 && (searching || pending)" class="px-3 py-3 text-center text-2xs text-subtle">
                    <Icon name="spinner" spin />
                </p>
                <!-- Files alone, nothing typed and no tab open: what to type, since there are no kinds above to pick. -->
                <p v-else-if="filesOnly && rows.length === 0 && parsed.text.length === 0" class="px-3 py-3 text-center text-2xs text-subtle">
                    {{ t(`local.quickOpen.typeFileName`) }}
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
                <p v-else-if="rows.length === 0" role="status" class="px-3 py-3 text-center text-2xs text-subtle">{{ t(`shell.quickOpen.noMatches`) }}</p>
            </div>
        </div>
    </Modal>
</template>
