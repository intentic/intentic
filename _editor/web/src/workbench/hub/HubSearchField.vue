<!-- The hub's search field: finds a page or a single setting in either hub, by its name or by the words people use for it. -->
<script setup lang="ts">
import { isOverlayTarget, isTypingTarget, SearchBar, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onBeforeUnmount, onMounted, useTemplateRef } from "vue";
import type { HubSearchPanel } from "./useHubSearchPanel";

const t = useT();

const { search, listId } = defineProps<{
    search: HubSearchPanel;
    /** The answers' listbox, which the field drives: the highlight lives there, not here. */
    listId: string;
}>();

const bar = useTemplateRef<InstanceType<typeof SearchBar>>(`bar`);
// The `/` hint is for a keyboard; a phone's field is reached by a tap.
const { mobile } = useDevice();

// `/` reaches the field from anywhere on the hub, as it does on most sites with one search: a settings page is read with
// the mouse, and a key that needs no reach is what turns that into typing. Never from a field or an open overlay, which
// own their keys, and never with a modifier, which is someone's chord.
const onKey = (event: KeyboardEvent): void => {
    if (event.key !== `/` || event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || isOverlayTarget(event.target)) {
        return;
    }
    event.preventDefault();
    bar.value?.focus(true);
};
onMounted(() => window.addEventListener(`keydown`, onKey));
onBeforeUnmount(() => window.removeEventListener(`keydown`, onKey));

const activeId = (): string | undefined =>
    search.searching.value && search.activeIndex.value < search.rows.value.length ? `${listId}-${search.activeIndex.value}` : undefined;
</script>

<template>
    <!-- Filled, as <NavRail>'s own filter is: the first thing on a column that has no other boxes in it. -->
    <div class="flex shrink-0 items-center rounded-md bg-content/[0.045]">
        <SearchBar
            ref="bar"
            v-model="search.query.value"
            :placeholder="t(`shell.hubSearch.placeholder`)"
            :aria-label="t(`shell.hubSearch.placeholder`)"
            :aria-controls="listId"
            :aria-activedescendant="activeId()"
            clearable
            class="min-w-0 flex-1 border-b-0"
            @keydown.down.prevent="search.move(1)"
            @keydown.up.prevent="search.move(-1)"
            @keydown.enter.prevent="search.openActive()"
        />
        <kbd
            v-if="!search.searching.value && !mobile"
            class="mr-2 shrink-0 rounded border border-line px-1 font-mono text-3xs text-subtle"
            aria-hidden="true"
            >/</kbd
        >
    </div>
</template>
