<script setup lang="ts">
import { placeAnchored, type Placement, ProgressRing, type Side } from "@intentic/ui";
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref } from "vue";
import { formatAge, formatReset, formatUtilization, type PlanHeadroom, usageDetail, usageTone } from "../features/chat/session/usageStatus";

// Usage ring and breakdown panel, shared by the composer chip, model picker and Agent tab rows. A small table
// (line and meter per pool), not a tooltip; opens beside the ring, never over the row column, falling back
// above only when neither flank fits. Teleported into the anchor's own window; sr-only text beside the arc
// repeats it for screen readers.

const { headroom, flank = `right` } = defineProps<{
    headroom: PlanHeadroom;
    // Own spend on this account, e.g. '14 turns · 2.1M/40k · $3.12'; reference, so it rides the card, not the row.
    activity?: string;
    // Which way the card spills, away from the rest of the row; flips flank only when its side lacks room.
    flank?: Side;
}>();

const GAP = 8; // px between the ring and the card: the arrow's height
const EDGE = 8; // px of the window kept clear on every side
// Long enough to skip a pass-by sweep across a column of rings, short enough a deliberate hover feels instant.
const OPEN_DELAY_MS = 120;

const anchor = ref<HTMLElement>();
const box = ref<HTMLElement>();
const open = ref(false);
// Undefined until measured; parked off-screen until then so it doesn't flash at the window's origin on open.
const placement = ref<Placement>();
let timer: ReturnType<typeof setTimeout> | undefined;

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
    clearTimeout(timer);
    if (armed !== undefined) {
        armed.doc.removeEventListener(`scroll`, hide, true);
        armed.view.removeEventListener(`resize`, hide);
        armed = undefined;
    }
    open.value = false;
    placement.value = undefined;
};

const reveal = async (): Promise<void> => {
    open.value = true;
    await nextTick(); // the card exists, and has a size: only after this render
    reposition();
    const doc = anchor.value?.ownerDocument;
    const view = doc?.defaultView;
    if (doc === undefined || view === null || view === undefined) {
        return;
    }
    doc.addEventListener(`scroll`, hide, true); // capture: it is the scrolling ANCESTOR that fires
    view.addEventListener(`resize`, hide);
    armed = { doc, view };
};

const show = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void reveal(), OPEN_DELAY_MS);
};

onBeforeUnmount(hide);
</script>

<template>
    <!-- The anchor includes whatever rides beside the ring (the chip's percentage), so hovering it opens the card. -->
    <span ref="anchor" class="inline-flex items-center gap-1" @mouseenter="show" @mouseleave="hide" @pointerdown="hide">
        <ProgressRing :value="headroom.percent" :class="headroom.tone" />
        <slot />
        <!-- The arc is aria-hidden and a pointer-only card never reaches a screen reader, so it's spoken here instead. -->
        <span class="sr-only">{{ activity ? `${usageDetail(headroom)} ${activity}.` : usageDetail(headroom) }}</span>

        <Teleport v-if="open && anchor !== undefined" :to="anchor.ownerDocument.body">
            <!--
                aria-hidden: the sr-only line already says this; pointer-events-none: never eat the hover that raised
                it.
            -->
            <div
                ref="box"
                class="ui-anchored pointer-events-none"
                :class="`ui-anchored-${placement?.side ?? flank}`"
                :style="style"
                aria-hidden="true"
            >
                <div class="ui-anchored-surface w-60 gap-3 px-3 py-2.5 text-left">
                    <!--
                        Age sits in the header, not the footer: every figure below is a floor once stale, qualifying
                        the whole card.
                    -->
                    <div class="flex items-baseline justify-between gap-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Plan limits</span>
                        <span class="shrink-0 text-2xs text-subtle">measured {{ formatAge(headroom.measuredAt) }}</span>
                    </div>

                    <!--
                        One line per pool: pools are independently gated, so which is about to bite can't come from one
                        number.
                    -->
                    <div v-for="pool in headroom.pools" :key="pool.kind" class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="min-w-0 truncate text-xs" :class="pool === headroom.binding ? `font-medium text-content` : `text-muted`">
                                {{ pool.label }}
                            </span>
                            <span class="shrink-0 text-xs font-medium tabular-nums" :class="usageTone(pool.percent)">
                                {{ formatUtilization(pool.percent, headroom.stale) }}
                            </span>
                        </div>
                        <!-- A pool at 0% still draws a sliver; an empty track would read as no reading at all. -->
                        <div class="h-1.5 overflow-hidden rounded-full bg-content/10">
                            <div
                                class="ui-meter-fill h-full rounded-full"
                                :class="usageTone(pool.percent)"
                                :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                            />
                        </div>
                        <span v-if="pool.resetsAt !== undefined" class="text-2xs text-subtle">resets {{ formatReset(pool.resetsAt) }}</span>
                    </div>

                    <!-- Kept apart from the pools above: those are the plan's allowances, this is spend against them. -->
                    <div v-if="activity" class="mt-1 flex flex-col gap-1">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">This sandbox</span>
                        <span class="text-xs leading-relaxed text-muted">{{ activity }}</span>
                    </div>

                    <!-- Measured, with every pool since reset; distinct from unmeasured, which draws no ring at all. -->
                    <p v-if="headroom.pools.length === 0" class="text-xs text-muted">Every pool has reset: the full allowance is available.</p>

                    <!-- The ≥ mark is explained only when one is shown; a card of hard 100s has none to explain. -->
                    <p v-if="headroom.stale && headroom.pools.some((pool) => pool.percent < 100)" class="text-2xs leading-relaxed text-subtle">
                        ≥ these are floors: every device on the account spends the same pools.
                    </p>
                </div>
            </div>
        </Teleport>
    </span>
</template>
