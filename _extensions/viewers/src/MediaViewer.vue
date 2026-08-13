<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { formatDuration, seekTargets, SPEEDS } from "./mediaControls";

/* THE PLAYER — audio and video, one component, streaming.
 *
 * WHY IT DOESN'T USE `controls`. The native control bar is the browser's, not the app's: five different
 * chromes across five browsers, none of them themable, none of them showing what a workspace reader actually
 * wants (what has BUFFERED, which is the only honest read on "is this streaming or is it stalled?"), and no
 * keyboard map worth the name. So the transport below is ours, and the element is a decoder we drive.
 *
 * WHY ONE ELEMENT FOR BOTH. It is always a <video>, even for an .mp3 — a video element plays audio perfectly
 * well, and the alternative is deciding audio-vs-video from the file EXTENSION, which is wrong twice over: an
 * .mp4 is frequently audio-only (the container an AAC recording arrives in), and a .webm may be either. So the
 * element decodes, and the LAYOUT follows `videoWidth > 0` once metadata lands: a picture fills the pane, a
 * soundtrack gets the centred card. One code path, and it is never wrong about what it is playing.
 *
 * WHY IT STREAMS. `src` is a /workspace/media URL the host minted (fetch: "url"), and the element range-reads
 * it: first frame paints in a couple of hundred milliseconds whatever the file weighs, a drag to 40:00 fetches
 * the bytes at 40:00, and nothing is ever held in the tab. A blob: URL — the way every other viewer here gets
 * its content — cannot do any of that: it means downloading the file before the first frame, and it means a
 * 25 MiB ceiling, which is roughly ten seconds of screen recording.
 *
 * NOT EVERY FILE PLAYS, and that is not this component's fault to hide: no browser decodes Matroska or AVI.
 * The element's own `error` is the signal — its verdict, not our guess from the extension — and it resolves to
 * the download the reader wanted anyway. */

const { path, src } = defineProps<{ path: string; src: string }>();
const emit = defineEmits<{ download: [] }>();

const media = ref<HTMLVideoElement>();
const stage = ref<HTMLElement>();

const playing = ref(false);
const waiting = ref(false);
const failed = ref(false);
// Set from loadedmetadata. 0 ⇒ no picture: the file is a soundtrack, whatever its container is called.
const videoWidth = ref(0);
const duration = ref(0);
const currentTime = ref(0);
// Buffered ranges as fractions of the duration, painted under the progress fill. The one thing a native
// control bar will not show you, and the only way to tell a slow network from a stalled one.
const buffered = ref<readonly { readonly from: number; readonly to: number }[]>([]);
const volume = ref(1);
const muted = ref(false);
const rate = ref(1);
const looping = ref(false);
const pictureInPicture = ref(false);
const fullscreen = ref(false);
const speedOpen = ref(false);
// Pointer is down on the timeline: the element's own timeupdate is ignored so the thumb tracks the finger
// rather than fighting it, and `scrubTime` is what everything renders from until release.
const scrubTime = ref<number>();
// Where the pointer is hovering on the timeline, for the time bubble. Undefined = not over it.
const hoverTime = ref<number>();
// Video only: the controls fade out during playback and come back on any pointer movement. Never for audio,
// where the transport IS the view and there is nothing behind it to reveal.
const idle = ref(false);

const hasVideo = computed(() => videoWidth.value > 0);
// A stream whose duration the container never declared (a .webm with no cues). Everything that divides by it
// has to survive that, and seeking is meaningless until it resolves.
const seekable = computed(() => Number.isFinite(duration.value) && duration.value > 0);
const displayTime = computed(() => scrubTime.value ?? currentTime.value);
const progress = computed(() => (seekable.value ? Math.min(1, displayTime.value / duration.value) : 0));
const filename = computed(() => path.slice(path.lastIndexOf(`/`) + 1));
// Controls hide only while a VIDEO is actually playing and the pointer has gone quiet. A paused frame is one
// the reader is looking at deliberately, and hiding the way back to play would be a puzzle, not a feature.
const controlsVisible = computed(() => !hasVideo.value || !playing.value || !idle.value || speedOpen.value);

const el = (): HTMLVideoElement | undefined => media.value;

// ── transport ────────────────────────────────────────────────────────────────────────────────────────────
const togglePlay = (): void => {
    const node = el();
    if (node === undefined || failed.value) {
        return;
    }
    // A play() rejection is the autoplay policy or a decode failure; both already surface elsewhere (the
    // element stays paused, or `error` fires), so there is nothing here to report twice.
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
    // Nudging the volume up off zero is an unmute — the two controls are one intent and should not need two
    // clicks to undo one.
    node.muted = node.volume === 0;
};

const toggleMute = (): void => {
    const node = el();
    if (node === undefined) {
        return;
    }
    // Unmuting something that was dragged to silence has to give it a level back, or the button does nothing.
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
    // Best-effort: a browser without the API, or one refusing outside a user gesture, simply stays inline.
    try {
        await (document.pictureInPictureElement === node ? document.exitPictureInPicture() : node.requestPictureInPicture());
    } catch {
        /* stays inline */
    }
};

