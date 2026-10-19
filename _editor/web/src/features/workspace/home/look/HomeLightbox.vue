<!-- The home's full-window view of a picture or a video: asked for (Space, or a tile's expand button), never raised by a hover. -->
<script setup lang="ts">
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { Button, explorerColorClass, formatBytes, iconForEntry, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { canAnimate, lessMotion } from "@intentic/ui/motion";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { mediaBox, requestBoxes } from "../../../../models/workspace/home/mediaBoxes";
import { kindLabel } from "../../../../models/workspace/home/quickLookContent";
import { edgeFor, screenScale, tileArt } from "../../../../models/workspace/home/thumbnails";
import { edgeNeeded, galleryArtOf } from "../homeGallery";
import { mediaCard, type Size } from "./quickLookFrame";
import { useLookPicture } from "./useLookPicture";

// Over the whole window, in the window's own ground, the picture as large as it fits and never past its own pixels. It
// grows out of the tile it was opened from, so the eye follows the picture rather than finding it again. The arrows
// step through the folder's pictures and videos, Escape and Space close it, Enter opens the file in its viewer.

const t = useT();

const { entries, tileOf } = defineProps<{
    // The folder's pictures and videos, in the home's order: what the arrows step through.
    entries: readonly WorkspaceTreeEntry[];
    // The tile drawing a path, where it is on screen, for the picture to grow out of.
    tileOf: (path: string) => HTMLElement | undefined;
}>();
// The entry shown; undefined is closed.
const path = defineModel<string | undefined>(`path`);
// `close` names the entry it ended on, for the home to land the keyboard there.
const emit = defineEmits<{ close: [last: string | undefined]; open: [entry: WorkspaceTreeEntry] }>();

const index = computed(() => entries.findIndex((entry) => entry.path === path.value));
const entry = computed(() => entries[index.value]);
const medium = computed(() => (entry.value === undefined ? undefined : galleryArtOf(entry.value)));
const icon = computed(() => (entry.value === undefined ? `image` : iconForEntry(entry.value.name, entry.value.type)));
const color = computed(() =>
    entry.value === undefined ? `` : explorerColorClass(`colorful`, entry.value.name, entry.value.type, entry.value.ignored),
);

// --- Where the picture stands: centred in the stage, clear of the arrows either side. -------------------------------
const stage = ref<HTMLElement>();
const room = shallowRef<Size>({ width: 0, height: 0 });
// Room either side for the arrows, and above and below so the picture never touches the bar.
const SIDE = 72;
const BELOW = 24;
let sizes: ResizeObserver | undefined;
watch(stage, (next, previous) => {
    // Vue clears a template ref to null, not undefined, when its element goes.
    if (previous instanceof Element) {
        sizes?.unobserve(previous);
    }
    if (next instanceof Element) {
        sizes ??= new ResizeObserver(() => {
            room.value = { width: stage.value?.clientWidth ?? 0, height: stage.value?.clientHeight ?? 0 };
        });
        sizes.observe(next);
    }
});
// What the element says of the picture once drawn, for a file the daemon has not measured.
const drawn = shallowRef<Size>();
const known = computed(() => (entry.value === undefined ? undefined : mediaBox(entry.value)));
// The picture's own pixels, which it is never blown up past; an SVG has none, and fills the room as sharp.
const own = computed(() => (known.value?.exact === true && entry.value?.name.toLowerCase().endsWith(`.svg`) !== true ? known.value : undefined));
const aspect = computed(() => {
    const pictureBox = known.value ?? drawn.value;
    return pictureBox === undefined || pictureBox.height <= 0 ? Number.NaN : pictureBox.width / pictureBox.height;
});
const box = computed(() => {
    const { width, height } = room.value;
    const fitted = mediaCard({ width: width - 2 * SIDE, height: height - BELOW }, aspect.value, {
        cap: { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
        own: own.value,
        chrome: { width: 0, height: 0 },
        minWidth: 0,
    }).media;
    return { ...fitted, left: Math.round((width - fitted.width) / 2), top: Math.round((height - BELOW - fitted.height) / 2) };
});
const pictureStyle = computed(() => ({
    left: `${box.value.left}px`,
    top: `${box.value.top}px`,
    width: `${box.value.width}px`,
    height: `${box.value.height}px`,
}));
// The size the box needs on this screen, as a srcset would pick it; never past the picture's own long edge.
const edge = computed(() =>
    box.value.width === 0
        ? undefined
        : edgeFor(
              edgeNeeded(
                  box.value.width,
                  box.value.height,
                  aspect.value,
                  screenScale.value,
                  own.value === undefined ? undefined : Math.max(own.value.width, own.value.height),
              ),
          ),
);
const { picture, stream } = useLookPicture(
    () => entry.value,
    () => medium.value,
    () => edge.value,
);

// The neighbours are fetched at the same size while this one is looked at, so the arrows land on a sharp picture.
watch([index, edge], () => {
    const at = edge.value;
    if (at === undefined) {
        return;
    }
    for (const neighbour of [entries[index.value - 1], entries[index.value + 1]]) {
        const kind = neighbour === undefined ? undefined : galleryArtOf(neighbour);
        if (neighbour !== undefined && kind !== undefined) {
            // allow(silent-catch): a neighbour that will not load is fetched again when it is the one looked at
            void tileArt(neighbour, kind, at).catch(() => undefined);
        }
    }
});

const facts = computed(() => {
    const shown = entry.value;
    if (shown === undefined) {
        return ``;
    }
    const size = known.value?.exact === true ? known.value : undefined;
    const pixels = size === undefined ? undefined : `${size.width} × ${size.height}`;
    return [kindLabel(shown), pixels, formatBytes(shown.size)].filter((part) => part !== undefined && part !== ``).join(` · `);
});

// --- Moving and closing -----------------------------------------------------------------------------------------------
const step = (by: number): void => {
    const next = entries[Math.min(entries.length - 1, Math.max(0, index.value + by))];
    if (next !== undefined) {
        drawn.value = undefined;
        path.value = next.path;
    }
};
const close = (): void => {
    const last = path.value;
    path.value = undefined;
    emit(`close`, last);
};
const openShown = (): void => {
    const shown = entry.value;
    if (shown !== undefined) {
        close();
        emit(`open`, shown);
    }
};
const KEYS = new Map([
    [`Escape`, close],
    [` `, close],
    [`Enter`, openShown],
    [`ArrowLeft`, () => step(-1)],
    [`ArrowRight`, () => step(1)],
    [`Home`, () => step(-entries.length)],
    [`End`, () => step(entries.length)],
]);
// Every key is the view's while it is open: none reaches the tiles under it.
const onKey = (event: KeyboardEvent): void => {
    const act = event.ctrlKey || event.metaKey || event.altKey ? undefined : KEYS.get(event.key);
    // Enter on a focused button is that button's; Space closes wherever the focus is, as it opened.
    if (act !== undefined && !(event.target instanceof HTMLButtonElement && event.key === `Enter`)) {
        event.preventDefault();
        event.stopPropagation();
        act();
    }
};

const onPictureDrawn = (event: Event): void => {
    // SAFETY: bound to an <img>'s load event, whose target is that element.
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        drawn.value = { width: img.naturalWidth, height: img.naturalHeight };
    }
};
const onVideoDrawn = (event: Event): void => {
    // SAFETY: bound to a <video>'s loadedmetadata event, whose target is that element.
    const video = event.target as HTMLVideoElement;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
        drawn.value = { width: video.videoWidth, height: video.videoHeight };
    }
};

