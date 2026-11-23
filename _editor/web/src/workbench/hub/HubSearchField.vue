<!-- The hub's search field: finds a page or a single setting in either hub, by its name or by the words people use for it. -->
<script setup lang="ts">
import { SearchBar } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { HubSearchPanel } from "./useHubSearchPanel";

const t = useT();

const { search, listId } = defineProps<{
    search: HubSearchPanel;
    /** The answers' listbox, which the field drives: the highlight lives there, not here. */
    listId: string;
}>();

const activeId = (): string | undefined =>
    search.searching.value && search.activeIndex.value < search.rows.value.length ? `${listId}-${search.activeIndex.value}` : undefined;
</script>

<template>
    <!-- Filled, as <NavRail>'s own filter is: the first thing on a column that has no other boxes in it. `/` reaches it
         from anywhere on the hub, as it does on most sites with one search: a settings page is read with the mouse, and a
         key that needs no reach is what turns that into typing. -->
    <SearchBar
        v-model="search.query.value"
        variant="field"
        shortcut="/"
        :placeholder="t(`shell.hubSearch.placeholder`)"
        :aria-label="t(`shell.hubSearch.placeholder`)"
        :aria-controls="listId"
        :aria-activedescendant="activeId()"
        clearable
        class="shrink-0"
        @keydown.down.prevent="search.move(1)"
        @keydown.up.prevent="search.move(-1)"
        @keydown.enter.prevent="search.openActive()"
    />
</template>