const toggleFullscreen = async (): Promise<void> => {
    const box = stage.value;
    if (box === undefined) {
        return;
    }
    // The STAGE goes fullscreen, not the <video>: fullscreening the element itself hands the browser's native
    // chrome back, which is the thing this component exists to replace.
    try {
        await (document.fullscreenElement === null ? box.requestFullscreen() : document.exitFullscreen());
    } catch {
        /* stays inline */
    }
};

// ── the element's own events, which are the source of truth for everything above ─────────────────────────
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

// ── the timeline ─────────────────────────────────────────────────────────────────────────────────────────
const timeline = ref<HTMLElement>();

// Where along the bar a pointer is, as a time. Clamped, so a drag that leaves the bar sideways pins to an end
// instead of jumping.
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
    // Captured so the drag survives leaving the bar — the pointer ends up anywhere while scrubbing a 3-hour
    // file, and losing the gesture at the edge is what makes a scrubber feel cheap.
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

// ── keyboard ─────────────────────────────────────────────────────────────────────────────────────────────
// The map every video player has taught people, so nothing here has to be discovered. Handled on the stage
// (which is focusable) rather than the document, so a player in a background tab never steals a keystroke.
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
    // 0–9 jump to that tenth of the file, the one shortcut that needs the duration to mean anything.
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
        // Speed down / up through the same ladder the menu offers, so the two never disagree.
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

// ── idle fade, and the listeners that have to live on the document ───────────────────────────────────────
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const wake = (): void => {
    idle.value = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        idle.value = true;
    }, 2200);
};

// Fullscreen and PiP can be left by means this component never sees (Esc, the OS window's own close button),
// so the flags follow the DOCUMENT rather than our own toggles.
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

// A new file in the same pane starts over — otherwise the next clip inherits the last one's position, its
// error state, and its "this is audio" layout.
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
        :aria-label="`${filename} — space to play, arrows to seek, F for fullscreen`"
        @keydown="onKeyDown"
        @pointermove="wake"
    >
        <!-- The decoder. Always a <video>: see the header — the layout, not the element, is what adapts. -->
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

        <!-- No browser decodes this container (Matroska, AVI, WMV). The element said so; we hand over the bytes. -->
        <div v-if="failed" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
            <Icon name="exclamation-triangle" class="text-3xl text-subtle" />
            <p class="max-w-sm text-xs text-muted">This format can't be played in the browser. Download it to open in a media player.</p>
            <button
                type="button"
                class="inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
                @click="emit(`download`)"
            >
                <Icon name="download" class="text-xs" /> Download
            </button>
        </div>

        <!-- Audio: the file itself is the subject, so it gets the pane. -->
        <div v-else-if="!hasVideo" class="flex flex-1 flex-col items-center justify-center gap-4 px-6">
            <div class="flex h-20 w-20 items-center justify-center rounded-2xl bg-overlay text-3xl text-subtle">
                <Icon name="wave-pulse" />
            </div>
            <p class="max-w-md truncate text-center text-sm text-content">{{ filename }}</p>
        </div>

        <!-- Buffering, over the picture. Not shown for audio, where the transport already says it. -->
        <div v-if="waiting && hasVideo && !failed" class="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Icon name="spinner" class="text-3xl text-white/80" spin />
        </div>

        <!-- Big play affordance on a stopped picture: the one control that should never need to be found. -->
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

        <!-- The transport. Overlaid on video (and faded while it plays untouched), a plain footer under audio. -->
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
                    : `shrink-0 border-t border-line px-4 py-3`,
                controlsVisible ? `opacity-100` : `pointer-events-none opacity-0`,
            ]"
        >
            <!-- Timeline. Buffered ranges under the fill, so "nothing is happening" and "it is still arriving"
                 stop looking the same. -->
            <div
                ref="timeline"
                class="group/bar relative -mx-1 cursor-pointer px-1 py-2"
                role="slider"
                :aria-valuemin="0"
                :aria-valuemax="Math.round(duration)"
                :aria-valuenow="Math.round(displayTime)"
                :aria-label="`Seek — ${formatDuration(displayTime)} of ${formatDuration(duration)}`"
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
                <!-- Time under the pointer, so a drag to a specific moment is aimed rather than guessed. -->
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

                <!-- Volume: the slider widens on hover so the row stays compact until it is wanted. -->
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

                <!-- Speed reads as its own value, which no glyph does better than the number. -->
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
                    @click="togglePictureInPicture"
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
                    @click="toggleFullscreen"
                >
                    <Icon :name="fullscreen ? `compress` : `expand`" />
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* One shape for every button in the transport: the row is a dozen of them, and spelling the classes out per
   button is how they drift apart. Scoped, so it cannot leak into a host surface that reuses these names. */
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
/* The volume slider, themed to match the timeline — a native range input looks like neither light nor dark
   mode, and inherits none of the app's colours. */
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
