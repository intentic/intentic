<!-- Mobile action sheet: a PrimeVue Drawer docked to the bottom edge, the touch replacement for Popover/ContextMenu. -->
<script setup lang="ts">
import Drawer from "primevue/drawer";
import { onBeforeUnmount, ref, watch } from "vue";
import { FLING, SETTLE, springTiming } from "../../motion/spring.js";
import { commits, lockAxis, rubberBand, velocityTracker } from "../../motion/swipe.js";
import { useBackDismiss } from "../../composables/useBackDismiss.js";

const { header } = defineProps<{ header?: string }>();
const visible = defineModel<boolean>({ required: true });

useBackDismiss(visible);

// THE DRAWER EXISTS FROM ITS FIRST OPENING ON. A phone mounts dozens of closed sheets (three on every board card, ten
// behind a chat's composer), and each closed PrimeVue Drawer is still a component with its theme, passthrough and
// portal set up; a sheet nobody opened costs nothing this way. Mounting it already visible still slides it in, since
// the Drawer's transition is `appear`. Kept once opened, so closing plays its leave transition and reopening is instant.
const opened = ref(visible.value);
watch(visible, (now) => {
    if (now) {
        opened.value = true;
    }
});

// Past this much downward travel a release dismisses, before its speed is counted; a flick dismisses well short of it
// and a flick back up keeps the sheet (motion/swipe.ts `commits`). Under it the sheet springs back to its docked place.
const DISMISS_PX = 96;
// What the dimmed page behind keeps of its dimming at the sheet's full drop: it lightens with the drag, so how far the
// sheet has gone is felt in the whole screen, not only in the sheet.
const MASK_FLOOR = 0.25;

const grip = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
let panel: HTMLElement | undefined;
let mask: HTMLElement | undefined;
let maskBase = ``;
let startY = 0;
let travel = 0;
let height = 0;
let dragging = false;
let running: Animation | undefined;
const track = velocityTracker();

// The mask's dimming at a drop of `y`. Its colour, not its opacity: the sheet is drawn inside the mask and would fade with it.
const maskAt = (y: number): string =>
    y <= 0 || height === 0
        ? maskBase
        : `color-mix(in srgb, ${maskBase} ${Math.round(100 * (1 - (1 - MASK_FLOOR) * Math.min(1, y / height)))}%, transparent)`;

const draw = (y: number): void => {
    travel = y;
    if (panel !== undefined) {
        panel.style.transform = y === 0 ? `` : `translate3d(0, ${y}px, 0)`;
    }
    // Through the theme's own variable: the mask's arrival is a CSS animation that holds its last frame, and that
    // outranks an inline colour, but it reads its colour from this variable on every frame.
    if (y <= 0) {
        mask?.style.removeProperty(`--px-mask-background`);
    } else {
        mask?.style.setProperty(`--px-mask-background`, maskAt(y));
    }
};

// Where the sheet stands now, a spring in flight included, so a finger can catch it mid-way.
const standing = (): number => {
    if (panel === undefined || running === undefined) {
        return travel;
    }
    const y = new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42;
    running.cancel();
    running = undefined;
    return y;
};

const hold = (on: boolean): void => {
    for (const el of [panel, mask]) {
        if (el !== undefined) {
            el.style.transition = on ? `none` : ``;
        }
    }
    if (panel !== undefined) {
        panel.style.willChange = on ? `transform` : ``;
    }
};

// A drag takes the sheet `from` the element it started on; false where that is not inside an open sheet.
const start = (y: number, at: number, from: Element | null | undefined): boolean => {
    panel = from?.closest<HTMLElement>(`.p-drawer`) ?? undefined;
    if (panel === undefined) {
        return false;
    }
    mask = panel.parentElement ?? undefined;
    maskBase = mask === undefined ? `` : getComputedStyle(mask).backgroundColor;
    height = panel.offsetHeight;
    dragging = true;
    travel = standing();
    startY = y - travel;
    track.reset();
    track.push(at, y);
    // The Drawer's theme eases its transform and its mask's colour; under a finger that easing is lag, and under one
    // of these springs it is a second animation fighting the first. Handed back once the sheet is at rest.
    hold(true);
    return true;
};

const move = (y: number, at: number): void => {
    track.push(at, y);
    const raw = y - startY;
    // Down follows the finger; up stretches a little and gives, since the sheet is docked to the bottom edge it would lift off.
    draw(raw >= 0 ? raw : rubberBand(raw, height * 0.15));
};

