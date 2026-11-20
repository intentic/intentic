<!-- The browser's library over the tab in front: the history page (Ctrl+H) and the bookmarks manager, one tab each
     where either page puts its title, so moving between the two keeps the place they open in. Escape or the × closes it;
     a page picked in either goes where the view sends it (historyOverlay.ts). -->
<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import BookmarksManager from "../bookmarks/BookmarksManager.vue";
import BrowsingHistoryPage from "./BrowsingHistoryPage.vue";
import type { LibraryMode } from "./historyOverlay";

const emit = defineEmits<{ open: [url: string, newTab: boolean]; close: [] }>();
const mode = defineModel<LibraryMode>("mode", { required: true });

const t = useT();
const tabs = computed(() => [
    { label: t(`browsers.history.title`), value: `history` as const, icon: `history` as const },
    { label: t(`browsers.bookmarks.title`), value: `bookmarks` as const, icon: `star` as const },
]);

const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape` && !event.defaultPrevented) {
        event.preventDefault();
        emit(`close`);
    }
};
</script>

<template>
    <div class="h-full min-h-0" @keydown="onKeydown">
        <component
            :is="mode === `history` ? BrowsingHistoryPage : BookmarksManager"
            class="h-full"
            @open="(url: string, newTab: boolean) => emit(`open`, url, newTab)"
            @close="emit(`close`)"
        >
            <template #heading>
                <SegmentedControl v-model="mode" :options="tabs" variant="underline" class="min-w-0 flex-1" />
            </template>
        </component>
    </div>
</template>
