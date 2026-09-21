<script setup lang="ts">
import { explorerColorClass } from "@intentic/ui";
import { formatDuration } from "@intentic/ui/format";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { audioWave, WAVE_BARS } from "../../drafts/audioWave";
import { useChatSurface } from "../../tools/chatToolSurface";
import { useClippedName } from "../clippedName";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* One attached sound, played where it was attached: its own waveform, scrubable, above the name it arrived under. */

const {
    name,
    path,
    src,
    progress,
    error,
    framed = false,
    removable = false,
} = defineProps<{
    name: string;
    // Workspace-relative path: what a click on the name opens, and what the waveform is cached under.
    path: string;
    // Object URL for the bytes, staged locally or re-fetched; undefined while that is still in flight.
    src?: string;
    // Upload in flight: 0..1. Undefined once the bytes are on disk.
    progress?: number;
    error?: string;
    // Composer only: a bordered token, since chips in a row over the input have to read as discrete removable things.
    framed?: boolean;
    removable?: boolean;
}>();

const emit = defineEmits<{ remove: [] }>();

const surface = useChatSurface();
// Nothing to open while the bytes are still going up, and nothing at all on a page with no workspace behind it.
const openable = computed(() => surface.openFile !== undefined && progress === undefined);

// Fixed `colorful`, as the file chip does: the explorer's setting is about the file tree's own density, but the
// vocabulary it defines — which hue means a sound, a config, a log — is worth sharing regardless.
const iconColor = computed(() => explorerColorClass(`colorful`, name, `file`, false));

const { nameBox, nameHead, nameTail, clipped } = useClippedName(() => name);

const media = ref<HTMLAudioElement>();
const playing = ref(false);
// Set on `loadedmetadata`; the element's own length, which the decoded wave below usually agrees with.
const elementDuration = ref(0);
const currentTime = ref(0);
// Set while dragging the track; `timeupdate` is ignored and the fill renders from this until release.
const scrubTime = ref<number>();
// Bytes the element itself refused, as distinct from `error` (which is the upload's). Both draw the same danger edge.
const undecodable = ref(false);

const wave = computed(() => (src === undefined ? undefined : audioWave(path, src)));

// The decoded length, which is a fact about the samples; the element's is a fact about the container's header, and a
// header can be absent (a streamed .webm reads back Infinity) or wrong.
const duration = computed(() => wave.value?.duration ?? elementDuration.value);
const seekable = computed(() => Number.isFinite(duration.value) && duration.value > 0);
const displayTime = computed(() => scrubTime.value ?? currentTime.value);
const progressed = computed(() => (seekable.value ? Math.min(1, displayTime.value / duration.value) : 0));

// The resting shape before (or instead of) a decode: an even row rather than a flat line, so the track reads as a
// waveform waiting to arrive rather than as a broken one. Undecodable containers keep it for good.
const RESTING = 0.35;
const bars = computed(() => wave.value?.bars ?? Array.from({ length: WAVE_BARS }, () => RESTING));

// Percent of the track's height a silent bar still occupies, so a pause inside a clip draws as a dot on the line
// rather than as a gap in it — the row has to stay readable as one track across silence.
const BAR_FLOOR = 8;

// What went wrong, in the order the reader can act on: bytes that never arrived before bytes that arrived unplayable.
const fault = computed(() => error ?? (undecodable.value ? `This sound can't be played in the browser.` : undefined));
const troubled = computed(() => fault.value !== undefined);

// Still coming, as opposed to arrived-and-flat: the even row means both, and only one of them is worth breathing.
const awaiting = computed(() => wave.value === undefined && !troubled.value);

const toggle = (): void => {
    const node = media.value;
    if (node === undefined || undecodable.value) {
        return;
    }
    if (node.paused) {
        // A rejected play() already surfaces as `error` or as a still-paused element; nothing more to report.
        void node.play().catch(() => undefined);
        return;
    }
    node.pause();
};

const seekTo = (seconds: number): void => {
    const node = media.value;
    if (node === undefined || !seekable.value) {
        return;
    }
    node.currentTime = Math.min(Math.max(seconds, 0), duration.value);
    currentTime.value = node.currentTime;
};

const track = ref<HTMLElement>();

// Pointer position on the track as a time, clamped so a drag past either end pins there rather than stopping.
const timeAt = (clientX: number): number | undefined => {
    const rect = track.value?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || !seekable.value) {
        return undefined;
    }
    return Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * duration.value;
};

