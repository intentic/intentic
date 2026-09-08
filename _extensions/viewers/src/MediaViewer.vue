<script setup lang="ts">
import { Button, Icon, vAction } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatDuration, seekTargets, SPEEDS } from "./mediaControls";

// Audio and video share one component, always a `<video>` element; layout follows `videoWidth > 0` once metadata loads.
// `src` streams via range reads, not a blob; unplayable containers surface through the element's own `error` event.

const { path, src } = defineProps<{ path: string; src: string }>();
const emit = defineEmits<{ download: [] }>();

const media = ref<HTMLVideoElement>();
const stage = ref<HTMLElement>();

const playing = ref(false);
const waiting = ref(false);
const failed = ref(false);
// Set in `loadedmetadata`; 0 means audio-only regardless of container.
const videoWidth = ref(0);
const duration = ref(0);
const currentTime = ref(0);
// Buffered ranges as fractions of duration, for the progress-bar fill.
const buffered = ref<readonly { readonly from: number; readonly to: number }[]>([]);
const volume = ref(1);
const muted = ref(false);
const rate = ref(1);
const looping = ref(false);
const pictureInPicture = ref(false);
const fullscreen = ref(false);
const speedOpen = ref(false);
// Set while dragging the timeline; `timeupdate` is ignored and display renders from this until release.
const scrubTime = ref<number>();
// Pointer position on the timeline for the hover time bubble; undefined when not hovering.
const hoverTime = ref<number>();
// Video only: controls fade during playback and reappear on pointer movement; audio controls never hide.
const idle = ref(false);

const hasVideo = computed(() => videoWidth.value > 0);
// True once `duration` is a finite positive number; some containers report it late or not at all.
const seekable = computed(() => Number.isFinite(duration.value) && duration.value > 0);
const displayTime = computed(() => scrubTime.value ?? currentTime.value);
const progress = computed(() => (seekable.value ? Math.min(1, displayTime.value / duration.value) : 0));
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));
// Hides only while video is playing and the pointer is idle; paused or audio always shows controls.
const controlsVisible = computed(() => !hasVideo.value || !playing.value || !idle.value || speedOpen.value);

const el = (): HTMLVideoElement | undefined => media.value;

// Transport controls.
const togglePlay = (): void => {
    const node = el();
    if (node === undefined || failed.value) {
        return;
    }
    // A play() rejection already surfaces via `error` or the paused state; nothing more to report here.
    if (node.paused) {
        void node.play().catch(() => {});
        return;
    }
    node.pause();
};

const seekTo = (seconds: number): void => {
    const node = el();
    if (node === undefined || !seekable.value) {
        return;
    }
    node.currentTime = Math.min(Math.max(seconds, 0), duration.value);
    currentTime.value = node.currentTime;
};

const skip = (delta: number): void => seekTo(displayTime.value + delta);

const setVolume = (value: number): void => {
    const node = el();
    if (node === undefined) {
        return;
    }
    node.volume = Math.min(Math.max(value, 0), 1);
    // Raising volume off zero also unmutes.
    node.muted = node.volume === 0;
};

const toggleMute = (): void => {
    const node = el();
    if (node === undefined) {
        return;
    }
    // Unmuting from zero volume restores an audible level.
    if (node.muted && node.volume === 0) {
        node.volume = 0.5;
    }
    node.muted = !node.muted;
};

const setRate = (value: number): void => {
    const node = el();
    if (node !== undefined) {
        node.playbackRate = value;
        rate.value = value;
    }
    speedOpen.value = false;
};

const toggleLoop = (): void => {
    looping.value = !looping.value;
};

const togglePictureInPicture = async (): Promise<void> => {
    const node = el();
    if (node === undefined || !hasVideo.value) {
        return;
    }
    // Best-effort; a browser without the API or refusing outside a user gesture stays inline.
    try {
        await (document.pictureInPictureElement === node ? document.exitPictureInPicture() : node.requestPictureInPicture());
    } catch {
    }
};

