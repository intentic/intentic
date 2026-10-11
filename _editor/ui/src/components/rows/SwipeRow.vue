<!-- A row a thumb can swipe aside: drag it left and one action shows under it; let go past the line, or flick, and the row
     leaves and the action runs. The same action always has a press of its own elsewhere (a menu, a button): the swipe is
     the fast way to it, never the only one, so a keyboard or a screen reader loses nothing and the pane is aria-hidden. -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { IconName } from "../../icons/iconSets.js";
import Icon from "../primitives/Icon.vue";
import { commits, lockAxis, tick, velocityTracker } from "../../motion/swipe.js";
import { FLING, SETTLE, type Spring, springReaches, springTiming, travelsPerSecond } from "../../motion/spring.js";
import { lessMotion } from "../../motion/choice.js";
import { canAnimate } from "../../motion/fold.js";

export interface SwipeAction {
    readonly label: string;
    readonly icon: IconName;
    /** `accent` files something away and can be undone; `danger` takes something back. */
    readonly tone?: `accent` | `danger`;
}

const { action, disabled = false } = defineProps<{
    /** What a swipe does; none and the row is an ordinary row. */
    action?: SwipeAction;
    disabled?: boolean;
}>();
const emit = defineEmits<{ commit: [] }>();

// Past this share of the row's width a release commits, before its speed is counted (motion/swipe.ts `commits`).
const COMMIT_SHARE = 0.4;
// How far past the row's own edge it flies, so its shadow and border leave with it.
const EXIT_GAP_PX = 24;
// What still stands here this long after it left was not taken away (a confirm opened, the action was refused): it comes back.
const RETURN_MS = 520;

const root = ref<HTMLElement>();
const body = ref<HTMLElement>();
const pane = ref<HTMLElement>();
const mark = ref<HTMLElement>();

// One gesture at a time, all of it plain state: nothing here is drawn by Vue, every frame is a style write.
let pointer: number | undefined;
let startX = 0;
let startY = 0;
let base = 0;
let width = 0;
let axis: `x` | `y` | undefined;
let target = 0;
let drawn = 0;
let frame = 0;
let armed = false;
let gone = false;
let running: Animation | undefined;
let returning: ReturnType<typeof setTimeout> | undefined;
let swallow: (() => void) | undefined;
const track = velocityTracker();

// Where the row stands now, mid-spring included, so a finger catching it in flight takes it from there.
const standing = (): number => {
    const el = body.value;
    if (el === undefined || running === undefined) {
        return drawn;
    }
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    running.cancel();
    running = undefined;
    return matrix.m41;
};

const paint = (x: number): void => {
    const el = body.value;
    if (el === undefined) {
        return;
    }
    drawn = x;
    el.style.transform = x === 0 ? `` : `translate3d(${x}px, 0, 0)`;
    const share = width === 0 ? 0 : Math.max(0, -x) / (width * COMMIT_SHARE);
    if (mark.value !== undefined) {
        mark.value.style.opacity = `${Math.min(1, share * 1.3)}`;
        mark.value.style.scale = `${0.72 + 0.28 * Math.min(1, share)}`;
    }
    const now = share >= 1;
    if (now !== armed) {
        armed = now;
        pane.value?.toggleAttribute(`data-armed`, now);
        if (now) {
            tick();
        }
        // A pop on the line: the moment a release stops springing back and starts committing.
        if (now && canAnimate(mark.value) && !lessMotion()) {
            mark.value.animate([{ transform: `scale(1)` }, { transform: `scale(1.18)` }, { transform: `scale(1)` }], {
                duration: 220,
                easing: `cubic-bezier(0.2, 0, 0, 1)`,
            });
        }
    }
};

const schedule = (): void => {
    frame ||= requestAnimationFrame(() => {
        frame = 0;
        paint(target);
    });
};

// A click is what a released tap turns into; one that ends a swipe is not a tap on whatever was under the finger.
const swallowNextClick = (): void => {
    const el = root.value;
    if (el === undefined || swallow !== undefined) {
        return;
    }
    const stop = (event: Event): void => {
        event.preventDefault();
        event.stopPropagation();
        release();
    };
    const release = (): void => {
        el.removeEventListener(`click`, stop, true);
        swallow = undefined;
    };
    el.addEventListener(`click`, stop, true);
    swallow = release;
};

const reveal = (on: boolean): void => {
    if (pane.value !== undefined) {
        pane.value.style.visibility = on ? `visible` : ``;
    }
    if (body.value !== undefined) {
        body.value.style.willChange = on ? `transform` : ``;
    }
};

// Plays the row from where it stands to `to` on `spring`, carrying the release's speed (px/ms, signed like x); the
// action's mark rides the same curve, so it fades as the row covers it rather than blinking out under it.
const glide = (to: number, velocity: number, spring: Spring): Animation | undefined => {
    const el = body.value;
    if (el === undefined) {
        return undefined;
    }
    const from = drawn;
    const distance = to - from;
    const timing = springTiming(distance, velocity * Math.sign(distance), spring);
    const markFrom = { opacity: mark.value?.style.opacity || `0`, scale: mark.value?.style.scale || `0.72` };
    paint(to);
    if (timing.duration === 0 || typeof el.animate !== `function`) {
        return undefined;
    }
    running = el.animate([{ transform: `translate3d(${from}px, 0, 0)` }, { transform: `translate3d(${to}px, 0, 0)` }], timing);
    const markTo = { opacity: mark.value?.style.opacity || `0`, scale: mark.value?.style.scale || `0.72` };
    mark.value?.animate([markFrom, markTo], timing);
    return running;
};

