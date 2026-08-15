<script setup lang="ts">
import { placeAnchored, type Placement, ProgressRing, type Side } from "@intentic/ui";
import { computed, type CSSProperties, nextTick, onBeforeUnmount, ref } from "vue";
import { formatAge, formatReset, formatUtilization, type PlanHeadroom, usageDetail, usageTone } from "../composables/chat/usageStatus";

/* THE USAGE CIRCLE, WHEREVER IT IS DRAWN — the composer's headroom chip, the model picker's account rows, the
 * Agent tab's connection rows — together with the panel that opens beside it. One component, because those four
 * surfaces had four copies of the same three lines (a ring, a tone class, a spoken percentage) and one shared
 * mistake: the per-pool breakdown was crammed into a hover LABEL.
 *
 * WHY IT IS NOT A TOOLTIP. A tooltip is a strip of text naming a control (see lib/tooltip.ts, which
 * says so and is right for everything else). This is a small TABLE — three or four separate allowances, each
 * with a figure and a reset instant — and pouring it into one line produced the box this replaces: four wrapped
 * lines of "5-hour session 56% (resets Mon 12:30 AM) · Weekly · all models 15% (resets Sun 5:00 AM) · …",
 * unreadable at a glance and, being centred over its anchor, laid across the very rows the reader was
 * comparing. As a card each pool gets a line, a meter and its reset, and the tightest one is found by looking
 * rather than by parsing.
 *
 * IT OPENS BESIDE THE RING — on the flank the row asks for (see `flank`) — and only falls back to above/below
 * when neither flank can hold it (a narrow pop-out). Every surface that draws this ring is a COLUMN of rows —
 * accounts stacked in the picker, connection rows down the Agent tab — so the one placement that never covers
 * what the reader is comparing against is sideways, into the wide area next door.
 *
 * IN THE ANCHOR'S OWN WINDOW, like every other overlay here: the chat panel can be popped out into a real
 * `window.open` document while its JS stays in this realm, so the box is teleported into
 * `anchor.ownerDocument.body` and measured against that window (placeAnchored). It borrows AnchoredOverlay's
 * skin — the same surface, shadow and arrow the pickers use — so the app has one overlay language rather than
 * a bespoke box per feature.
 *
 * A POINTER-ONLY REVEAL, so the facts must also exist without one: the sentence a screen reader hears is
 * rendered as sr-only text beside the arc (usageDetail), and the exhaustive version — every account, every
 * pool, what has been spent — is the Usage tab, one click from the composer chip. */

const { headroom, flank = `right` } = defineProps<{
    headroom: PlanHeadroom;
    /* WHICH WAY THE CARD SPILLS — away from the row it belongs to, which only the row knows. A ring at the END
     * of its row (the picker's accounts, the composer's chip) spills right, into the app beside the panel; a
     * ring that IS the row's first element (the Agent tab's connection rows, where it stands in for the status
     * dot) spills left, into the page gutter, because everything to ITS right is the row's own name, state and
     * buttons. It flips to the other flank when this one has no room, and only then. */
    flank?: Side;
}>();

const GAP = 8; // px between the ring and the card — the arrow's height
const EDGE = 8; // px of the window kept clear on every side
// A pointer sweeping down a column of rings crosses several of them; opening on the first frame turns that into
// a strobe of cards. Short enough that a deliberate hover feels instant, long enough that a pass-by shows nothing.
const OPEN_DELAY_MS = 120;

const anchor = ref<HTMLElement>();
const box = ref<HTMLElement>();
const open = ref(false);
// Undefined until the card has been measured — and PARKED off-screen for exactly that long, since it has to be
// rendered before it can be measured and a card painted at the window's origin flashes there on every open.
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
    // Sideways whenever EITHER flank can hold the card; placeAnchored takes the asked-for one and flips only
    // when that helps. Above/below is the last resort a narrow pop-out forces, not the default a tooltip makes
    // of it — over and under is where the rows the reader is comparing are.
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