const toggleFullscreen = async (): Promise<void> => {
    const box = stage.value;
    if (box === undefined) {
        return;
    }
    // Fullscreens the stage element, not the video, to avoid the browser's native chrome.
    try {
        await (document.fullscreenElement === null ? box.requestFullscreen() : document.exitFullscreen());
    } catch {
    }
};

// Element event handlers; source of truth for the state above.
const onLoadedMetadata = (): void => {
    const node = el();
    if (node === undefined) {
        return;
    }
    videoWidth.value = node.videoWidth;
    duration.value = node.duration;
    node.playbackRate = rate.value;
};

const onTimeUpdate = (): void => {
    const node = el();
    if (node !== undefined && scrubTime.value === undefined) {
        currentTime.value = node.currentTime;
    }
};

const onProgress = (): void => {
    const node = el();
    if (node === undefined || !seekable.value) {
        return;
    }
    const ranges: { from: number; to: number }[] = [];
    for (let i = 0; i < node.buffered.length; i++) {
        ranges.push({ from: node.buffered.start(i) / duration.value, to: node.buffered.end(i) / duration.value });
    }
    buffered.value = ranges;
};

const onVolumeChange = (): void => {
    const node = el();
    if (node !== undefined) {
        volume.value = node.volume;
        muted.value = node.muted;
    }
};

// Timeline scrubbing.
const timeline = ref<HTMLElement>();

// Pointer position on the bar as a time, clamped to the track so a drag past either end pins there.
const timeAt = (clientX: number): number | undefined => {
    const rect = timeline.value?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || !seekable.value) {
        return undefined;
    }
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration.value;
};

const onTimelineDown = (event: PointerEvent): void => {
    const at = timeAt(event.clientX);
    if (at === undefined) {
        return;
    }
    // Captures the pointer so dragging past the bar's edge keeps scrubbing instead of ending it.
    timeline.value?.setPointerCapture(event.pointerId);
    scrubTime.value = at;
};

const onTimelineMove = (event: PointerEvent): void => {
    const at = timeAt(event.clientX);
    hoverTime.value = at;
    if (scrubTime.value !== undefined && at !== undefined) {
        scrubTime.value = at;
    }
};

const onTimelineUp = (): void => {
    if (scrubTime.value !== undefined) {
        seekTo(scrubTime.value);
        scrubTime.value = undefined;
    }
};

// Standard video-player key map. Handled on the stage element, not the document, so a backgrounded player doesn't steal
// keystrokes.
const onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
    }
    const key = event.key;
    const jump = seekTargets[key];
    if (jump !== undefined) {
        event.preventDefault();
        skip(jump);
        return;
    }
    // Digit keys 0-9 jump to that tenth of the file's duration.
    if (/^[0-9]$/.test(key) && seekable.value) {
        event.preventDefault();
        seekTo((Number(key) / 10) * duration.value);
        return;
    }
    switch (key.toLowerCase()) {
        case ` `:
        case `k`:
            togglePlay();
            break;
        case `m`:
            toggleMute();
            break;
        case `f`:
            void toggleFullscreen();
            break;
        case `p`:
            void togglePictureInPicture();
            break;
        case `arrowup`:
            setVolume(volume.value + 0.05);
            break;
        case `arrowdown`:
            setVolume(volume.value - 0.05);
            break;
        case `home`:
            seekTo(0);
            break;
        case `end`:
            seekTo(duration.value);
            break;
        // Steps playback speed through the same SPEEDS ladder as the menu.
        case `,`:
        case `<`:
            setRate(SPEEDS[Math.max(SPEEDS.indexOf(rate.value) - 1, 0)] ?? rate.value);
            break;
        case `.`:
        case `>`:
            setRate(SPEEDS[Math.min(SPEEDS.indexOf(rate.value) + 1, SPEEDS.length - 1)] ?? rate.value);
            break;
        default:
            return;
    }
    event.preventDefault();
};

