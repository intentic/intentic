<!-- Whether the remote picture comes straight from the computer or through the sandbox, and how well (screenBadge.ts).
     Asks the decode worker for the stream's numbers only while it is on screen. -->
<script setup lang="ts">
import { toneWash } from "@intentic/ui";
import { computed, onBeforeUnmount, onMounted } from "vue";
import type { MediaPicture } from "../../../../models/browsers/media/mediaPicture";
import { screenBadge } from "./screenBadge";
import type { ScreenStatus } from "./useDeviceScreen";

const { picture, status, compact = false } = defineProps<{
    picture: MediaPicture;
    status: ScreenStatus;
    // A phone's toolbar: the word alone, the numbers in its tip.
    compact?: boolean;
}>();

const badge = computed(() => screenBadge(status, picture.carrier.value, picture.stats.value));
const tip = computed(() =>
    compact && badge.value.detail !== undefined ? { ...badge.value.tip, rows: [{ label: badge.value.label, value: badge.value.detail }] } : badge.value.tip,
);

onMounted(() => picture.showStats(true));
onBeforeUnmount(() => picture.showStats(false));
</script>

<template>
    <span
        :class="toneWash(badge.tone, `inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs font-medium`)"
        role="status"
        v-tooltip.bottom="tip"
    >
        <span class="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true"></span>
        <span>{{ badge.label }}</span>
        <span v-if="!compact && badge.detail" class="truncate font-normal tabular-nums opacity-80">{{ badge.detail }}</span>
    </span>
</template>