const onTrackDown = (event: PointerEvent): void => {
    const at = timeAt(event.clientX);
    if (at === undefined) {
        return;
    }
    // Captures the pointer so dragging past the track's edge keeps scrubbing instead of ending it.
    track.value?.setPointerCapture(event.pointerId);
    scrubTime.value = at;
};

const onTrackMove = (event: PointerEvent): void => {
    const at = timeAt(event.clientX);
    if (scrubTime.value !== undefined && at !== undefined) {
        scrubTime.value = at;
    }
};

const onTrackUp = (): void => {
    if (scrubTime.value !== undefined) {
        seekTo(scrubTime.value);
        scrubTime.value = undefined;
    }
};

// The track is a slider, so it answers the keys one does. Space is left to the browser: this chip sits over a
// textarea, and a key that scrolls or types everywhere else must not be stolen by a focused waveform.
const SEEK_SECONDS = 5;
const onTrackKey = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || !seekable.value) {
        return;
    }
    switch (event.key) {
        case `ArrowLeft`:
            seekTo(displayTime.value - SEEK_SECONDS);
            break;
        case `ArrowRight`:
            seekTo(displayTime.value + SEEK_SECONDS);
            break;
        case `Home`:
            seekTo(0);
            break;
        case `End`:
            seekTo(duration.value);
            break;
        default:
            return;
    }
    event.preventDefault();
};

const onLoadedMetadata = (): void => {
    elementDuration.value = media.value?.duration ?? 0;
};

const onTimeUpdate = (): void => {
    if (scrubTime.value === undefined) {
        currentTime.value = media.value?.currentTime ?? 0;
    }
};

// Removing a chip unmounts it mid-playback; pausing first stops bytes that are about to be revoked.
onBeforeUnmount(() => media.value?.pause());

// A chip is keyed by its staged id rather than its path, so the same element outlives the swap from the composer's
// own object URL to the re-fetched one. Everything drawn from the old bytes has to go with them.
watch(
    () => src,
    () => {
        playing.value = false;
        undecodable.value = false;
        elementDuration.value = 0;
        currentTime.value = 0;
        scrubTime.value = undefined;
    },
);

const open = (): void => surface.openFile?.(path);
</script>

