<!-- The live picture on the stage, whichever way it travels: video with a sharp still over it (videoSink), castd's
     picture drawn by the decode worker (mediaPicture), or the frames path's img. The same box, so a click aims the same
     on any; it is the picture's own size at the top-left when full bleed (pictureFit.ts), the whole frame otherwise.
     Hands the stage the element painting, which every pointer handler measures against (viewportCoords). -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BrowserView } from "../../features/browsers/useBrowserView";
import { usePixelSnap } from "../../models/browsers/media/pixelSnap";

const props = defineProps<{
    view: BrowserView;
    box: { readonly width: string; readonly height: string } | undefined;
    interactive: boolean;
}>();
const emit = defineEmits<{ picture: [element: HTMLElement | undefined] }>();

const frameEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
const stillEl = ref<HTMLCanvasElement | null>(null);
const mediaEl = ref<HTMLCanvasElement | null>(null);
// Whichever is painting.
const picture = computed<HTMLElement | undefined>(() => canvasEl.value ?? mediaEl.value ?? frameEl.value ?? undefined);
watch(picture, (element) => emit(`picture`, element), { immediate: true });
// The canvases mount/unmount with the picture kind; the decoders outlive them, so they're connected here.
watch([canvasEl, stillEl], ([canvas, still]) => props.view.attachCanvases(canvas, still));
watch(mediaEl, (canvas) => props.view.media?.attach(canvas));
// castd's picture is the stage's device pixels; its canvas starts on one, so text stays pixel-exact.
const mediaSnap = usePixelSnap(
    mediaEl,
    computed(() => props.view.media?.painted.value),
);
const drawn = computed(() => props.view.kind.value === `video` || props.view.kind.value === `media`);
</script>

<template>
    <div v-if="drawn" class="absolute left-0 top-0" :class="box ? '' : 'h-full w-full'" :style="box">
        <template v-if="view.kind.value === 'video'">
            <canvas ref="canvasEl" class="absolute inset-0 h-full w-full object-contain" />
            <canvas ref="stillEl" class="pointer-events-none absolute inset-0 h-full w-full object-contain" />
        </template>
        <canvas v-else ref="mediaEl" class="absolute inset-0 h-full w-full object-contain" :style="mediaSnap" />
    </div>
    <!-- Display-less browsers expose one compositor surface without a cursor. -->
    <img
        v-else
        v-show="view.frame.value"
        ref="frameEl"
        :src="view.frame.value"
        :style="interactive ? { cursor: view.cursor.value } : undefined"
        alt=""
        draggable="false"
        class="h-full w-full object-contain"
    />
</template>
