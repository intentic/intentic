<script setup lang="ts">
import { placeAnchored, type Placement, type Side, useHoverIntent } from "@intentic/ui";
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref } from "vue";
import {
    formatAge,
    formatRemaining,
    formatReset,
    meterFill,
    meterTint,
    meterTrack,
    type PlanHeadroom,
    type PlanLimitPool,
    usageDetail,
    usageTone,
} from "../features/chat/session/usageStatus";
import { useT } from "@intentic/ui/i18n";

// Usage meter and breakdown panel, shared by the composer chip, model picker and Agent tab rows. Plan usage is
// always a draining bar, the same one the capacity rail and this card draw; a ring means context, never an
// allowance. The inline meter stacks one hairline per account-wide pool (weekly first, then the 5-hour session),
// plus the binding pool when that is a per-model slice, so a roomy session can't hide a spent week. The card is a
// small table (line and meter per pool), not a tooltip; opens beside the meter, never over the row column, falling
// back above only when neither flank fits. Teleported into the anchor's own window; sr-only text beside the bars
// repeats it for screen readers.

const t = useT();

const { headroom, flank = `right` } = defineProps<{
    headroom: PlanHeadroom;
    // Own spend on this account, e.g. '14 turns · 2.1M/40k · $3.12'; reference, so it rides the card, not the row.
    activity?: string;
    // Which way the card spills, away from the rest of the row; flips flank only when its side lacks room.
    flank?: Side;
}>();

// Account-wide pools in display order, then the binding one if it is a slice; a measured reading with every pool
// reset draws one full bar, since no bars at all is what unmeasured looks like.
const bars = computed<readonly number[]>(() => {
    const shown: PlanLimitPool[] = headroom.pools.filter((pool) => pool.gates === `all`);
    if (headroom.binding !== undefined && !shown.some((pool) => pool.kind === headroom.binding?.kind)) {
        shown.push(headroom.binding);
    }
    return shown.length === 0 ? [headroom.percent] : shown.map((pool) => pool.percent);
});

const GAP = 8; // px between the meter and the card: the arrow's height
const EDGE = 8; // px of the window kept clear on every side
// Long enough to skip a pass-by sweep across a column of meters, short enough a deliberate hover feels instant.
const hover = useHoverIntent({ open: 120 });

const anchor = ref<HTMLElement>();
const box = ref<HTMLElement>();
const open = hover.shown;
// Undefined until measured; parked off-screen until then so it doesn't flash at the window's origin on open.
const placement = ref<Placement>();

const style = computed<CSSProperties>(() =>
    placement.value === undefined
        ? { transform: `translate(-200vw, -200vh)` }
        : {
              left: `${Math.round(placement.value.left)}px`,
              top: `${Math.round(placement.value.top)}px`,
              "--ui-anchored-arrow": `${Math.round(placement.value.arrow)}px`,
          },
);

const reposition = (): void => {
    const el = box.value;
    const host = anchor.value;
    const view = host?.ownerDocument.defaultView;
    if (el === undefined || host === undefined || view === null || view === undefined) {
        return;
    }
    const rect = host.getBoundingClientRect();
    const size = el.getBoundingClientRect();
    // Sideways when either flank fits; placeAnchored flips only if needed. Above is the fallback, not the default.
    const beside = Math.max(rect.left, view.innerWidth - rect.right) >= size.width + GAP + EDGE;
    placement.value = placeAnchored({
        anchor: rect,
        box: size,
        view: { width: view.innerWidth, height: view.innerHeight },
        side: beside ? flank : `top`,
        cross: `center`,
        gap: GAP,
        edge: EDGE,
    });
};

// Scroll/resize listeners arm on the anchor's own document/window, so they disarm correctly even if it moved.
let armed: { readonly doc: Document; readonly view: Window } | undefined;

const hide = (): void => {
    hover.hide();
    if (armed !== undefined) {
        armed.doc.removeEventListener(`scroll`, hide, true);
        armed.view.removeEventListener(`resize`, hide);
        armed = undefined;
    }
    placement.value = undefined;
};

const reveal = async (): Promise<void> => {
    await nextTick(); // the card exists, and has a size: only after this render
    reposition();
    const doc = anchor.value?.ownerDocument;
    const view = doc?.defaultView;
    if (doc === undefined || view === null || view === undefined || armed !== undefined) {
        return;
    }
    doc.addEventListener(`scroll`, hide, true); // capture: it is the scrolling ANCESTOR that fires
    view.addEventListener(`resize`, hide);
    armed = { doc, view };
};

