<!-- THE INDEX-AND-BODY SCREEN — a title, a column of things to choose from, and the chosen one beside it. Five
     screens are this shape (settings, sandbox, memory, documentation, activity) and there were FOUR
     implementations of it: four rail widths (13/14/16/19rem), three gaps, three page treatments and four
     different answers to what happens on a phone. The one that had solved it properly, <HubLayout>, lived in
     the web app where no extension could import it — the same fault that had every extension hand-rolling a row
     before <Row> was exported.

     IT TAKES NO STYLE PROPS. Collapsing four shells into one component removed the duplication and left the
     DISAGREEMENT — every caller kept the treatment it happened to have, now spelled as `rail-width`, `framed`
     and `width`, and three adjacent screens still read as three designs. A shared component that is configurable
     in the places its callers disagree has not unified anything. So the rail is one width and never framed (see
     RAIL and <NavRail>), and there is one page cap (see PAGE_WIDTH). What is left to pass is what the screen IS,
     not how it should look.

     THE PAGE DOES NOT SCROLL; THE PANES DO. `h-full` + `overflow-hidden` leaves the outer router-view scroller
     nothing to take, so the rail and the body each keep their own scrollbar and their own place. Every one of
     the four copies carried a paragraph about the day it got this wrong, and they still did not all agree.

     MOBILE IS TWO ANSWERS, NOT FOUR, AND THE SPLIT IS ABOUT WHAT THE RAIL IS FOR:

      · `collapse` — the rail NARROWS the body (activity's sources, a hub's sections). There is nothing to go
        "into", so at phone width it folds into a control above the body and the body is always on screen. The
        caller supplies that control through #compact, because a hub wants a tab strip and a filter wants a
        picker, and those are genuinely different controls for genuinely different jobs.

      · `swap` — the rail SELECTS a document (a memory note, a package page). Going into one is the point, so
        the phone shows the list, then the document, with a way back. `detailOpen` says which, and #detail is
        responsible for offering the way back (it is the pane's own header that has room for it).

     Desktop is one layout for all five: one gap, one rail width, both panes bounded. -->
<script setup lang="ts">
import { computed } from "vue";
import Page from "./Page.vue";
import PageHeader from "./PageHeader.vue";
import { useDevice } from "../composables/useDevice.js";

const {
    mobile: mobileMode = `collapse`,
    detailOpen = false,
    scroll = `panes`,
} = defineProps<{
    title: string;
    description?: string;
    /** collapse: the rail narrows the body · swap: the rail selects a document. See the note above. */
    mobile?: `collapse` | `swap`;
    /** `swap` only — whether the phone is showing the document rather than the list. */
    detailOpen?: boolean;
    /* WHAT SCROLLS, and it is a real fork rather than a preference.
     *  · `panes` — the page is clamped and each pane scrolls itself. Right when the body is a DOCUMENT beside an
     *    index: you keep your place in both, and reaching row 50 does not scroll the document away.
     *  · `page` — the page scrolls and the rail sticks. Right when the body is a long FORM (a hub's settings
     *    section): clamping it would put a scrollbar inside a card inside a page, and the rail still has to stay
     *    reachable, which is what sticky buys. */
    scroll?: `panes` | `page`;
}>();

// Aliased: the `mobile` PROP is the strategy, this is whether we are on a phone. Same word, two meanings, and
// Vue collides them in the template if both are called `mobile`.
const { mobile: isPhone } = useDevice();

/* ONE WIDTH, not a scale. It was three named tiers, which was already better than the four ad-hoc numbers it
 * replaced — and still wrong: three adjacent screens with three different column widths read as three designs,
 * and no reader ever benefits from an index being 3rem narrower here than there. 16rem fits the longest thing
 * any of them actually shows (a `_libs/sandbox-contract` path); the rest truncate, which is what truncation is
 * for. */
const RAIL = `w-64`;

/* ONE PAGE CAP, AND IT IS NOT A PROP. It was one, and the callers set it three ways. Removing it, the first
 * attempt uncapped every pane-scrolling screen on the reasoning that the panes are the frame and each body
 * already clamps its own reading measure inside it. That fact is true and the conclusion was backwards: a 74ch
 * measure inside a 1280px pane wraps the text at the halfway mark and leaves the rest of the panel empty, which
 * reads as a bug rather than as a margin. A cap outside the frame is what keeps the two in step — at 72rem the
 * note fills ~80% of its pane instead of ~50%.
 *
 * The same number serves the scrolling hubs, where nothing is framed and nothing clamps itself and the cap is
 * the only thing between a settings form and a 2560px line of text. So it is one constant for all five screens,
 * not a fork and not a derivation. */
const PAGE_WIDTH = `wide`;

/* Three arrangements, and only three:
 *  · desktop        — rail beside detail, rail at its named width.
 *  · mobile collapse — rail ABOVE detail and full width, both on screen. A rail that narrows a feed has to stay
 *                     reachable while the feed is read. #compact overrides it for a rail whose phone form is a
 *                     different control entirely (a hub's tab strip); a rail that already swaps itself to a
 *                     Picker needs nothing and just lands here.
 *  · mobile swap    — exactly one of them, because the rail selects a document and going into one is the point. */
const railAside = computed(() => !isPhone.value);
const showRail = computed(() => !isPhone.value || mobileMode === `collapse` || !detailOpen);
const showDetail = computed(() => !isPhone.value || mobileMode === `collapse` || detailOpen);

/* Built here, not inline: a template literal nested inside another one inside an attribute is a parse the SFC
 * compiler gets wrong SILENTLY, taking every other binding in the file down with it. */
const railClass = computed(() => {
    if (!railAside.value) {
        return `shrink-0`;
    }
    // Sticky only in `page` mode: it is what keeps the index reachable once the body has scrolled past a screen.
    return scroll === `page` ? `sticky top-0 shrink-0 self-start ${RAIL}` : `shrink-0 ${RAIL}`;
});
</script>

<template>
    <div class="flex flex-col" :class="scroll === `panes` ? `h-full min-h-0 overflow-hidden` : ``">
        <!-- The head does not scroll: the title and anything pinned under it stay put while you read. -->
        <Page :width="PAGE_WIDTH" class="flex flex-col" :class="scroll === `panes` ? `min-h-0 flex-1` : ``">
            <PageHeader :title="title" :description="description">
                <template v-if="$slots[`info`]" #info><slot name="info" /></template>
                <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
            </PageHeader>

            <!-- Banners that belong to the whole screen rather than to either pane — an error, a live run, a
                 draft notice. Above the split so they are never inside the pane they are talking about. -->
            <div v-if="$slots[`strips`]" class="mb-4 flex shrink-0 flex-col gap-3"><slot name="strips" /></div>

            <div class="flex gap-4" :class="[railAside ? `flex-row` : `flex-col`, scroll === `panes` ? `min-h-0 flex-1` : `items-start`]">
                <!-- Beside the body on desktop; above it and full-width on a phone. -->
                <div v-if="showRail" class="flex flex-col" :class="[railClass, scroll === `panes` ? `min-h-0` : ``]">
                    <slot v-if="!railAside && $slots[`compact`]" name="compact" />
                    <slot v-else name="rail" />
                </div>
                <div v-if="showDetail" class="flex min-w-0 flex-1 flex-col" :class="scroll === `panes` ? `min-h-0` : ``"><slot name="detail" /></div>
            </div>
        </Page>
    </div>
</template>
