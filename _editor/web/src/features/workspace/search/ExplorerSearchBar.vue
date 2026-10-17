<script setup lang="ts">
import { ContextMenu, Icon, SegmentedControl, type Tip, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref } from "vue";
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

const input = ref<HTMLInputElement>();
defineExpose({
    // Into the field with what it holds selected, so typing replaces the last query.
    focus: (): void => {
        input.value?.focus();
        input.value?.select();
    },
});
</script>

<template>
    <!-- One `filter` across three scopes; the Aa/ab/.* switches apply only to the text scope, which has a pattern. -->
    <div class="flex shrink-0 flex-col gap-1 p-1.5">
        <div class="relative">
            <Icon
                class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle"
                aria-hidden="true"
                :name="contentMode && (search.results.searching.value || search.results.pending.value) ? `spinner` : `search`"
                :spin="contentMode && (search.results.searching.value || search.results.pending.value)"
            />
            <input
                ref="input"
                v-model="filter"
                type="text"
                :placeholder="contentMode ? t(`workspace.words.searchInFiles`) : t(`workspace.workspaceDesktop.filterFiles`)"
                :aria-label="contentMode ? t(`workspace.words.searchInFiles`) : t(`workspace.workspaceDesktop.filterFiles`)"
                class="ui-field-box ui-field-sm w-full min-w-0 pl-7"
                :class="textMode ? `pr-[4.75rem]` : `pr-7`"
                @keydown.esc="clear"
                @keydown.enter.prevent="emit(`submit`)"
            />
            <div class="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <!-- Same three switches, same order, as the editor this models. -->
                <template v-if="textMode">
                    <button
                        v-for="toggle in matchToggles()"
                        :key="toggle.label"
                        type="button"
                        :class="
                            ui.iconButton({ size: `xs`, tone: `subtle` }, `font-mono text-3xs leading-none`, toggle.state.value ? `bg-primary-600/20 text-link` : ``)
                        "
                        :aria-pressed="toggle.state.value"
                        v-tooltip.bottom="toggle.title"
                        :aria-label="toggle.title"
                        @mousedown.prevent
                        @click="toggle.state.value = !toggle.state.value"
                    >
                        {{ toggle.label }}
                    </button>
                </template>
                <button
                    v-if="filter"
                    type="button"
                    class="flex items-center rounded text-2xs text-subtle transition-colors hover:text-content"
                    v-tooltip.bottom="{ title: t(`ui.action.clear`), keys: t(`ui.keys.esc`) }"
                    :aria-label="t(`ui.action.clearFilter`)"
                    @click="clear"
                >
                    <Icon name="times" />
                </button>
            </div>
        </div>
        <!-- Files-to-include glob (VSCode grammar), its own field since it's typed, not toggled; content search only. -->
        <div v-if="contentMode" class="relative">
            <Icon class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-2xs text-subtle" aria-hidden="true" name="folder" />
            <input
                v-model="options.include.value"
                type="text"
                :placeholder="t(`workspace.words.filesToIncludeE`)"
                class="ui-field-box ui-field-sm w-full min-w-0 pr-2 pl-7"
                :aria-label="t(`workspace.words.filesToInclude`)"
                v-tooltip.bottom="includeTip"
                @keydown.esc="options.include.value = ``"
            />
        </div>
        <div class="flex items-center gap-1">
            <SegmentedControl v-model="scope" size="xs" :options="scopes" />
            <span class="flex-1"></span>
            <!-- This control reports which files the list omits. -->
            <button
                type="button"
                class="flex shrink-0 items-center rounded-md px-1.5 py-0.5 transition-colors"
                :class="filtersActive ? 'bg-primary-600/15 text-link' : 'text-muted hover:text-content'"
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
