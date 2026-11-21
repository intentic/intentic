<!-- One of the owner's computers' screens, live, to see and use from here (useDeviceScreen.ts on the media path every
     live picture in the editor takes). The toolbar says how it is connected and holds what remote desktop needs beside the
     picture: which monitor, how it is scaled, watching without touching, the chords a browser cannot send, sound, the
     pointer held in the picture, and full screen with every key going to the far computer. On a phone or tablet a
     finger is its mouse or its trackpad, and its on-screen keyboard types over there. -->
<script setup lang="ts">
import { Button, Icon, Picker, SegmentedControl, toneWash, ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { isApplePlatform } from "@intentic/ui/keys";
import { computed, onScopeDispose, ref, watch } from "vue";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import { useBusySince, useLineWithElapsed } from "../../../../components/progress/useProgress";
import { usePixelSnap } from "../../../../models/browsers/media/pixelSnap";
import { windowOf } from "../../../../models/browsers/media/pixelRatio";
import { type RemoteMonitor, useRemoteApi } from "../../../../models/sandbox/devices/remote/remoteApi";
import ConnectionBadge from "./ConnectionBadge.vue";
import SendKeysMenu from "./SendKeysMenu.vue";
import { useFullscreenLock } from "./fullscreenLock";
import { useRemoteCursor } from "./remoteCursor";
import { askedBox, placePicture, type ScreenScale } from "./screenFit";
import { useScreenInput } from "./screenInput";
import { useDeviceScreen } from "./useDeviceScreen";

const { device, name, monitors, back } = defineProps<{
    // The connection whose screen this is (`rog`).
    device: string;
    // The computer, as its page names it.
    name: string;
    monitors: readonly RemoteMonitor[];
    back: RouteLocationRaw;
}>();
const monitor = defineModel<string | undefined>("monitor");

const t = useT();
const { mobile } = useDevice();

const rootEl = ref<HTMLElement | null>(null);
const stageEl = ref<HTMLElement | null>(null);
const zoomEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
// Where the pictures are shown when they ride the peer's video track (useDeviceScreen asks for one); the canvas keeps
// its place under it, since every point the person sends is measured against it.
const videoEl = ref<HTMLVideoElement | null>(null);

const screen = useDeviceScreen(() => device, monitor, { api: useRemoteApi() });
const { picture, status } = screen;
watch(canvasEl, (canvas) => picture.attach(canvas));
watch(videoEl, (video) => picture.attachVideo(video));

// Watching without touching: the computer's own grant, or the person's choice here.
const viewOnly = ref(false);
const driving = computed(() => status.value.kind === `live` && !screen.readOnly.value && !viewOnly.value);
const input = useScreenInput({ picture, driving, stage: stageEl, canvas: canvasEl, zoomBox: zoomEl, isMac: isApplePlatform() });
watch(viewOnly, (on) => on && input.releaseAll());

const lock = useFullscreenLock(rootEl, stageEl);
watch(lock.pointerLocked, (on) => input.lockPointer(on));

// The picture's place on the stage (screenFit.ts), from the stage's size, the picture's pixels and this screen's ratio.
const scale = ref<ScreenScale>(`fit`);
const stage = ref({ width: 0, height: 0 });
const ratio = ref(1);
const observer = new ResizeObserver(([entry]) => {
    if (entry !== undefined) {
        stage.value = { width: entry.contentRect.width, height: entry.contentRect.height };
        ratio.value = windowOf(stageEl.value).devicePixelRatio;
    }
});
watch(stageEl, (element, before) => {
    if (before) {
        observer.unobserve(before);
    }
    if (element) {
        observer.observe(element);
    }
});
onScopeDispose(() => observer.disconnect());

const shown = computed(() => monitors.find((each) => each.id === monitor.value) ?? monitors.find((each) => each.primary) ?? monitors[0]);
const pictureSize = computed(() => picture.painted.value ?? (picture.hello.value === undefined ? undefined : { width: picture.hello.value.width, height: picture.hello.value.height }));
const box = computed(() => (pictureSize.value === undefined ? undefined : placePicture(scale.value, pictureSize.value, stage.value, ratio.value)));
// The whole box a 1:1 picture scrolls over; the stage's own box otherwise.
const canvasBox = computed(() => {
    const at = box.value;
    return at === undefined ? undefined : { left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` };
});
const scrollBox = computed(() =>
    scale.value === `actual` && box.value !== undefined
        ? { width: `${Math.max(stage.value.width, box.value.width)}px`, height: `${Math.max(stage.value.height, box.value.height)}px` }
        : undefined,
);
const snapStyle = usePixelSnap(canvasEl, computed(() => picture.painted.value));

// Asks the computer for the picture this scale wants: the stage's size to fit, its whole screen otherwise.
watch(
    [stage, scale, shown, ratio],
    () => {
        if (stage.value.width > 0 && stage.value.height > 0) {
            const asked = askedBox(scale.value, stage.value, shown.value, ratio.value);
            picture.requestSize(asked.width, asked.height);
        }
    },
    { deep: true },
);

const cursor = computed(() => (lock.pointerLocked.value ? `none` : driving.value ? picture.cursor.value : `default`));
// The computer's own pointer where it is not this viewer's (remoteCursor.ts).
const sprite = useRemoteCursor({ pointer: picture.pointer, look: picture.cursorLook, size: pictureSize, box, driving, stage: stageEl });
// The kept cursor while the pointer is locked, on the stage.
const lockedDot = computed(() => {
    const at = input.lockedCursor.value;
    const size = picture.hello.value;
    if (at === undefined || size === undefined || box.value === undefined) {
        return undefined;
    }
    return { left: `${box.value.left + (at.x * box.value.width) / size.width}px`, top: `${box.value.top + (at.y * box.value.height) / size.height}px` };
});

const scales = computed(() => [
    { value: `fit` as const, label: t(`sandbox.deviceScreen.scaleFit`) },
    { value: `actual` as const, label: `1:1` },
    { value: `fill` as const, label: t(`sandbox.deviceScreen.scaleFill`) },
]);
const monitorOptions = computed(() =>
    monitors.map((each) => ({ value: each.id, label: each.name, description: `${each.width}×${each.height}`, icon: `screen` as const })),
);

// The sentence over the stage while there is no picture, after how long it has been on its way.
const message = computed(() => {
    switch (status.value.kind) {
        case `opening`:
        case `connecting`:
            return t(`sandbox.deviceScreen.connectingTo`, { name });
        case `reconnecting`:
            return t(`sandbox.deviceScreen.reconnecting`);
        case `failed`:
            return status.value.reason;
        default:
            return picture.pictured.value ? undefined : t(`sandbox.deviceScreen.connectingTo`, { name });
    }
});
const waiting = computed(() => message.value !== undefined && status.value.kind !== `failed`);
const messageLine = useLineWithElapsed(message, useBusySince(() => waiting.value));

// Full screen's own line, said for a few seconds as it starts: where the keys go, and the way out.
const fullscreenNote = ref(false);
let noteTimer: number | undefined;
watch(lock.fullscreen, (on) => {
    fullscreenNote.value = on;
    window.clearTimeout(noteTimer);
    noteTimer = on ? window.setTimeout(() => (fullscreenNote.value = false), 4000) : undefined;
    input.focus();
});
const soundLabel = computed(() => (picture.sound.muted.value ? t(`browsers.media.unmute`) : t(`browsers.media.mute`)));
// The toolbar in full screen: hidden until the pointer reaches the top edge.
const toolbarShown = ref(false);
</script>

<template>
    <div ref="rootEl" class="relative flex h-full min-h-0 flex-col bg-terminal">
        <!-- In full screen the toolbar waits behind the top edge; a pointer reaching it brings it down. -->
        <div v-if="lock.fullscreen.value" class="absolute inset-x-0 top-0 z-20 h-1.5" @pointerenter="toolbarShown = true" />
        <header
            class="z-20 flex min-h-10 shrink-0 items-center gap-2 border-b border-line bg-card px-2 py-1"
            :class="lock.fullscreen.value ? ['absolute inset-x-0 top-0 shadow-lg transition-transform', toolbarShown ? '' : '-translate-y-full'] : ''"
            @pointerleave="toolbarShown = false"
        >
            <RouterLink :to="back" :class="ui.textButton({ size: `xs` }, `inline-flex shrink-0 items-center`)">
                <Icon name="chevron-right" class="rotate-180 text-2xs" aria-hidden="true" />
                <span class="max-w-32 truncate">{{ name }}</span>
            </RouterLink>
            <Picker
                v-if="monitors.length > 1"
                :model-value="shown?.id"
                :options="monitorOptions"
                variant="ghost"
                :aria-label="t(`sandbox.deviceScreen.monitor`)"
                :header="t(`sandbox.deviceScreen.monitor`)"
                @update:model-value="(id: string | undefined) => (monitor = id)"
            />
            <span v-else-if="shown" class="min-w-0 truncate text-xs text-muted">{{ shown.name }}</span>
            <ConnectionBadge :picture="picture" :status="status" :compact="mobile" />
            <span
                v-if="screen.readOnly.value"
                :class="toneWash(`neutral`, `shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-2xs font-medium`)"
                v-tooltip.bottom="{ title: t(`sandbox.deviceScreen.watchingTitle`), note: t(`sandbox.deviceScreen.watchingNote`) }"
                >{{ t(`sandbox.deviceScreen.watching`) }}</span
            >

            <div class="ml-auto flex shrink-0 items-center gap-1">
                <SegmentedControl v-if="!mobile" v-model="scale" :options="scales" size="xs" />
                <button
                    v-if="!screen.readOnly.value"
                    type="button"
                    :class="ui.chip({ on: viewOnly }, `shrink-0 font-medium`, !viewOnly && `text-content`)"
                    :aria-pressed="viewOnly"
                    v-tooltip.bottom="{ title: t(`sandbox.deviceScreen.viewOnly`), note: t(`sandbox.deviceScreen.viewOnlyNote`) }"
                    @click="viewOnly = !viewOnly"
                >
                    <Icon name="eye" class="text-2xs" aria-hidden="true" />
                    <span v-if="!mobile">{{ t(`sandbox.deviceScreen.viewOnly`) }}</span>
                </button>
                <SendKeysMenu v-if="!screen.readOnly.value" :disabled="!driving" @send="input.sendChord" />
                <!-- The computer's sound, where it sends any: on until muted (mediaSound.ts). -->
                <button
                    v-if="picture.hello.value?.audio"
                    type="button"
                    :class="ui.iconButton({ size: `md`, round: true })"
                    :aria-pressed="picture.sound.muted.value"
                    :aria-label="soundLabel"
                    v-tooltip.bottom="soundLabel"
                    @click="picture.sound.toggleMute()"
                >
                    <Icon :name="picture.sound.muted.value ? `volume-off` : `volume-up`" class="text-xs" />
                </button>
                <button
                    v-if="!mobile && !screen.readOnly.value"
                    type="button"
                    :class="ui.iconButton({ on: lock.pointerLocked.value, size: `md`, round: true })"
                    :disabled="!driving"
                    :aria-pressed="lock.pointerLocked.value"
                    :aria-label="t(`sandbox.deviceScreen.lockPointer`)"
                    v-tooltip.bottom="{ title: t(`sandbox.deviceScreen.lockPointer`), note: t(`sandbox.deviceScreen.lockPointerNote`) }"
                    @click="lock.pointerLocked.value ? lock.unlockPointer() : lock.lockPointer()"
                >
                    <Icon :name="lock.pointerLocked.value ? `lock` : `unlock`" class="text-xs" />
                </button>
                <button
                    v-if="lock.canFullscreen"
                    type="button"
                    :class="ui.iconButton({ size: `md`, round: true })"
                    :aria-label="lock.fullscreen.value ? t(`sandbox.deviceScreen.exitFullscreen`) : t(`sandbox.deviceScreen.fullscreen`)"
                    v-tooltip.bottom="{ title: lock.fullscreen.value ? t(`sandbox.deviceScreen.exitFullscreen`) : t(`sandbox.deviceScreen.fullscreen`) }"
                    @click="lock.fullscreen.value ? lock.exit() : void lock.enter()"
                >
                    <Icon :name="lock.fullscreen.value ? `compress` : `expand`" class="text-xs" />
                </button>
            </div>
        </header>

        <div
            ref="stageEl"
            tabindex="0"
            :aria-label="t(`sandbox.deviceScreen.stageLabel`, { name })"
            class="relative min-h-0 flex-1 select-none outline-none"
            :class="[scale === 'actual' ? 'overflow-auto' : 'overflow-hidden', driving ? 'touch-none' : '']"
            v-on="input.stageListeners"
            @focus="input.focus()"
        >
            <div ref="zoomEl" class="absolute left-0 top-0" :class="scrollBox ? '' : 'h-full w-full'" :style="[scrollBox, input.zoom.value]">
                <canvas ref="canvasEl" class="absolute" :class="picture.tracked.value ? 'invisible' : ''" :style="[canvasBox, snapStyle, { cursor }]" />
                <video
                    v-show="picture.tracked.value"
                    ref="videoEl"
                    class="absolute"
                    :style="[canvasBox, { cursor }]"
                    muted
                    autoplay
                    playsinline
                    disablepictureinpicture
                    :aria-label="t(`sandbox.deviceScreen.stageLabel`, { name })"
                />
            </div>
            <!-- Typing, an input method, a paste and a phone's keyboard land here and go to the computer (screenInput.ts). -->
            <!-- allow(inputs): never seen, a field only so the person's browser has somewhere to type; the design system's fields are for what a reader sees -->
            <textarea
                :ref="input.bindSink"
                tabindex="-1"
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                :inputmode="input.touchSeen.value && !input.softKeyboard.value ? 'none' : undefined"
                :aria-label="t(`sandbox.deviceScreen.keyboardField`)"
                class="pointer-events-none absolute z-0 h-px w-px resize-none overflow-hidden opacity-0"
                :style="input.sinkAt.value"
                v-on="input.sinkListeners"
            />
            <div
                v-if="input.trackpadDot.value"
                class="pointer-events-none absolute z-[2] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-black/60 shadow"
                :style="input.trackpadDot.value"
            />
            <div v-if="sprite && !lockedDot" class="pointer-events-none absolute z-[2]" :style="{ left: `${sprite.left}px`, top: `${sprite.top}px` }">
                <img
                    v-if="sprite.image"
                    :src="sprite.image.url"
                    alt=""
                    class="max-w-none"
                    :style="{ width: `${sprite.image.width}px`, transform: `translate(${-sprite.image.hotX}px, ${-sprite.image.hotY}px)` }"
                />
                <svg v-else width="12" height="19" viewBox="0 0 12 19" aria-hidden="true" class="drop-shadow">
                    <path d="M0.5 0.5 L0.5 16 L4.5 12.2 L7.2 18.2 L9.4 17.2 L6.8 11.4 L11.5 11.4 Z" fill="black" stroke="white" stroke-width="1" />
                </svg>
            </div>
            <div
                v-if="lockedDot"
                class="pointer-events-none absolute z-[2] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-black/70"
                :style="lockedDot"
            />

            <div v-if="message" class="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
                <div class="pointer-events-auto flex max-w-md flex-col items-center gap-2 rounded-md bg-card px-3 py-2 text-center">
                    <span class="text-xs" :class="status.kind === 'failed' ? 'text-content' : 'text-muted'">{{ messageLine }}</span>
                    <Button v-if="status.kind === 'failed'" size="small" tier="accent" :label="t(`sandbox.deviceScreen.tryAgain`)" @click="screen.reopen()" />
                    <Button
                        v-else-if="status.kind === 'reconnecting'"
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.deviceScreen.reconnectNow`)"
                        @click="screen.reopen()"
                    />
                </div>
            </div>

            <!-- Where the keys go now, and the way out, as full screen starts. -->
            <div v-if="fullscreenNote" class="pointer-events-none absolute inset-x-0 top-3 z-10 flex justify-center px-4">
                <span class="rounded-md bg-card/90 px-3 py-1.5 text-xs text-content shadow-lg">
                    {{ lock.keysCaptured.value ? t(`sandbox.deviceScreen.keysCaptured`, { name }) : t(`sandbox.deviceScreen.keysNotCaptured`) }}
                </span>
            </div>

            <!-- A finger's two modes and its keyboard, once a finger has touched the picture. -->
            <div v-if="input.touchSeen.value && driving" class="absolute bottom-3 right-3 z-[2] flex gap-2">
                <Button
                    size="small"
                    :tier="input.softKeyboard.value ? 'accent' : 'boring'"
                    :aria-pressed="input.softKeyboard.value"
                    :label="t(`sandbox.deviceScreen.keyboard`)"
                    @click="input.toggleKeyboard"
                />
                <Button
                    size="small"
                    :tier="input.trackpad.value ? 'accent' : 'boring'"
                    :aria-pressed="input.trackpad.value"
                    :label="t(`sandbox.deviceScreen.trackpad`)"
                    @click="input.setTrackpad(!input.trackpad.value)"
                />
            </div>
        </div>
    </div>
</template>
