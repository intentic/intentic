<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";
import { useT } from "@intentic/ui/i18n";
import { stopWaiting, whenNear } from "../../../workspace/home/nearViewport";
import { type AsideReason, type ChatShot, shotName, sortShots } from "./shots";
import { shotLook } from "./shotLooks";
import { picture } from "../../../workspace/home/thumbnails";
import PictureQuickLook from "../attachments/PictureQuickLook.vue";
import { type QuickLookBox, aspectOf, quickLookBox } from "../attachments/pictureQuickLook";

// The pictures a finished turn's tools showed the agent, standing at the turn's end where its answer is read: the last
// few as tiles, the rest behind a count on the first. A pointer resting on a tile shows it bigger (pictureQuickLook), and a
// press opens the conversation's viewer at that picture.
//
// Pictures with nothing on them, and repeats of one shown before (sortShots), are set aside behind a quiet line rather
// than dropped: a blank page can be the very bug, so one press shows them, dimmed among the rest, and the viewer walks
// what the strip draws. Unfolded tool calls draw every picture regardless, as the record of what ran.

const t = useT();

const props = defineProps<{
    shots: readonly ChatShot[];
    // Whose checkout the pictures are read in (thumbnails.ts), undefined for the shared tree.
    agent: string | undefined;
    // Whether the reader asked to see the pictures set aside.
    revealed: boolean;
}>();

const emit = defineEmits<{ view: [shot: ChatShot]; reveal: [shown: boolean] }>();

// One row at the reading width; the count on the first tile stands for everything before it.
const SHOWN = 4;

// How many shots the first tile stands for besides its own; zero draws no count.
const earlier = computed(() => Math.max(0, drawn.value.length - SHOWN));

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

// Judged only once near, since judging reads each picture's tile; until then nothing is set aside, and nothing drawn.
const sorted = computed(() =>
    near.value ? sortShots(props.shots, (shot) => shotLook(props.agent, shot.path)) : { shown: props.shots, aside: new Map<string, AsideReason>() },
);
const drawn = computed(() => (props.revealed ? props.shots : sorted.value.shown));

// The line saying what was set aside, named for what it holds.
const asideLine = computed(() => {
    const reasons = new Set(sorted.value.aside.values());
    const count = sorted.value.aside.size;
    if (count === 0) {
        return undefined;
    }
    const kind = reasons.size > 1 ? `asideMixed` : reasons.has(`plain`) ? `asidePlain` : `asideRepeat`;
    const what = t(`chat.chatTurnShots.${kind}`, { count }, count);
    return props.revealed ? t(`chat.chatTurnShots.asideShown`, { what }) : t(`chat.chatTurnShots.asideHidden`, { what });
});
const asideTip = (reason: AsideReason | undefined): string | undefined =>
    reason === undefined ? undefined : t(reason === `plain` ? `chat.chatTurnShots.plainTip` : `chat.chatTurnShots.repeatTip`);

// A pointer resting on a tile is about to open it: its view starts coming now, not on the press.
const prefetch = (shot: ChatShot): void => {
    picture(props.agent, shot.path, `view`);
};

// The tile being looked at and where its look is drawn. The look shows the tile's own shot (not the one a counted tile
// opens), at the viewer's size once that arrives and the strip's until then, so it never waits on a blank.
const shown = ref<{ shot: ChatShot; box: QuickLookBox }>();
const look = (event: Event, shot: ChatShot, opens: ChatShot): void => {
    prefetch(opens);
    prefetch(shot);
    const tile = event.currentTarget as HTMLElement;
    shown.value = { shot, box: quickLookBox(tile, aspectOf(tile.querySelector(`img`))) };
};
const hideLook = (): void => {
    shown.value = undefined;
};
onBeforeUnmount(hideLook);
const quickLookSrc = computed(() => {
    const shot = shown.value?.shot;
    return shot === undefined ? undefined : (picture(props.agent, shot.path, `view`)?.url ?? picture(props.agent, shot.path, `strip`)?.url);
});

const tiles = computed(() =>
    drawn.value.slice(-SHOWN).map((shot, index) => ({
        shot,
        name: shotName(shot.path),
        // Held until the picture is judged too, so a blank one never flashes into the strip before it is set aside.
        picture: near.value && shotLook(props.agent, shot.path) !== undefined ? picture(props.agent, shot.path, `strip`) : undefined,
        // The counted tile opens the turn's first shot, so the viewer walks forward through everything it stands for.
        opens: index === 0 && earlier.value > 0 ? drawn.value[0]! : shot,
        counted: index === 0 && earlier.value > 0,
        aside: sorted.value.aside.get(shot.key),
    })),
);
</script>

<template>
    <!-- Inset like the answer's own prose, so the pictures read as part of it rather than as the column's next block. -->
    <section ref="root" class="flex flex-col gap-1.5 px-3.5" :aria-label="t(`chat.chatTurnShots.region`)">
        <div v-if="tiles.length > 0" class="grid grid-cols-4 gap-2">
            <button
                v-for="tile in tiles"
                :key="tile.shot.key"
                type="button"
                class="chat-inset relative aspect-[16/10] min-w-0 cursor-pointer overflow-hidden rounded-md border border-line transition-[border-color,opacity] hover:border-line-strong"
                :class="tile.aside && !tile.counted && `opacity-50 hover:opacity-100`"
                :aria-label="
                    tile.counted ? t(`chat.chatTurnShots.openAll`, { count: drawn.length }) : t(`chat.chatTurnShots.open`, { name: tile.name })
                "
                v-tooltip.bottom="tile.counted ? undefined : asideTip(tile.aside)"
                @pointerenter="look($event, tile.shot, tile.opens)"
                @pointerleave="hideLook"
                @focus="prefetch(tile.opens)"
                @click="
                    hideLook();
                    emit(`view`, tile.opens);
                "
            >
                <!-- Cropped from the top: a full-page capture is tall, and its top is the part that says which page it is. -->
                <img v-if="tile.picture?.url" :src="tile.picture.url" alt="" class="h-full w-full object-cover object-top" />
                <span
                    v-else-if="tile.picture"
                    class="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-2xs text-subtle"
                >
                    <Icon name="image" class="text-xs" />{{ t(`chat.words.gone`) }}
                </span>
                <span v-else class="block h-full w-full animate-pulse" />
                <span
                    v-if="tile.counted"
                    class="absolute inset-0 flex items-center justify-center bg-canvas/70 text-sm font-medium text-content tabular-nums"
                >
                    {{ t(`chat.chatTurnShots.more`, { count: earlier + 1 }) }}
                </span>
            </button>
        </div>
        <!-- What was set aside, said once and quietly; the press is the word, not the line. -->
        <p v-if="asideLine" class="flex items-center gap-1.5 text-2xs text-subtle">
            <Icon name="image" class="text-2xs" />
            <span>{{ asideLine }}</span>
            <span aria-hidden="true">·</span>
            <button
                type="button"
                class="cursor-pointer text-subtle underline-offset-2 transition-colors hover:text-content hover:underline"
                :aria-pressed="revealed"
                @click="emit(`reveal`, !revealed)"
            >
                {{ revealed ? t(`chat.chatTurnShots.hide`) : t(`chat.chatTurnShots.show`) }}
            </button>
        </p>
        <PictureQuickLook :src="quickLookSrc" :alt="shown ? shotName(shown.shot.path) : ``" :box="shown?.box" />
    </section>
</template>
