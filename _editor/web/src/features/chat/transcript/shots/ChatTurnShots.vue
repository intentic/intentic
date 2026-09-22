<script setup lang="ts">
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { type ChatShot, shotName } from "./shots";
import { tileOf } from "./shotPictures";

// The pictures a finished turn's tools showed the agent, standing at the turn's end where its answer is read: the last
// few as tiles, the rest behind a count on the first. A press opens the conversation's viewer at that picture.

const t = useT();

const props = defineProps<{
    shots: readonly ChatShot[];
    // Whose checkout the pictures are read in (shotPictures), undefined for the shared tree.
    agent: string | undefined;
}>();

const emit = defineEmits<{ view: [shot: ChatShot] }>();

// One row at the reading width; the count on the first tile stands for everything before it.
const SHOWN = 4;

// How many shots the first tile stands for besides its own; zero draws no count.
const earlier = computed(() => Math.max(0, props.shots.length - SHOWN));

const tiles = computed(() =>
    props.shots.slice(-SHOWN).map((shot, index) => ({
        shot,
        name: shotName(shot.path),
        picture: tileOf(props.agent, shot.path),
        // The counted tile opens the turn's first shot, so the viewer walks forward through everything it stands for.
        opens: index === 0 && earlier.value > 0 ? props.shots[0]! : shot,
        counted: index === 0 && earlier.value > 0,
    })),
);
</script>

<template>
    <!-- Inset like the answer's own prose, so the pictures read as part of it rather than as the column's next block. -->
    <section class="grid grid-cols-4 gap-2 px-3.5" :aria-label="t(`chat.chatTurnShots.region`)">
        <button
            v-for="tile in tiles"
            :key="tile.shot.key"
            type="button"
            class="chat-inset relative aspect-[16/10] min-w-0 cursor-pointer overflow-hidden rounded-md border border-line transition-colors hover:border-line-strong"
            :aria-label="tile.counted ? t(`chat.chatTurnShots.openAll`, { count: shots.length }) : t(`chat.chatTurnShots.open`, { name: tile.name })"
            v-tooltip.top="tile.name"
            @click="emit(`view`, tile.opens)"
        >
            <!-- Cropped from the top: a full-page capture is tall, and its top is the part that says which page it is. -->
            <img v-if="tile.picture?.url" :src="tile.picture.url" alt="" class="h-full w-full object-cover object-top" />
            <span v-else-if="tile.picture" class="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-2xs text-subtle">
                <Icon name="image" class="text-xs" />{{ t(`chat.chatTurnShots.gone`) }}
            </span>
            <span v-else class="block h-full w-full animate-pulse" />
            <span v-if="tile.counted" class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-sm font-medium text-content tabular-nums">
                {{ t(`chat.chatTurnShots.more`, { count: earlier + 1 }) }}
            </span>
        </button>
    </section>
</template>