const settle = (velocity: number): void => {
    const run = glide(0, velocity, SETTLE);
    const done = (): void => {
        if (running === run) {
            running = undefined;
        }
        if (drawn === 0 && pointer === undefined) {
            reveal(false);
        }
    };
    if (run === undefined) {
        done();
        return;
    }
    run.finished.then(done, () => {});
};

const commit = (velocity: number): void => {
    gone = true;
    const exit = -(width + EXIT_GAP_PX);
    const from = drawn;
    const run = glide(exit, velocity, FLING);
    // The action runs the moment the row is out of sight (its edge past the row's), not when its spring's tail has
    // finished settling off-screen: the list closing ranks then follows the row out instead of waiting on nothing.
    const out = run === undefined ? 0 : springReaches(FLING, travelsPerSecond(-velocity, exit - from), (width + from) / (width + EXIT_GAP_PX + from));
    const leave = (): void => {
        if (!gone) {
            return;
        }
        emit(`commit`);
        returning = setTimeout(() => {
            returning = undefined;
            if (gone && root.value?.isConnected === true) {
                gone = false;
                settle(0);
            }
        }, RETURN_MS);
    };
    if (out <= 0) {
        leave();
    } else {
        setTimeout(leave, out * 1000);
    }
};

const onDown = (event: PointerEvent): void => {
    // A mouse has the row's own buttons under its hover; a swipe is a finger's (and a pen's).
    if (action === undefined || disabled || gone || pointer !== undefined || event.pointerType === `mouse` || !event.isPrimary) {
        return;
    }
    // A drag inside a field selects its text.
    if (event.target instanceof Element && event.target.closest(`input, textarea, select, [contenteditable]`) !== null) {
        return;
    }
    pointer = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    base = standing();
    width = root.value?.offsetWidth ?? 0;
    axis = base === 0 ? undefined : `x`;
    track.reset();
    track.push(event.timeStamp, event.clientX);
    if (axis === `x`) {
        begin(event);
    }
};

const begin = (event: PointerEvent): void => {
    root.value?.setPointerCapture?.(event.pointerId);
    reveal(true);
    swallowNextClick();
};

const end = (): void => {
    pointer = undefined;
    axis = undefined;
    if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
    }
};

const onMove = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) {
        return;
    }
    const dx = event.clientX - startX;
    if (axis === undefined) {
        axis = lockAxis(dx, event.clientY - startY);
        // Down is the page's scroll, and right has nothing under it.
        if (axis === `y` || (axis === `x` && dx > 0)) {
            end();
            swallow?.();
            return;
        }
        if (axis === undefined) {
            return;
        }
        begin(event);
    }
    track.push(event.timeStamp, event.clientX);
    // Left as far as the finger goes; right of where it started, nowhere.
    target = Math.min(0, Math.max(-width, base + dx));
    schedule();
};

const onUp = (event: PointerEvent): void => {
    if (event.pointerId !== pointer) {
        return;
    }
    const swiping = axis === `x`;
    end();
    if (!swiping) {
        return;
    }
    paint(target);
    const velocity = track.velocity(event.timeStamp);
    // A cancel is the browser taking the touch (a system gesture, a scroll): never a commit.
    if (event.type === `pointerup` && commits({ travel: -drawn, velocity: -velocity, extent: width }, COMMIT_SHARE)) {
        commit(velocity);
    } else {
        settle(velocity);
    }
    // The tap a release would turn into fires after this; anything later is a new press.
    setTimeout(() => swallow?.(), 400);
};

onBeforeUnmount(() => {
    gone = false;
    end();
    running?.cancel();
    swallow?.();
    if (returning !== undefined) {
        clearTimeout(returning);
    }
});
</script>

<template>
    <div
        ref="root"
        class="relative"
        :class="action !== undefined && !disabled ? 'touch-pan-y touch-pinch-zoom' : ''"
        @pointerdown="onDown"
        @pointermove="onMove"
        @pointerup="onUp"
        @pointercancel="onUp"
    >
        <!-- Hidden at rest: a row's rounded, antialiased edge would otherwise wear a fringe of the action's colour. -->
        <div
            v-if="action !== undefined"
            ref="pane"
            aria-hidden="true"
            class="swipe-pane pointer-events-none invisible absolute inset-0 flex items-center justify-end overflow-hidden rounded-[inherit] pr-5"
            :data-tone="action.tone ?? `accent`"
        >
            <span ref="mark" class="flex flex-col items-center gap-1 opacity-0">
                <Icon :name="action.icon" class="text-lg" />
                <span class="text-2xs font-semibold">{{ action.label }}</span>
            </span>
        </div>
        <div ref="body" class="relative">
            <slot />
        </div>
    </div>
</template>

<style scoped>
/* Before the line the action is a tint and its own colour: a hint of what is under the row. Past it the pane floods with
   that colour, the commitment a release now makes, in one step a thumb can feel without looking. */
.swipe-pane {
    --swipe-fill: var(--color-primary-fill);
    color: var(--swipe-fill);
    background-color: color-mix(in oklab, var(--swipe-fill) 16%, var(--color-overlay));
    transition:
        background-color 140ms var(--ease-smooth),
        color 140ms var(--ease-smooth);
}
.swipe-pane[data-tone="danger"] {
    --swipe-fill: var(--color-danger-fill);
}
.swipe-pane[data-armed] {
    color: var(--color-fill-content);
    background-color: var(--swipe-fill);
}
</style>