// --- Opening: the picture grows out of its tile ------------------------------------------------------------------------
const root = ref<HTMLElement>();
const art = ref<HTMLElement>();
const GROW_MS = 220;
const grow = (from: DOMRect, to: HTMLElement): void => {
    const end = to.getBoundingClientRect();
    if (end.width === 0 || from.width === 0 || lessMotion() || !canAnimate(to)) {
        return;
    }
    const dx = from.left + from.width / 2 - (end.left + end.width / 2);
    const dy = from.top + from.height / 2 - (end.top + end.height / 2);
    to.animate(
        [
            { transform: `translate(${dx}px, ${dy}px) scale(${from.width / end.width}, ${from.height / end.height})`, borderRadius: `12px` },
            { transform: `none` },
        ],
        { duration: GROW_MS, easing: `cubic-bezier(0.2, 0.8, 0.2, 1)` },
    );
};
watch(
    () => path.value !== undefined,
    async (open) => {
        if (!open) {
            return;
        }
        // The tile's picture box, read before the view covers it.
        const from = path.value === undefined ? undefined : tileOf(path.value)?.querySelector(`span`)?.getBoundingClientRect();
        void requestBoxes(entries);
        await nextTick();
        root.value?.focus({ preventScroll: true });
        // Measured now rather than when the observer first reports, which is after the first frame: the picture must
        // stand in its place before it can grow into it.
        room.value = { width: stage.value?.clientWidth ?? 0, height: stage.value?.clientHeight ?? 0 };
        await nextTick();
        if (from !== undefined && art.value !== undefined) {
            grow(from, art.value);
        }
    },
    { immediate: true },
);
onBeforeUnmount(() => sizes?.disconnect());