const show = (): void => hover.enter(() => void reveal());

onBeforeUnmount(hide);
</script>

<template>
    <!-- The anchor includes whatever rides beside the meter (the chip's percentage), so hovering it opens the card. -->
    <span ref="anchor" class="inline-flex items-center gap-1" @mouseenter="show" @mouseleave="hide" @pointerdown="hide">
        <!-- Drains like every allowance meter: the fill is what is left, and a spent pool tints its empty track. -->
        <span class="inline-flex w-4 shrink-0 flex-col gap-0.5" aria-hidden="true">
            <span v-for="(percent, index) in bars" :key="index" class="block h-[3px] overflow-hidden rounded-full" :class="meterTrack(percent)">
                <span
                    class="ui-meter-fill block h-full rounded-full"
                    :class="usageTone(percent)"
                    :style="{ width: `${meterFill(percent)}%`, ...meterTint(percent) }"
                />
            </span>
        </span>
        <slot />
        <!-- The bars are aria-hidden and a pointer-only card never reaches a screen reader, so it's spoken here instead. -->
        <span class="sr-only">{{ activity ? `${usageDetail(headroom)} ${activity}.` : usageDetail(headroom) }}</span>

        <Teleport v-if="open && anchor !== undefined" :to="anchor.ownerDocument.body">
            <!-- aria-hidden: the sr-only line already says this; pointer-events-none: never eat the hover that raised it. -->
            <div
                ref="box"
                class="ui-anchored pointer-events-none"
                :class="`ui-anchored-${placement?.side ?? flank}`"
                :style="style"
                aria-hidden="true"
            >
                <div class="ui-anchored-surface w-60 gap-3 px-3 py-2.5 text-left">
                    <!-- Age sits in the header, not the footer: every figure below is a floor once stale, qualifying the whole card. -->
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`shared.planLimits`) }}</span>
                        <span class="shrink-0 text-2xs text-subtle">{{
                            t(`common.usageRing.measured`, { measuredAt: formatAge(headroom.measuredAt) })
                        }}</span>
                    </div>

                    <!-- One line per pool: pools are independently gated, so which is about to bite can't come from one number. -->
                    <div v-for="pool in headroom.pools" :key="pool.kind" class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="min-w-0 truncate text-xs" :class="pool === headroom.binding ? `font-medium text-content` : `text-muted`">
                                {{ pool.label }}
                            </span>
                            <span class="shrink-0 text-xs font-medium tabular-nums" :class="usageTone(pool.percent)" :style="meterTint(pool.percent)">
                                {{ formatRemaining(pool.percent, headroom.stale) }}
                            </span>
                        </div>
                        <!-- The fill is what is left; a spent pool tints its empty track, so it can't read as no reading at all. -->
                        <div class="h-1.5 overflow-hidden rounded-full" :class="meterTrack(pool.percent)">
                            <div
                                class="ui-meter-fill h-full rounded-full"
                                :class="usageTone(pool.percent)"
                                :style="{ width: `${meterFill(pool.percent)}%`, ...meterTint(pool.percent) }"
                            />
                        </div>
                        <span v-if="pool.resetsAt !== undefined" class="text-2xs text-subtle">{{
                            t(`common.usageRing.resets`, { resetsAt: formatReset(pool.resetsAt) })
                        }}</span>
                    </div>

                    <!-- Kept apart from the pools above: those are the plan's allowances, this is spend against them. -->
                    <div v-if="activity" class="mt-1 flex flex-col gap-1">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`shared.thisSandbox`) }}</span>
                        <span class="text-xs leading-relaxed text-muted">{{ activity }}</span>
                    </div>

                    <!-- Measured, with every pool since reset; distinct from unmeasured, which draws no meter at all. -->
                    <p v-if="headroom.pools.length === 0" class="text-xs text-muted">{{ t(`common.usageRing.everyPoolResetFull`) }}</p>

                    <!-- The ≤ mark is explained only when one is shown; a card of spent pools has none to explain. -->
                    <p v-if="headroom.stale && headroom.pools.some((pool) => pool.percent < 100)" class="text-2xs leading-relaxed text-subtle">
                        {{ t(`common.usageRing.atMostOtherDevices`) }}
                    </p>
                </div>
            </div>
        </Teleport>
    </span>
</template>
