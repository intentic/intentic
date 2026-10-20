<script setup lang="ts">
import { ContextMenu, Icon, SearchBar, SegmentedControl, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, useTemplateRef } from "vue";
import { useAudience } from "../../../app/useAudience";
import { folderSurface } from "../../../client/sandbox/useDaemonRoutes";
import { matchToggles } from "../../../models/workspace/search/useSearchOptions";
import { useLayout } from "../../../workbench/window/useLayout";
import type { ExplorerSearchBox } from "./useExplorerSearch";

// The explorer's search box over the Files list, one for every explorer that lists files: the workspace's
// (WorkspaceDesktop.vue) and a desktop window's on a folder of this computer (local/LocalFiles.vue). One query in three
// scopes: Name filters the tree, Text and Smart ask the files' own search. Text's switches (Aa, ab, .*) and the files to
// include ride along where they apply, and the funnel holds what the list leaves out. Smart reads an index only a
// sandbox keeps, so a folder of this computer, which has none, is not offered it.

const {
    search,
    treeFilters = [],
    treeFiltered = false,
    filterTip,
} = defineProps<{
    search: ExplorerSearchBox;
    // Rows the host adds to the funnel while the tree shows (the workspace's persona lens), and whether one is on.
    treeFilters?: readonly MenuItem[];
    treeFiltered?: boolean;
    // What the lit funnel says instead of its name: what the host's own rows have narrowed.
    filterTip?: Tip | undefined;
}>();

const emit = defineEmits<{
    // Enter in the field.
    submit: [];
}>();

const t = useT();
const layout = useLayout();
const { maker } = useAudience();
const { filter, scope, contentMode, textMode, options, clear } = search;

const scopes = computed(() => [
    { label: t(`shared.name`), value: `name` as const, title: t(`workspace.workspaceDesktop.scopeNameHint`) },
    { label: t(`workspace.words.text`), value: `text` as const, title: t(`workspace.workspaceDesktop.scopeTextHint`) },
    ...(folderSurface.value
        ? []
        : [{ label: t(`workspace.workspaceDesktop.smart`), value: `smart` as const, title: t(`workspace.workspaceDesktop.scopeSmartHint`) }]),
]);

// Rows follow the scope: Name filters the tree the explorer draws, Text and Smart reach the search's own match list.
const filterMenu = ref<{ show: (event: Event) => void }>();
const filterItems = computed<MenuItem[]>(() =>
    contentMode.value
        ? [
              {
                  label: t(`workspace.workspaceDesktop.searchIgnoredFiles`),
                  checked: options.includeIgnored.value,
                  command: () => (options.includeIgnored.value = !options.includeIgnored.value),
              },
          ]
        : [
              {
                  label: t(`workspace.workspaceDesktop.showIgnoredFiles`),
                  checked: layout.showIgnored.value,
                  command: () => layout.toggleShowIgnored(),
              },
              { label: t(`workspace.workspaceDesktop.hideTests`), checked: layout.hideTests.value, command: () => layout.toggleHideTests() },
              {
                  label: t(`workspace.workspaceDesktop.hideTechnicalFiles`),
                  checked: layout.hideTechnical.value,
                  command: () => layout.toggleHideTechnical(),
              },
              ...treeFilters,
          ],
);
// Lit whenever the list isn't the default one, so a missing spec or a search into node_modules never reads as the files
// themselves changing. The technical switch is a maker's default, so it lights only when it disagrees with the audience.
const filtersActive = computed(() =>
    contentMode.value
        ? options.includeIgnored.value
        : layout.showIgnored.value || layout.hideTests.value || layout.hideTechnical.value !== maker.value || treeFiltered,
);

const includeTip = computed(
    (): Tip => ({
        title: t(`workspace.words.filesToInclude`),
        rows: [
            { label: `package.json`, value: t(`workspace.workspaceDesktop.anywhere`) },
            { label: `./src`, value: t(`workspace.workspaceDesktop.fromRoot`) },
            { label: `!dist`, value: t(`workspace.workspaceDesktop.excluded`) },
        ],
        note: t(`workspace.workspaceDesktop.commaSeparated`),
    }),
);

const bar = useTemplateRef<InstanceType<typeof SearchBar>>(`bar`);
defineExpose({
    // Into the field with what it holds selected, so typing replaces the last query.
    focus: (): void => bar.value?.focus(true),
});
</script>

<template>
    <!-- One `filter` across three scopes; the Aa/ab/.* switches apply only to the text scope, which has a pattern. -->
    <div class="flex shrink-0 flex-col gap-1.5 p-1.5">
        <SearchBar
            ref="bar"
            v-model="filter"
            variant="field"
            dense
            clearable
            :busy="contentMode && (search.results.searching.value || search.results.pending.value)"
            :placeholder="contentMode ? t(`workspace.words.searchInFiles`) : t(`workspace.workspaceDesktop.filterFiles`)"
            :aria-label="contentMode ? t(`workspace.words.searchInFiles`) : t(`workspace.workspaceDesktop.filterFiles`)"
            @clear="clear"
            @keydown.enter.prevent="emit(`submit`)"
        >
            <!-- Same three switches, same order, as the editor this models. -->
            <template v-if="textMode" #controls>
                <button
                    v-for="toggle in matchToggles()"
                    :key="toggle.label"
                    type="button"
                    class="ui-search-toggle"
                    :aria-pressed="toggle.state.value"
                    v-tooltip.bottom="toggle.title"
                    :aria-label="toggle.title"
                    @click="toggle.state.value = !toggle.state.value"
                >
                    {{ toggle.label }}
                </button>
            </template>
        </SearchBar>
        <!-- Files-to-include glob (VSCode grammar), its own field since it's typed, not toggled; content search only. -->
        <SearchBar
            v-if="contentMode"
            v-model="options.include.value"
            variant="field"
            dense
            clearable
            icon="folder"
            :placeholder="t(`workspace.words.filesToIncludeE`)"
            :aria-label="t(`workspace.words.filesToInclude`)"
            v-tooltip.bottom="includeTip"
        />
        <div class="flex items-center gap-1">
            <SegmentedControl v-model="scope" size="xs" :options="scopes" />
            <span class="flex-1"></span>
            <!-- This control reports which files the list omits. -->
            <button
                type="button"
                :class="ui.iconButton({ on: filtersActive }, `shrink-0`)"
                aria-haspopup="menu"
                :aria-label="t(`workspace.words.filterWhatExplorerLists`)"
                v-tooltip.bottom="filterTip ?? t(`workspace.words.filter`)"
                @click="filterMenu?.show($event)"
            >
                <Icon name="filter" class="text-xs" />
            </button>
            <!-- What only one host's explorer offers beside the funnel (the workspace's cover, health, collapse all). -->
            <slot name="tools"></slot>
        </div>
        <ContextMenu ref="filterMenu" :model="filterItems" :min-width="11" />
    </div>
</template>
