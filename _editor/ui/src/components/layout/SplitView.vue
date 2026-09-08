<!--
    The index-and-body screen: a rail of choices beside the chosen one, folding to a single pane below its own measured width, not the window's
    (useNarrow). `collapse` folds the rail into a control above the body; `swap` folds it into a list that opens into the document, tracked by
    `detailOpen`.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import Page from "./Page.vue";
import PageHeader from "./PageHeader.vue";
import { useNarrow } from "../../composables/useNarrow.js";
import { useScrollReset } from "../../composables/useScrollReset.js";
import { provideCompact } from "./splitView.js";

const {
    mobile: mobileMode = `collapse`,
    detailOpen = false,
    scroll = `panes`,
    scrollKey = undefined,
} = defineProps<{
    title: string;
    description?: string;
    /** collapse: the rail narrows the body; swap: the rail selects a document, shown one pane at a time when folded. */
    mobile?: `collapse` | `swap`;
    /** `swap` only, whether a folded split is showing the document rather than the list. */
    detailOpen?: boolean;
    // What scrolls:
    // - `panes`: page is clamped, each pane scrolls itself; keeps your place in both (doc beside an index)
    // - `page`: the page scrolls and rail sticks; right for a long form, where clamping would nest a scrollbar
    scroll?: `panes` | `page`;
    // Identifies what's shown in `page` mode, so a subject change resets scroll instead of landing mid-page.
    scrollKey?: unknown;
}>();

// One width for all five screens, not a per-caller scale; 16rem fits the longest label, the rest truncate.
const RAIL = `w-64`;

// One page-width cap for all five screens: without it, a clamped body's reading measure leaves the pane empty.
const PAGE_WIDTH = `wide`;

// Below this width the body can't fit its rows beside the rail; measured on the split's row, not the page.
const FOLD_AT_REM = 44;
const row = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(row, FOLD_AT_REM);

// Resets scroll to top on a subject change, only in `page` mode; each pane resets itself in `panes` mode.
useScrollReset(row, () => (scroll === `page` ? scrollKey : undefined));

// Three arrangements, and only three:
// - unfolded: rail beside detail, at its named width
// - folded collapse: rail above detail, full width, both on screen (unless #compact overrides it)
// - folded swap: exactly one of them, since going into the document is the point
const railAside = computed(() => !narrow.value);
const showRail = computed(() => !narrow.value || mobileMode === `collapse` || !detailOpen);
const showDetail = computed(() => !narrow.value || mobileMode === `collapse` || detailOpen);

// What the rail is told, so a rail that has a compact form of its own changes at the same width the shell does.
provideCompact(narrow);

// Built here, not inline: a literal nested in another inside an attribute breaks the SFC parse silently.
const railClass = computed(() => {
    if (!railAside.value) {
        return `shrink-0`;
    }
    // Sticky only in `page` mode; `max-h-dvh` bounds `self-start`, which otherwise can grow past the viewport.
    return scroll === `page` ? `sticky top-0 max-h-dvh shrink-0 self-start ${RAIL}` : `shrink-0 ${RAIL}`;
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

            <!--
                Screen-wide banners (error, live run, draft), above the split so they're never inside the pane they
                describe.
            -->
            <div v-if="$slots[`strips`]" class="mb-4 flex shrink-0 flex-col gap-3"><slot name="strips" /></div>

            <!--
                Width of this element is what's divided between rail and body (see FOLD_AT_REM); `items-start` applies
                only unfolded, so a sticky rail doesn't stretch to the body's height.
            -->
            <div
                ref="row"
                class="flex gap-4"
                :class="[railAside ? `flex-row` : `flex-col`, scroll === `panes` ? `min-h-0 flex-1` : railAside ? `items-start` : ``]"
            >
                <!--
                    Beside the body with room, above and full-width otherwise; nothing to index means no rail column at
                    all.
                -->
                <div
                    v-if="showRail && ($slots[`rail`] !== undefined || $slots[`compact`] !== undefined)"
                    class="flex min-w-0 flex-col"
                    :class="[railClass, scroll === `panes` ? `min-h-0` : ``]"
                >
                    <slot v-if="!railAside && $slots[`compact`]" name="compact" />
                    <slot v-else name="rail" />
                </div>
                <!--
                    `compact` is passed as a slot prop too, since an inline caller body sits above this component's
                    injection and can't read it directly.
                -->
                <div v-if="showDetail" class="flex min-w-0 flex-1 flex-col" :class="scroll === `panes` ? `min-h-0` : ``">
                    <slot name="detail" :compact="narrow" />
                </div>
            </div>
        </Page>
    </div>
</template>