// Idle fade and document-level listeners.
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const wake = (): void => {
    idle.value = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        idle.value = true;
    }, 2200);
};

// Fullscreen and PiP can exit without this component's toggles (Esc, OS controls), so these flags track `document`
// state.
const syncFullscreen = (): void => {
    fullscreen.value = document.fullscreenElement !== null;
};
const syncPip = (): void => {
    pictureInPicture.value = document.pictureInPictureElement === media.value;
};
document.addEventListener(`fullscreenchange`, syncFullscreen);
document.addEventListener(`enterpictureinpicture`, syncPip, true);
document.addEventListener(`leavepictureinpicture`, syncPip, true);

onBeforeUnmount(() => {
    clearTimeout(idleTimer);
    document.removeEventListener(`fullscreenchange`, syncFullscreen);
    document.removeEventListener(`enterpictureinpicture`, syncPip, true);
    document.removeEventListener(`leavepictureinpicture`, syncPip, true);
});

// Resets all playback state when `src` changes, so a new file doesn't inherit the previous one's position or layout.
watch(
    () => src,
    () => {
        playing.value = false;
        failed.value = false;
        videoWidth.value = 0;
        duration.value = 0;
        currentTime.value = 0;
        buffered.value = [];
        scrubTime.value = undefined;
        idle.value = false;
    },
);
</script>