// A scroll or a resize moves the ring out from under a fixed box, and the pointer has left it anyway — so the
// card is dismissed rather than chased. Armed on the ANCHOR's document and window, which in a pop-out are not
// this realm's; remembered as the pair they were armed on, so the same pair is disarmed even if the panel has
// docked back in the meantime.
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
    await nextTick(); // the card exists — and has a size — only after this render
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
    <!-- The anchor is the ring PLUS whatever rides beside it (the composer chip's percentage), so hovering the
         chip's label opens the same card its arc does. -->
    <span ref="anchor" class="inline-flex items-center gap-1" @mouseenter="show" @mouseleave="hide" @pointerdown="hide">
        <ProgressRing :value="headroom.percent" :class="headroom.tone" />
        <slot />
        <!-- The arc is aria-hidden and a card that needs a pointer never reaches a screen reader, so the whole
             breakdown is spoken here instead. -->
        <span class="sr-only">{{ usageDetail(headroom) }}</span>

        <Teleport v-if="open && anchor !== undefined" :to="anchor.ownerDocument.body">
            <!-- aria-hidden: the sr-only line above already says all of this, and saying it twice is worse than
                 a card no screen reader can summon. pointer-events-none: never eat the hover that raised it. -->
            <div
                ref="box"
                class="ui-anchored pointer-events-none"
                :class="`ui-anchored-${placement?.side ?? flank}`"
                :style="style"
                aria-hidden="true"
            >
                <div class="ui-anchored-surface w-60 gap-3 px-3 py-2.5 text-left">
                    <!-- WHAT THESE NUMBERS ARE, and HOW OLD. The age belongs in the header rather than at the
                         bottom: every figure below is a floor once the reading has been overtaken elsewhere, so
                         it qualifies the whole card. -->
                    <div class="flex items-baseline justify-between gap-2 border-b border-line pb-2">
                        <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Plan limits</span>
                        <span class="shrink-0 text-2xs text-subtle">measured {{ formatAge(headroom.measuredAt) }}</span>
                    </div>

                    <!-- ONE LINE PER POOL, because "which allowance is about to bite" is the question the ring's
                         single number cannot answer — and the pools are genuinely separate: an account can sit
                         at 1% of its weekly Opus pool and 98% of its all-models one. The binding pool (the one
                         the ring draws) reads at full strength; the rest are context. -->
                    <div v-for="pool in headroom.pools" :key="pool.kind" class="flex flex-col gap-1">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="min-w-0 truncate text-xs" :class="pool === headroom.binding ? `font-medium text-content` : `text-muted`">
                                {{ pool.label }}
                            </span>
                            <span class="shrink-0 text-xs font-medium tabular-nums" :class="usageTone(pool.percent)">
                                {{ formatUtilization(pool.percent, headroom.stale) }}
                            </span>
                        </div>
                        <!-- A pool at 0% still draws a sliver: an empty track reads as "no reading", and those
                             mean opposite things. -->
                        <div class="h-1.5 overflow-hidden rounded-full bg-content/10">
                            <div
                                class="h-full rounded-full bg-current"
                                :class="usageTone(pool.percent)"
                                :style="{ width: `${Math.max(pool.percent, 1)}%` }"
                            />
                        </div>
                        <span v-if="pool.resetsAt !== undefined" class="text-2xs text-subtle">resets {{ formatReset(pool.resetsAt) }}</span>
                    </div>

                    <!-- Measured, and every pool has since reopened. Not the same as unmeasured, which draws no
                         ring at all. -->
                    <p v-if="headroom.pools.length === 0" class="text-xs text-muted">Every pool has reset — the full allowance is available.</p>

                    <!-- What the ≥ on each figure means, said only when there is one. -->
                    <p v-if="headroom.stale" class="border-t border-line pt-2 text-2xs leading-relaxed text-subtle">
                        ≥ these are floors — every device on the account spends the same pools.
                    </p>
                </div>
            </div>
        </Teleport>
    </span>
</template>
