<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useT } from "@intentic/ui/i18n";
import { stopWaiting, whenNear } from "../../../workspace/home/nearViewport";
import { type ChatShot, shotName } from "./shots";
import { picture } from "../../../workspace/home/thumbnails";
import PicturePeek from "../attachments/PicturePeek.vue";
import { type PeekBox, aspectOf, peekBox } from "../attachments/picturePeek";

// The pictures a finished turn's tools showed the agent, standing at the turn's end where its answer is read: the last
// few as tiles, the rest behind a count on the first. A pointer resting on a tile peeks it bigger (picturePeek), and a
// press opens the conversation's viewer at that picture.

const t = useT();

const props = defineProps<{
    shots: readonly ChatShot[];
    // Whose checkout the pictures are read in (thumbnails.ts), undefined for the shared tree.
    agent: string | undefined;
}>();

const emit = defineEmits<{ view: [shot: ChatShot] }>();

// One row at the reading width; the count on the first tile stands for everything before it.
const SHOWN = 4;

// How many shots the first tile stands for besides its own; zero draws no count.
const earlier = computed(() => Math.max(0, props.shots.length - SHOWN));

// A strip far up the transcript asks for nothing until it is scrolled near, so the turn the chat opens on loads first.
const root = useTemplateRef<HTMLElement>(`root`);
const near = ref(false);
onMounted(() => {
    if (root.value !== null) {
        whenNear(root.value, () => (near.value = true));
    }
});
onBeforeUnmount(() => {
    if (root.value !== null) {
        stopWaiting(root.value);
    }
});

// A pointer resting on a tile is about to open it: its view starts coming now, not on the press.
const prefetch = (shot: ChatShot): void => {
    picture(props.agent, shot.path, `view`);
};

// The tile being peeked and where its peek is drawn. The peek shows the tile's own shot (not the one a counted tile
// opens), at the viewer's size once that arrives and the strip's until then, so it never waits on a blank.
const peeked = ref<{ shot: ChatShot; box: PeekBox }>();
const peek = (event: Event, shot: ChatShot, opens: ChatShot): void => {
    prefetch(opens);
    prefetch(shot);
    const tile = event.currentTarget as HTMLElement;
    peeked.value = { shot, box: peekBox(tile, aspectOf(tile.querySelector(`img`))) };
};
const unpeek = (): void => {
    peeked.value = undefined;
};
onBeforeUnmount(unpeek);
const peekSrc = computed(() => {
    const shot = peeked.value?.shot;
    return shot === undefined ? undefined : (picture(props.agent, shot.path, `view`)?.url ?? picture(props.agent, shot.path, `strip`)?.url);
});

const tiles = computed(() =>
    props.shots.slice(-SHOWN).map((shot, index) => ({
        shot,
        name: shotName(shot.path),
        picture: near.value ? picture(props.agent, shot.path, `strip`) : undefined,
        // The counted tile opens the turn's first shot, so the viewer walks forward through everything it stands for.
        opens: index === 0 && earlier.value > 0 ? props.shots[0]! : shot,
        counted: index === 0 && earlier.value > 0,
    })),
);
</script>

<template>
    <!-- Inset like the answer's own prose, so the pictures read as part of it rather than as the column's next block. -->
    <section ref="root" class="grid grid-cols-4 gap-2 px-3.5" :aria-label="t(`chat.chatTurnShots.region`)">
        <button
            v-for="tile in tiles"
            :key="tile.shot.key"
            type="button"
            class="chat-inset relative aspect-[16/10] min-w-0 cursor-pointer overflow-hidden rounded-md border border-line transition-colors hover:border-line-strong"
            :aria-label="tile.counted ? t(`chat.chatTurnShots.openAll`, { count: shots.length }) : t(`chat.chatTurnShots.open`, { name: tile.name })"
            @pointerenter="peek($event, tile.shot, tile.opens)"
            @pointerleave="unpeek"
            @focus="prefetch(tile.opens)"
            @click="
                unpeek();
                emit(`view`, tile.opens);
            "
        >
            <!-- Cropped from the top: a full-page capture is tall, and its top is the part that says which page it is. -->
            <img v-if="tile.picture?.url" :src="tile.picture.url" alt="" class="h-full w-full object-cover object-top" />
            <span
                v-else-if="tile.picture"
                class="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-2xs text-subtle"
            >
                <Icon name="image" class="text-xs" />{{ t(`shared.gone`) }}
            </span>
            <span v-else class="block h-full w-full animate-pulse" />
            <span
                v-if="tile.counted"
                class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-sm font-medium text-content tabular-nums"
            >
                {{ t(`chat.chatTurnShots.more`, { count: earlier + 1 }) }}
            </span>
        </button>
        <PicturePeek :src="peekSrc" :alt="peeked ? shotName(peeked.shot.path) : ``" :box="peeked?.box" />
    </section>
</template>