const end = (at: number, ended: boolean): void => {
    if (!dragging || panel === undefined) {
        return;
    }
    dragging = false;
    const sheet = panel;
    const from = travel;
    const velocity = track.velocity(at);
    const animates = typeof sheet.animate === `function`;
    // A cancel is the browser taking the touch back: never a dismissal.
    if (ended && height > 0 && commits({ travel: from, velocity, extent: height }, DISMISS_PX / height)) {
        // Out at the finger's speed and held there: the Drawer's own leave then plays under this, out of sight, and the
        // mask fades from the dimming the drag left it at rather than from its full dimming back again.
        const to = height + 16;
        const timing = springTiming(to - from, velocity, FLING);
        if (timing.duration > 0 && animates) {
            sheet.animate([{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, ${to}px, 0)` }], {
                ...timing,
                fill: `forwards`,
            });
            mask?.animate([{ backgroundColor: maskAt(from) }, { backgroundColor: `transparent` }], {
                duration: timing.duration,
                easing: `ease-out`,
                fill: `forwards`,
            });
        }
        travel = 0;
        visible.value = false;
        return;
    }
    // Back to its docked place, on a spring carrying the release: it used to jump there in one frame.
    const timing = springTiming(-from, -velocity, SETTLE);
    const dimmed = maskAt(Math.max(0, from));
    draw(0);
    if (timing.duration > 0 && animates) {
        const run = sheet.animate([{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, 0, 0)` }], timing);
        running = run;
        mask?.animate([{ backgroundColor: dimmed }, { backgroundColor: maskBase }], timing);
        run.finished.then(
            () => {
                if (running === run && !dragging) {
                    running = undefined;
                    hold(false);
                }
            },
            () => {},
        );
    } else {
        hold(false);
    }
};

// The grab handle and the header move the sheet, by any pointer: drawn but inert, a handle reads as broken.
const onDown = (event: PointerEvent): void => {
    if (start(event.clientY, event.timeStamp, grip.value)) {
        grip.value?.setPointerCapture(event.pointerId);
    }
};
const onMove = (event: PointerEvent): void => {
    if (dragging) {
        move(event.clientY, event.timeStamp);
    }
};
const onUp = (event: PointerEvent): void => {
    end(event.timeStamp, event.type === `pointerup`);
};

// So does the content, pulled down from its very top, the way a phone's own sheets go: the handle is a strip a thumb
// misses, and a list already at its top has nowhere further up to go. Touch events, since the scroller keeps its own
// scroll for every other drag: only a pull down from the top is refused to it, in its first moves (motion/swipe.ts).
let pulling: { readonly id: number; readonly x: number; readonly y: number } | undefined;
let decided = false;
const touchOf = (event: TouchEvent): Touch | undefined => [...event.changedTouches].find((touch) => touch.identifier === pulling?.id);
const onTouchStart = (event: TouchEvent): void => {
    const touch = event.changedTouches[0];
    pulling =
        event.touches.length === 1 && touch !== undefined && (scroller.value?.scrollTop ?? 1) <= 0
            ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
            : undefined;
    decided = false;
};
// Bound without `.passive`, so a pull can be refused to the scroller.
const onTouchMove = (event: TouchEvent): void => {
    const touch = pulling === undefined ? undefined : touchOf(event);
    if (pulling === undefined || touch === undefined) {
        return;
    }
    if (!decided) {
        const dy = touch.clientY - pulling.y;
        const axis = lockAxis(touch.clientX - pulling.x, dy);
        if (axis === undefined) {
            return;
        }
        if (axis === `x` || dy < 0 || !event.cancelable || !start(touch.clientY, event.timeStamp, scroller.value)) {
            pulling = undefined;
            return;
        }
        decided = true;
        // From where the finger is now, so the sheet does not jump by the slop it took to decide.
        startY = touch.clientY - travel;
    }
    event.preventDefault();
    move(touch.clientY, event.timeStamp);
};
const onTouchEnd = (event: TouchEvent): void => {
    if (pulling !== undefined && touchOf(event) !== undefined) {
        pulling = undefined;
        if (decided) {
            end(event.timeStamp, event.type === `touchend`);
        }
    }
};
onBeforeUnmount(() => {
    running?.cancel();
});
</script>

<template>
    <Drawer
        v-if="opened"
        v-model:visible="visible"
        position="bottom"
        :show-close-icon="false"
        :block-scroll="true"
        class="!h-auto !max-h-panel-xl !rounded-t-2xl !border-x-0 !border-b-0 !border-t !border-line !bg-card"
        :pt="{ header: { class: `!hidden` }, content: { class: `flex min-h-0 flex-col !overflow-hidden !p-0` } }"
    >
        <!-- `touch-none`: the browser must not read the drag as a scroll, or the sheet never sees the move. -->
        <div
            ref="grip"
            class="shrink-0 cursor-grab touch-none pb-2 pt-1 active:cursor-grabbing"
            @pointerdown="onDown"
            @pointermove="onMove"
            @pointerup="onUp"
            @pointercancel="onUp"
        >
            <div class="mx-auto mt-2 h-1 w-9 rounded-full bg-line" aria-hidden="true" />
            <div v-if="header" class="px-4 pt-3 text-sm font-semibold text-content">{{ header }}</div>
        </div>
        <!-- THE ONE SCROLLER IN THE SHEET. It must be the element that overflows: `overscroll-behavior: contain` on a scroll
     container that cannot scroll swallows the finger instead of chaining to whatever can, which is how every tall
     sheet (model picker, chats) stopped moving under touch while the Drawer's own content box held the overflow. -->
        <div
            ref="scroller"
            class="min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2"
            style="overscroll-behavior: contain"
            @touchstart.passive="onTouchStart"
            @touchmove="onTouchMove"
            @touchend.passive="onTouchEnd"
            @touchcancel.passive="onTouchEnd"
        >
            <slot />
        </div>
    </Drawer>
</template>
