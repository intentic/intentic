<!-- The browser menu's rows for what the browser keeps: the history page, the bookmarks manager, and the bookmarks bar's
     switch, ticked while it shows. Each closes the menu (`done`). -->
<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { HistoryOverlay } from "../history/historyOverlay";
import { bookmarksBarShown, toggleBookmarksBar } from "./bookmarksBar";

const { library } = defineProps<{ library: HistoryOverlay }>();
const emit = defineEmits<{ done: [] }>();

const t = useT();

const run = (verb: () => void): void => {
    emit(`done`);
    verb();
};
</script>

<template>
    <button
        type="button"
        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
        @click="run(() => library.open(`history`))"
    >
        <Icon name="history" class="shrink-0 text-2xs text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.history.open`) }}</span>
    </button>
    <button
        type="button"
        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
        @click="run(() => library.open(`bookmarks`))"
    >
        <Icon name="star" class="shrink-0 text-2xs text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.bookmarks.open`) }}</span>
    </button>
    <button
        type="button"
        role="menuitemcheckbox"
        :aria-checked="bookmarksBarShown"
        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
        @click="run(toggleBookmarksBar)"
    >
        <Icon name="check" class="shrink-0 text-2xs" :class="bookmarksBarShown ? 'text-content' : 'invisible'" />
        <span class="min-w-0 flex-1 truncate">{{ t(`browsers.bookmarks.showBar`) }}</span>
    </button>
</template>
