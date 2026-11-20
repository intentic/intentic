<!-- The browser menu's switch for the stream's numbers over the picture (StreamStats.vue). -->
<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { streamStatsShown, toggleStreamStats } from "../../models/browsers/media/streamStats";

const emit = defineEmits<{ picked: [] }>();
const t = useT();
</script>

<template>
    <button
        type="button"
        class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
        :aria-pressed="streamStatsShown"
        @click="
            emit(`picked`);
            toggleStreamStats();
        "
    >
        <Icon name="wave-pulse" class="shrink-0 text-2xs text-muted" />
        <span class="min-w-0 flex-1 truncate">{{ streamStatsShown ? t(`browsers.media.hideStats`) : t(`browsers.media.showStats`) }}</span>
    </button>
</template>