const position = computed(() => t(`workspace.homeLightbox.position`, { at: index.value + 1, count: entries.length }));
</script>

<template>
    <Teleport to="body">
        <Transition
            enter-active-class="transition-opacity duration-200 ease-out"
            enter-from-class="opacity-0"
            leave-active-class="transition-opacity duration-150 ease-in"
            leave-to-class="opacity-0"
        >
            <div
                v-if="entry !== undefined"
                ref="root"
                v-focustrap
                class="fixed inset-0 z-[1000] flex flex-col bg-canvas/95 backdrop-blur-md focus:outline-none"
                role="dialog"
                aria-modal="true"
                :aria-label="entry.name"
                tabindex="-1"
                @keydown="onKey"
            >
                <header class="flex h-14 shrink-0 items-center gap-3 px-4">
                    <Icon :name="icon" class="shrink-0 text-lg" :class="color" aria-hidden="true" />
                    <div class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-sm font-medium text-content">{{ entry.name }}</span>
                        <span class="truncate text-2xs text-muted tabular-nums">{{ facts }}</span>
                    </div>
                    <span v-if="entries.length > 1" class="shrink-0 text-xs text-muted tabular-nums">{{ position }}</span>
                    <Button
                        size="small"
                        tier="boring"
                        v-tooltip.bottom="{ title: t(`workspace.homeLightbox.open`), keys: t(`ui.keys.enter`) }"
                        @click="openShown"
                    >
                        {{ t(`workspace.homeLightbox.open`) }}
                    </Button>
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `lg` })"
                        :aria-label="t(`workspace.homeLightbox.close`)"
                        v-tooltip.bottom="{ title: t(`workspace.homeLightbox.close`), keys: t(`ui.keys.esc`) }"
                        @click="close"
                    >
                        <Icon name="times" aria-hidden="true" />
                    </button>
                </header>
                <!-- A press on the ground around the picture closes, as it does around any picture opened this way. -->
                <div ref="stage" class="relative min-h-0 flex-1" @click.self="close">
                    <div ref="art" class="absolute overflow-hidden rounded-md shadow-2xl ring-1 ring-line/40" :style="pictureStyle">
                        <img
                            v-if="medium === 'picture' && picture !== undefined"
                            :src="picture"
                            :alt="entry.name"
                            draggable="false"
                            class="block size-full bg-content/[0.045] object-contain"
                            @load="onPictureDrawn"
                        />
                        <video
                            v-else-if="medium === 'video' && (stream !== undefined || picture !== undefined)"
                            :src="stream"
                            :poster="picture"
                            controls
                            autoplay
                            muted
                            loop
                            playsinline
                            class="block size-full bg-black object-contain"
                            @loadedmetadata="onVideoDrawn"
                        ></video>
                        <span v-else class="flex size-full items-center justify-center bg-content/[0.045]" aria-hidden="true">
                            <Icon :name="icon" class="text-5xl opacity-40" :class="color" />
                        </span>
                    </div>
                    <button
                        v-if="index > 0"
                        type="button"
                        :class="ui.iconButton({ size: `xl`, round: true }, `absolute top-1/2 left-4 -translate-y-1/2`)"
                        :aria-label="t(`workspace.homeLightbox.previous`)"
                        v-tooltip.right="{ title: t(`workspace.homeLightbox.previous`), keys: `←` }"
                        @click="step(-1)"
                    >
                        <Icon name="chevron-right" class="rotate-180 text-lg" aria-hidden="true" />
                    </button>
                    <button
                        v-if="index < entries.length - 1"
                        type="button"
                        :class="ui.iconButton({ size: `xl`, round: true }, `absolute top-1/2 right-4 -translate-y-1/2`)"
                        :aria-label="t(`workspace.homeLightbox.next`)"
                        v-tooltip.left="{ title: t(`workspace.homeLightbox.next`), keys: `→` }"
                        @click="step(1)"
                    >
                        <Icon name="chevron-right" class="text-lg" aria-hidden="true" />
                    </button>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>