<template>
    <div
        ref="stage"
        class="relative flex h-full min-h-0 w-full flex-col outline-none"
        :class="hasVideo ? `bg-black` : `bg-canvas`"
        tabindex="0"
        role="group"
        :aria-label="`${filename}: space to play, arrows to seek, F for fullscreen`"
        @keydown="onKeyDown"
        @pointermove="wake"
    >
        <!-- Always a `<video>` element; layout adapts to it, not the reverse. -->
        <video
            ref="media"
            :src="src"
            preload="metadata"
            :loop="looping"
            class="min-h-0"
            :class="hasVideo ? `h-full w-full flex-1 object-contain` : `sr-only`"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @progress="onProgress"
            @volumechange="onVolumeChange"
            @play="playing = true"
            @pause="playing = false"
            @waiting="waiting = true"
            @playing="waiting = false"
            @canplay="waiting = false"
            @ratechange="rate = media?.playbackRate ?? rate"
            @error="failed = true"
            @click="togglePlay"
            @dblclick="toggleFullscreen"
        ></video>

        <!-- Unsupported containers (Matroska, AVI, WMV) fall back to a download link. -->
        <div v-if="failed" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">This format can't be played in the browser. Download it to open in a media player.</p>
            <Button severity="secondary" @click="emit(`download`)"> <Icon name="download" class="text-xs" /> Download </Button>
        </div>

        <!-- Audio files get a centered filename card instead of a picture. -->
        <div v-else-if="!hasVideo" class="flex flex-1 flex-col items-center justify-center gap-4 px-6">
            <div class="flex h-20 w-20 items-center justify-center rounded-2xl bg-overlay text-3xl text-subtle">
                <Icon name="wave-pulse" />
            </div>
            <p class="max-w-md truncate text-center text-sm text-content">{{ filename }}</p>
        </div>

        <!-- Buffering spinner; shown for video only, audio's transport already indicates it. -->
        <div v-if="waiting && hasVideo && !failed" class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Icon name="spinner" class="text-3xl text-white/80" spin />
        </div>

        <!-- Large play button shown over a stopped, non-buffering video frame. -->
        <button
            v-if="hasVideo && !playing && !waiting && !failed"
            type="button"
            class="absolute inset-0 flex items-center justify-center"
            aria-label="Play"
            @click="togglePlay"
        >
            <span
                class="flex h-16 w-16 items-center justify-center rounded-full bg-black/50 text-2xl text-white backdrop-blur transition-transform hover:scale-105"
            >
                <Icon name="play" />
            </span>
        </button>

        <!-- Transport bar: overlaid and fading on video, a static footer under audio. -->
        <div
            v-if="!failed"
            class="transition-opacity duration-200"
            :class="[
                hasVideo
                    ? // Near-opaque at the bottom, not a polite tint: these controls sit over WHATEVER the frame
                      // happens to be, and a screen recording of a light IDE (or a test pattern) turns a gentle
                      // scrim into white icons on white. It fades out over the height of the block so the
                      // picture is never boxed in by a hard edge.
                      `absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-3 pb-2 pt-12`
                    : `shrink-0 border-t border-line-subtle px-4 py-3`,
                controlsVisible ? `opacity-100` : `pointer-events-none opacity-0`,
            ]"
        >
            <!-- Buffered ranges render under the progress fill, distinguishing idle from still-loading. -->
            <div
                ref="timeline"
                class="group/bar relative -mx-1 cursor-pointer px-1 py-2"
                role="slider"
                :aria-valuemin="0"
                :aria-valuemax="Math.round(duration)"
                :aria-valuenow="Math.round(displayTime)"
                :aria-label="`Seek: ${formatDuration(displayTime)} of ${formatDuration(duration)}`"
                tabindex="-1"
                @pointerdown="onTimelineDown"
                @pointermove="onTimelineMove"
                @pointerup="onTimelineUp"
                @pointercancel="onTimelineUp"
                @pointerleave="hoverTime = undefined"
            >
                <div
                    class="relative h-1 rounded-full transition-[height,background-color] group-hover/bar:h-1.5"
                    :class="hasVideo ? `bg-white/25` : `bg-overlay`"
                >
                    <div
                        v-for="(range, index) in buffered"
                        :key="index"
                        class="absolute inset-y-0 rounded-full"
                        :class="hasVideo ? `bg-white/30` : `bg-line-strong`"
                        :style="{ left: `${range.from * 100}%`, width: `${Math.max(range.to - range.from, 0) * 100}%` }"
                    ></div>
                    <div class="absolute inset-y-0 left-0 rounded-full bg-primary-500" :style="{ width: `${progress * 100}%` }"></div>
                    <div
                        class="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary-500 opacity-0 shadow transition-opacity group-hover/bar:opacity-100"
                        :class="{ 'opacity-100': scrubTime !== undefined }"
                        :style="{ left: `${progress * 100}%` }"
                    ></div>
                </div>
                <!-- Shows the time under the pointer while hovering the timeline. -->
                <div
                    v-if="hoverTime !== undefined && seekable"
                    class="pointer-events-none absolute bottom-6 -translate-x-1/2 rounded bg-card px-1.5 py-0.5 text-2xs tabular-nums text-content shadow"
                    :style="{ left: `${(hoverTime / duration) * 100}%` }"
                >
                    {{ formatDuration(hoverTime) }}
                </div>
            </div>

            <div class="flex items-center gap-1" :class="hasVideo ? `text-white` : `text-content`">
                <button
                    type="button"
                    class="media-btn"
                    :aria-label="playing ? `Pause` : `Play`"
                    v-tooltip.top="playing ? 'Pause (K)' : 'Play (K)'"
                    @click="togglePlay"
                >
                    <Icon :name="playing ? `pause` : `play`" />
                </button>
                <button type="button" class="media-btn" aria-label="Back 10 seconds" v-tooltip.top="'Back 10s (J)'" @click="skip(-10)">
                    <Icon name="backward" />
                </button>
                <button type="button" class="media-btn" aria-label="Forward 10 seconds" v-tooltip.top="'Forward 10s (L)'" @click="skip(10)">
                    <Icon name="forward" />
                </button>

                <!-- Volume slider widens on hover; collapsed otherwise to save row space. -->
                <div class="group/bar flex items-center">
                    <button type="button" class="media-btn" :aria-label="muted ? `Unmute` : `Mute`" v-tooltip.top="'Mute (M)'" @click="toggleMute">
                        <Icon :name="muted || volume === 0 ? `volume-off` : `volume-up`" />
                    </button>
                    <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        :value="muted ? 0 : volume"
                        aria-label="Volume"
                        class="media-range w-0 opacity-0 transition-all group-hover/bar:w-16 group-hover/bar:opacity-100 focus:w-16 focus:opacity-100"
                        @input="setVolume(Number(($event.target as HTMLInputElement).value))"
                    />
                </div>

                <span class="px-1.5 text-2xs tabular-nums" :class="hasVideo ? `text-white/80` : `text-muted`">
                    {{ formatDuration(displayTime) }} <span class="opacity-50">/</span> {{ formatDuration(duration) }}
                </span>

                <span class="flex-1"></span>

                <!-- Shows the numeric playback speed rather than an icon. -->
                <div class="relative">
                    <button
                        type="button"
                        class="media-btn w-auto px-1.5 text-2xs tabular-nums"
                        aria-label="Playback speed"
                        v-tooltip.top="'Playback speed (, and .)'"
                        @click="speedOpen = !speedOpen"
                    >
                        {{ rate }}×
                    </button>
                    <div
                        v-if="speedOpen"
                        class="absolute bottom-full right-0 mb-1 overflow-hidden rounded-md border border-line bg-card py-1 shadow-lg"
                    >
                        <button
                            v-for="speed in SPEEDS"
                            :key="speed"
                            type="button"
                            class="block w-full px-3 py-1 text-left text-2xs tabular-nums text-content transition-colors hover:bg-overlay"
                            :class="{ 'text-primary-500': speed === rate }"
                            @click="setRate(speed)"
                        >
                            {{ speed }}×
                        </button>
                    </div>
                </div>
                <button
                    type="button"
                    class="media-btn"
                    :class="{ 'text-primary-500': looping }"
                    aria-label="Loop"
                    v-tooltip.top="'Loop'"
                    @click="toggleLoop"
                >
                    <Icon name="repeat" />
                </button>
                <button
                    v-if="hasVideo"
                    type="button"
                    class="media-btn"
                    :class="{ 'text-primary-500': pictureInPicture }"
                    aria-label="Picture in picture"
                    v-tooltip.top="'Picture in picture (P)'"
                    v-action="togglePictureInPicture"
                >
                    <Icon name="picture-in-picture" />
                </button>
                <button type="button" class="media-btn" aria-label="Download" v-tooltip.top="'Download'" @click="emit(`download`)">
                    <Icon name="download" />
                </button>
                <button
                    v-if="hasVideo"
                    type="button"
                    class="media-btn"
                    :aria-label="fullscreen ? `Exit full screen` : `Full screen`"
                    v-tooltip.top="'Full screen (F)'"
                    v-action="toggleFullscreen"
                >
                    <Icon :name="fullscreen ? `compress` : `expand`" />
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Shared shape for every transport button. Scoped to avoid colliding with class names on the host page. */
.media-btn {
    display: inline-flex;
    height: 1.75rem;
    width: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    font-size: 0.8rem;
    transition:
        color 120ms,
        background-color 120ms;
}
.media-btn:hover {
    background-color: color-mix(in srgb, currentColor 15%, transparent);
}
/* Themes the native range input to match the timeline and the app's color scheme. */
.media-range {
    height: 0.25rem;
    cursor: pointer;
    appearance: none;
    border-radius: 9999px;
    background: color-mix(in srgb, currentColor 30%, transparent);
    accent-color: var(--color-primary-500);
}
.media-range::-webkit-slider-thumb {
    height: 0.6rem;
    width: 0.6rem;
    appearance: none;
    border-radius: 9999px;
    background: currentColor;
}
.media-range::-moz-range-thumb {
    height: 0.6rem;
    width: 0.6rem;
    border: 0;
    border-radius: 9999px;
    background: currentColor;
}
</style>
