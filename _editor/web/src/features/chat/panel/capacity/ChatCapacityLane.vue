<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { useReducedMotion } from "@intentic/ui/motion";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { CapacityLane, CapacityRow } from "./chatCapacity";
import { meterFill, meterTint, meterTrack, remainingFigure, usageTone } from "../../session/usageStatus";

// One lane of the capacity rail: its axis label, its bar and its figure, as three cells of the parent's grid.
// A re-read moves it rather than swapping it: the bar, the figure and the tint travel together from the old reading to
// the new one, so the eye sees which lane changed and by how much. When a lane drops, what was just spent stays behind
// as a faint trail that then drains away (the "damage trail" games use), so the size of the loss is seen without a
// delta label the column has no width for. A refill just grows. First paint doesn't animate, since nothing changed.
// Reduced motion snaps straight to the new reading.
const props = defineProps<{ lane: CapacityLane; row: CapacityRow }>();
const t = useT();

const reduced = useReducedMotion();

// Long enough to follow, short enough that a refresh doesn't feel slow. The trail waits for the bar to settle, then drains.
const MOVE_MS = 650;
const TRAIL_HOLD_MS = 450;
const TRAIL_MS = 550;

const easeOut = (x: number): number => 1 - (1 - x) ** 3;
const easeInOut = (x: number): number => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);

// Shown is the used percent the drawing reads from; trail is the fill width the faint segment stops at.
const shown = ref(props.lane.percent);
const trail = ref(meterFill(props.lane.percent));
let frame: number | undefined;

const stop = (): void => {
    if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
    }
};
onBeforeUnmount(stop);

watch(
    () => props.lane.percent,
    (next) => {
        stop();
        const from = shown.value;
        const trailFrom = Math.max(trail.value, meterFill(from));
        const target = meterFill(next);
        if (reduced.value || typeof requestAnimationFrame !== `function` || from === next) {
            shown.value = next;
            trail.value = target;
            return;
        }
        // Timed from the first frame's own stamp: rAF's clock is not always performance.now()'s.
        let start: number | undefined;
        const step = (now: number): void => {
            start ??= now;
            const elapsed = Math.max(0, now - start);
            shown.value = from + (next - from) * easeOut(Math.min(1, elapsed / MOVE_MS));
            // Only a loss leaves a trail; a refill grows under it with nothing behind.
            const drain = Math.min(1, Math.max(0, (elapsed - MOVE_MS - TRAIL_HOLD_MS) / TRAIL_MS));
            trail.value = trailFrom > target ? trailFrom + (target - trailFrom) * easeInOut(drain) : meterFill(shown.value);
            frame = elapsed < MOVE_MS + TRAIL_HOLD_MS + TRAIL_MS ? requestAnimationFrame(step) : undefined;
        };
        frame = requestAnimationFrame(step);
    },
);

const tint = computed(() => (props.lane.capped ? {} : meterTint(shown.value)));
const tone = computed(() => (props.lane.capped ? `text-subtle` : usageTone(shown.value)));
const fill = computed(() => meterFill(shown.value));
const figure = computed(() => remainingFigure(shown.value, props.row.stale));

// How long until an allowance refills; undefined when unmeasured or already past. A spent lane keeps it: when it
// comes back is the one thing left worth saying about it.
const laneReset = (lane: CapacityLane, now: number = Date.now()): string | undefined => {
    if (lane.resetsAt === undefined) {
        return undefined;
    }
    const diffMs = lane.resetsAt * 1000 - now;
    if (diffMs <= 0) {
        return undefined;
    }
    const diffMinutes = Math.ceil(diffMs / 60_000);
    if (diffMinutes < 60) {
        return t(`chat.chatCapacityLane.inMinutes`, { minutes: diffMinutes });
    }
    const diffHours = Math.floor(diffMinutes / 60);
    const remMinutes = diffMinutes % 60;
    if (diffHours < 24) {
        return remMinutes > 0
            ? t(`chat.chatCapacityLane.inHoursMinutes`, { hours: diffHours, minutes: remMinutes })
            : t(`chat.chatCapacityLane.inHours`, { hours: diffHours });
    }
    const diffDays = Math.floor(diffMinutes / (24 * 60));
    const remHours = Math.floor((diffMinutes % (24 * 60)) / 60);
    if (diffDays < 2 && remHours > 0) {
        return t(`chat.chatCapacityLane.inDayHours`, { hours: remHours });
    }
    return t(`chat.chatCapacityLane.inDays`, { days: diffDays });
};
const reset = computed(() => (props.lane.capped ? undefined : laneReset(props.lane)));
</script>

<template>
    <!-- Below the account name, not beside it at the same size: this is the little chart's axis, not another name.
         A lane inside another (the session inside the week) hangs off it on an elbow, one step in per level. -->
    <span class="flex min-w-0 items-center text-3xs text-subtle">
        <span
            v-if="lane.depth > 0"
            class="mr-1 ml-0.5 size-1.5 shrink-0 -translate-y-0.5 rounded-bl-2xs border-b border-l border-line-strong"
            :style="{ marginLeft: `${0.125 + (lane.depth - 1) * 0.625}rem` }"
        />
        <span class="max-w-18 truncate">
            {{ lane.short }}<span v-if="lane.scope !== undefined">&nbsp;·&nbsp;{{ lane.scope }}</span>
        </span>
    </span>
    <!-- Drains as turns spend it: the fill is what is left. A spent pool draws no fill and tints its
         track instead, since an empty neutral track reads as "no reading". A nested lane draws thinner,
         since the lane holding it is the headline; and turns neutral when that one is spent, since its
         room can't be used until the holder reopens (green would claim room that isn't spendable). -->
    <span
        class="relative block overflow-hidden rounded-full transition-colors duration-500 motion-reduce:transition-none"
        :class="[meterTrack(shown), lane.depth > 0 ? `h-0.5` : `h-1`]"
    >
        <!-- What the last re-read took, left behind for a moment before it drains to the new length. -->
        <span
            v-if="trail > fill + 0.1"
            class="ui-meter-fill absolute inset-y-0 left-0 block rounded-full opacity-35"
            :class="tone"
            :style="{ width: `${trail}%`, ...tint }"
            data-meter-trail
        />
        <span class="ui-meter-fill relative block h-full rounded-full" :class="tone" :style="{ width: `${fill}%`, ...tint }" />
    </span>
    <div class="flex items-baseline justify-end gap-1 whitespace-nowrap text-right">
        <span class="text-2xs font-medium tabular-nums" :class="tone" :style="tint">
            {{ figure }}
        </span>
        <!-- A held lane's own reset is moot: it opens when its holder does, dated on the holder's line. -->
        <span v-if="reset" class="text-3xs text-subtle">·&nbsp;{{ reset }}</span>
    </div>
</template>
