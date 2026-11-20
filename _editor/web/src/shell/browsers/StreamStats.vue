<!-- A live picture's stream, in numbers, over its corner: frames drawn, how old they are when drawn, the decoder's time,
     the round trip, castd's queue and bitrate, what was dropped, the picture's size and the sound's buffer. Asked of the
     decode worker only while shown (mediaPicture's showStats); switched for the whole editor (streamStats.ts). -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import type { MediaPicture } from "../../models/browsers/media/mediaPicture";
import { statLines } from "../../models/browsers/media/streamStats";

const props = defineProps<{ media: MediaPicture }>();

const lines = computed(() => (props.media.stats.value === undefined ? [] : statLines(props.media.stats.value)));

onMounted(() => props.media.showStats(true));
onBeforeUnmount(() => props.media.showStats(false));
</script>

<template>
    <div
        class="pointer-events-none absolute right-2 top-2 z-10 rounded-md bg-canvas/85 px-2 py-1 font-mono text-3xs leading-4 text-content shadow-sm"
    >
        <div v-for="line in lines" :key="line.label" class="flex justify-between gap-3">
            <span class="text-muted">{{ line.label }}</span>
            <span class="tabular-nums">{{ line.value }}</span>
        </div>
    </div>
</template>
