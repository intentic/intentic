<!-- One desk tile: a glyph (or, for a picture or video, the thing itself) over a name; the quick look on hover carries the facts. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { explorerColorClass, type IconName, iconForEntry } from "@intentic/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { thumbnailKind, thumbnailUrl } from "./thumbnails";

const {
    entry,
    selected = false,
    locked = false,
    pending = false,
    dimmed = false,
    tabindex = -1,
} = defineProps<{
    entry: WorkspaceTreeEntry;
    selected?: boolean;
    // Kept private by the sandbox: opens its explanation, never its contents.
    locked?: boolean;
    // Still arriving (an upload in flight): drawn where it will land, inert until the listing has it.
    pending?: boolean;
    // Ignored by tooling, or a link that goes nowhere.
    dimmed?: boolean;
    // Roving: the selected tile (or the first) is the one the Tab key reaches.
    tabindex?: number;
}>();

const emit = defineEmits<{ select: []; open: []; enter: [el: HTMLElement]; leave: [] }>();

const icon = computed<IconName>(() => (locked ? `lock` : iconForEntry(entry.name, entry.type)));
// Always the colourful hue, whatever the tree's own setup: a 2rem glyph in the minimal setup's grey reads as disabled.
const color = computed(() => (locked ? `text-subtle` : explorerColorClass(`colorful`, entry.name, entry.type, dimmed)));
const quiet = computed(() => dimmed || locked || pending);

// --- The thumbnail: fetched once the tile is near the viewport, never for a folder of four hundred off-screen shots. ---
const kind = computed(() => (locked || pending ? undefined : thumbnailKind(entry)));
const art = ref<HTMLElement>();
const src = ref<string>();
// Painted, so the swap from glyph to picture can fade rather than pop.
const shown = ref(false);
const failed = ref(false);
let near = false;
let retried = false;
let observer: IntersectionObserver | undefined;

const load = (): void => {
    if (kind.value === undefined) {
        return;
    }
    void thumbnailUrl(entry, kind.value).then(
        (url) => {
            src.value = url;
        },
        () => {
            failed.value = true;
        },
    );
};
onMounted(() => {
    if (kind.value === undefined || art.value === undefined) {
        return;
    }
    observer = new IntersectionObserver(
        (hits) => {
            if (hits.some((hit) => hit.isIntersecting)) {
                near = true;
                load();
            }
        },
        { rootMargin: `240px` },
    );
    observer.observe(art.value);
});
onBeforeUnmount(() => observer?.disconnect());
// A rewritten file (same path, new size) is a new picture.
watch(
    () => `${entry.path} ${entry.size ?? 0}`,
    () => {
        src.value = undefined;
        shown.value = false;
        failed.value = false;
        retried = false;
        if (near) {
            load();
        }
    },
);
// A URL evicted from the shared cache under a tile still on screen breaks its image; one more fetch gets a fresh one,
// and a second failure means the file itself, so the glyph stands in.
const onError = (): void => {
    src.value = undefined;
    shown.value = false;
    if (retried) {
        failed.value = true;
        return;
    }
    retried = true;
    load();
};
// A frame to show: `preload="metadata"` alone may leave the element blank until asked to seek.
const seekFrame = (event: Event): void => {
    const video = event.target as HTMLVideoElement;
    if (video.currentTime === 0) {
        video.currentTime = 0.01;
    }
};
</script>

<template>
    <button
        type="button"
        role="option"
        :aria-selected="selected"
        :data-desk-tile="entry.path"
        :tabindex="tabindex"
        class="ui-row-select flex w-full flex-col items-center gap-1.5 rounded-lg px-2 pt-3 pb-2 text-center select-none"
        :class="{ 'ui-row-select-on': selected, 'opacity-60': pending }"
        @click="emit('select')"
        @dblclick="emit('open')"
        @pointerenter="emit('enter', $event.currentTarget as HTMLElement)"
        @pointerleave="emit('leave')"
    >
        <!-- One height for every tile, glyph or thumbnail, so names sit on one line across a row. -->
        <span ref="art" class="relative flex h-14 w-full items-center justify-center">
            <img
                v-if="kind === 'picture' && src !== undefined && !failed"
                :src="src"
                alt=""
                class="ui-desk-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @load="shown = true"
                @error="onError"
            />
            <video
                v-else-if="kind === 'video' && src !== undefined && !failed"
                :src="src"
                muted
                playsinline
                preload="metadata"
                class="ui-desk-move max-h-14 max-w-[6.5rem] rounded-sm object-contain ring-1 ring-line/60"
                :class="shown ? 'opacity-100' : 'opacity-0'"
                @loadedmetadata="seekFrame"
                @loadeddata="shown = true"
                @error="onError"
            ></video>
            <!-- The glyph holds the place until a thumbnail has painted, and stays where none can. -->
            <Icon v-if="!shown" :name="icon" class="text-[2.125rem]" :class="[color, src !== undefined && !failed ? 'absolute' : '']" />
            <!-- A link wears its target's glyph; the small mark says it is one. -->
            <Icon v-if="entry.link !== undefined" name="link" class="absolute right-2 bottom-0 text-[0.65rem] text-subtle" aria-label="Link" />
        </span>
        <span class="line-clamp-2 w-full text-xs leading-snug [overflow-wrap:anywhere]" :class="quiet ? 'text-subtle' : 'text-content/90'">{{
            entry.name
        }}</span>
    </button>
</template>