<template>
    <div
        class="relative flex w-72 max-w-full flex-col gap-1.5 overflow-hidden"
        :class="framed ? `rounded-lg border bg-card px-2.5 py-2 ${troubled ? `border-danger` : `border-line`}` : ``"
    >
        <!-- Caption, on the file chip's own terms: the same glyph slot, the same middle-ellipsised name, one row. -->
        <div class="flex min-w-0 items-center gap-1.5">
            <Icon name="waveform" class="shrink-0 text-xs" :class="iconColor" />
            <component
                :is="openable ? `button` : `span`"
                :type="openable ? `button` : undefined"
                class="flex min-w-0 items-center text-left text-xs text-content"
                :class="openable ? `cursor-pointer` : ``"
                :aria-label="openable ? t(`chat.chatAudioChip.openInWorkspace`, { name }) : undefined"
                @click="openable && open()"
            >
                <!-- Softened at the cut, so a half-drawn glyph reads as the name running into its mark. -->
                <span
                    ref="nameBox"
                    class="overflow-hidden whitespace-nowrap"
                    :class="clipped ? `[mask-image:linear-gradient(to_right,#000_calc(100%_-_0.6em),transparent)]` : ``"
                    >{{ nameHead }}</span
                >
                <span v-if="nameTail" class="shrink-0">{{ clipped ? `…` : `` }}{{ nameTail }}</span>
            </component>
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <!-- The whole length, never the elapsed one: where the playhead sits already says how far in this is,
                     and a caption alternating between the two facts at the same width says which only by luck. Hidden
                     rather than removed while a drag names a position over this row, so the row does not move. -->
                <span class="text-2xs tabular-nums text-subtle" :class="scrubTime === undefined ? `` : `invisible`">{{
                    seekable ? formatDuration(duration) : `--:--`
                }}</span>
                <Icon v-if="progress !== undefined" name="spinner" spin class="text-2xs text-link" />
                <Icon v-else-if="fault" name="exclamation-circle" class="text-2xs text-danger" v-tooltip.top="fault" />
                <button
                    v-if="removable"
                    type="button"
                    class="composer-ghost h-5 w-5"
                    :aria-label="t(`chat.chatAudioChip.removeAttachment`)"
                    @click="emit(`remove`)"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>
        </div>

        <!-- The sound's own shape, which is to a recording what the lead lines are to a log — and framed like them
             where the chip has no border of its own to sit inside. -->
        <div class="flex items-center gap-2" :class="framed ? `` : `rounded-md border border-line bg-canvas/40 px-2 py-1`">
            <button
                type="button"
                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-fill text-2xs text-fill-content transition-[background-color,transform] hover:bg-primary-fill-hover active:scale-95 disabled:pointer-events-none disabled:bg-[var(--ui-button-off-fill)] disabled:text-[var(--ui-button-off-content)]"
                :disabled="src === undefined || undecodable"
                :aria-label="playing ? t(`chat.chatAudioChip.pause`, { name }) : t(`chat.chatAudioChip.play`, { name })"
                @click="toggle"
            >
                <!-- Nudged right: a triangle's optical centre sits left of its bounding box's. -->
                <Icon :name="playing ? `pause` : `play`" :class="playing ? `` : `translate-x-px`" />
            </button>

            <div
                ref="track"
                class="relative flex h-7 min-w-0 flex-1 touch-none items-center rounded-sm outline-offset-2"
                :class="seekable ? `cursor-pointer` : ``"
                role="slider"
                :tabindex="seekable ? 0 : -1"
                :aria-valuemin="0"
                :aria-valuemax="Math.round(duration)"
                :aria-valuenow="Math.round(displayTime)"
                :aria-valuetext="t(`chat.chatAudioChip.of`, { displayTime: formatDuration(displayTime), duration: formatDuration(duration) })"
                :aria-label="t(`chat.chatAudioChip.seek`, { name })"
                @pointerdown="onTrackDown"
                @pointermove="onTrackMove"
                @pointerup="onTrackUp"
                @pointercancel="onTrackUp"
                @keydown="onTrackKey"
            >
                <!-- Drawn twice on purpose: the played half is the SAME row clipped at the playhead, so the two can
                     never disagree about a bar's height and the split falls inside a bar rather than between two. -->
                <div class="flex h-full w-full items-center gap-px" :class="awaiting ? `animate-pulse` : ``">
                    <span
                        v-for="(height, index) in bars"
                        :key="index"
                        class="min-w-px flex-1 rounded-full bg-line-strong transition-[height] duration-500"
                        :style="{ height: `${BAR_FLOOR + height * (100 - BAR_FLOOR)}%` }"
                    ></span>
                </div>
                <div
                    class="pointer-events-none absolute inset-0 flex items-center gap-px"
                    :style="{ clipPath: `inset(0 ${100 - progressed * 100}% 0 0)` }"
                >
                    <span
                        v-for="(height, index) in bars"
                        :key="index"
                        class="min-w-px flex-1 rounded-full bg-primary-fill transition-[height] duration-500"
                        :style="{ height: `${BAR_FLOOR + height * (100 - BAR_FLOOR)}%` }"
                    ></span>
                </div>
                <!-- Where the drag has got to, over the caption rather than over the shape being aimed at. Only while
                     a drag is happening: at rest the playhead is the position, and a standing label is noise. -->
                <span
                    v-if="scrubTime !== undefined"
                    class="pointer-events-none absolute -top-1 -translate-x-1/2 -translate-y-full rounded bg-primary-fill px-1.5 py-0.5 text-2xs tabular-nums text-fill-content shadow"
                    :style="{ left: `clamp(1.25rem, ${progressed * 100}%, calc(100% - 1.25rem))` }"
                    >{{ formatDuration(displayTime) }}</span
                >
            </div>
        </div>

        <audio
            ref="media"
            :src="src"
            preload="metadata"
            class="sr-only"
            @loadedmetadata="onLoadedMetadata"
            @timeupdate="onTimeUpdate"
            @play="playing = true"
            @pause="playing = false"
            @ended="playing = false"
            @error="undecodable = true"
        ></audio>

        <!-- Upload progress: the one thing drawn here that is about the transfer rather than the sound. -->
        <div
            v-if="progress !== undefined"
            class="absolute inset-x-0 bottom-0 h-0.5 bg-primary-fill"
            :style="{ width: `${Math.round(progress * 100)}%` }"
        ></div>
    </div>
</template>
