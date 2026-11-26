<!-- SplitView folds below its measured width. -->
<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import Page from "./Page.vue";
import PageHeader from "./PageHeader.vue";
import ViewBar from "./ViewBar.vue";
import { usePageBack } from "./pageBack.js";
import { ui } from "../../lib/ui.js";
import { useDevice } from "../../composables/useDevice.js";
import { useNarrow } from "../../composables/useNarrow.js";
import { useScrollReset } from "../../composables/useScrollReset.js";
import { useScrollportHeight } from "../../composables/useScrollportHeight.js";
import { provideCompact } from "./splitView.js";

const {
    mobile: mobileMode = `collapse`,
    detailOpen = false,
    scroll = `panes`,
    scrollKey = undefined,
    width = `wide`,
    description,
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
    // The body's width cap. `wide` suits a document beside an index; `full` is for a body that runs sideways (a
    // pipeline's stages), which spends the whole screen the way the agents board does.
    width?: `wide` | `full`;
}>();

const slots = useSlots();
// A phone has no window top bar to share: its pages keep PageHeader's large title, a padding below the top.
const { mobile: phone } = useDevice();
// The docked index's head draws its own way back, at a column's size rather than PageHeader's.
const back = usePageBack();

// One width for all screens, not a per-caller scale: 17rem fits a package path in the index's 13px mono (the
// documentation's `_sandbox/privacy-detect`) beside its mark; anything longer truncates.
const RAIL = `w-68`;

// Below this width the body can't fit its rows beside the rail. Measured on the split's own root, which spans the
// pane in every arrangement (a docked rail and a folded page alike), so folding cannot change the width that called
// for it: 45rem of rail and body, plus the page's gutters either side.
const FOLD_AT_REM = 48;
const root = ref<HTMLElement | undefined>(undefined);
const narrow = useNarrow(root, FOLD_AT_REM);

// Resets scroll to top on a subject change, only in `page` mode; each pane resets itself in `panes` mode.
useScrollReset(root, () => (scroll === `page` ? scrollKey : undefined));

// THE INDEX DOCKS TO THE SHELL'S OWN RAIL (2026-11-09). With room for both, the rail is a column on the pane's left
// edge, full height, with the screen's name at its head, and the body takes the rest at its own cap, starting where
// the rail ends. It used to sit inside the page's centred 80rem with the body, which on a wide screen put a
// third of the screen between the app's icon rail and the index it opens (the second level of the same navigation)
// and moved the index sideways whenever the pane changed width. Only the body has lines to read, so only it is capped.
// Without a rail there is nothing to dock: the page stays the centred one every screen without an index is.
const hasRail = computed(() => slots[`rail`] !== undefined || slots[`compact`] !== undefined);
const docked = computed(() => !narrow.value && slots[`rail`] !== undefined);

// Two folded arrangements, below the docked one:
// - folded collapse: rail above detail, full width, both on screen (unless #compact overrides it)
// - folded swap: exactly one of them, since going into the document is the point
const showRail = computed(() => narrow.value && hasRail.value && (mobileMode === `collapse` || !detailOpen));
const showDetail = computed(() => !narrow.value || mobileMode === `collapse` || detailOpen);

// What the rail is told, so a rail that has a compact form of its own changes at the same width the shell does.
provideCompact(narrow);

// A docked rail in `page` mode sticks to the top of the box the page scrolls in, and is exactly as tall as what shows
// of it, so its own rows scroll inside. Its edge runs the pane's full height by CSS alone (`min-h-full` on the root):
// a loading placeholder replays this tree's classes and inline styles, and a measured height baked into the root
// would replay one window's height into another's.
const scrollport = useScrollportHeight(root);
const viewport = computed(() => (docked.value && scroll === `page` && scrollport.value !== undefined ? `${scrollport.value}px` : undefined));

const hasDescription = computed(() => description !== undefined && description !== ``);
</script>

<template>
    <!-- The root spans the pane in every arrangement: it is what `narrow` measures. -->
    <div
        ref="root"
        class="flex min-w-0"
        :class="[docked ? `` : `flex-col`, scroll === `panes` ? `h-full min-h-0 overflow-hidden` : docked ? `min-h-full` : ``]"
    >
        <!-- DOCKED: the index on the pane's left edge, the body beside it, as the root's own row. -->
        <template v-if="docked">
            <!-- THE INDEX IS A COLUMN OF ITS OWN, docked to the shell's rail: the same surface and edge the rail stands on, so
                 rail and index read as one piece of navigation, the area and the page within it, and the body beside them
                 as the page. Full height (the column stretches the row) however short the body is; its contents stick to
                 the top of the scroll in `page` mode and scroll among themselves in either. -->
            <div class="flex shrink-0 flex-col border-r border-line bg-card" :class="[RAIL, scroll === `panes` ? `min-h-0` : ``]">
                <div
                    class="flex min-h-0 flex-col"
                    :class="scroll === `page` ? `sticky top-0 max-h-dvh` : `flex-1`"
                    :style="viewport === undefined ? undefined : { maxHeight: viewport }"
                >
                    <!-- The index's segment of the window's top bar, empty and blended (`.view-header-blend`, utilities.css): the
                         index's own ground runs up under it, with no line, and only its height ties it to the segments beside it. -->
                    <div class="view-header view-header-blend" aria-hidden="true"></div>
                    <!-- WHAT THIS INDEX IS ("Settings", "Account", "Capabilities"), under the bar rather than in it, at a column
                         heading's size: the body beside it carries its own headings, and a 2xl name in a 16rem column outweighed all
                         of them. One word where one will do. The body beside it has no segment of its own: its page starts at the
                         top (2026-11-23: in the bar, centred over the body or small over the index, the name read as chrome, and
                         the owner had it brought back here). Never whose it is: the shell's rail already wears the sandbox's face
                         and the overview its name, and a third copy of either was noise (2026-11-09). -->
                    <header class="flex min-h-9 shrink-0 items-center gap-3 pl-5 pr-4">
                        <button
                            v-if="back"
                            type="button"
                            :class="ui.iconButton({ size: `md` }, `-ml-1 -mr-1 shrink-0`)"
                            :aria-label="back.label"
                            @click="back.go()"
                        >
                            <Icon name="arrow-left" />
                        </button>
                        <h1 class="min-w-0 flex-1 truncate text-base leading-tight font-semibold">{{ title }}</h1>
                        <slot name="info" />
                    </header>
                    <div class="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-(--ui-page-padding) pl-4 pr-2 pt-3">
                        <slot name="rail" />
                    </div>
                </div>
            </div>
            <div class="flex min-w-0 flex-1 flex-col p-(--ui-page-padding)" :class="scroll === `panes` ? `min-h-0` : ``">
                <!-- 60rem, the body's width when it sat beside the rail in the 80rem page, so no screen's rows reflow; centred in
                     what the index leaves, so a wide pane keeps the body in its middle rather than against the index. -->
                <div
                    class="mx-auto flex w-full min-w-0 flex-col"
                    :class="[width === `full` ? `` : `max-w-240`, scroll === `panes` ? `min-h-0 flex-1` : ``]"
                >
                    <!-- What the title row carried besides the title: a sentence about what is shown, and its actions, over
                         the body they act on. -->
                    <header
                        v-if="hasDescription || $slots[`actions`]"
                        class="ui-page-header mb-4 flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2"
                    >
                        <p v-if="hasDescription" class="min-w-0 flex-auto text-sm text-muted">{{ description }}</p>
                        <div v-if="$slots[`actions`]" class="ml-auto flex max-w-full shrink-0 flex-wrap items-center justify-end gap-2">
                            <slot name="actions" />
                        </div>
                    </header>
                    <div v-if="$slots[`strips`]" class="mb-4 flex shrink-0 flex-col gap-3"><slot name="strips" /></div>
                    <slot name="detail" :compact="false" />
                </div>
            </div>
        </template>

        <!-- UNDOCKED (no index, or a pane too narrow for one beside the body): the screen's name and controls in the top bar
             over the page (ViewBar.vue), lined up with the page's column (Page's cap and gutters); on a phone, in
             PageHeader. NOT PINNED (2026-11-26, the owner's call on Pipelines and Maintenance): in `page` mode the bar is
             the page's own first row and scrolls away with it, so a long report gets the whole height; with panes the bar
             never moves anyway, since only the panes under it scroll. With panes, the page is the height its container
             leaves under the bar, and nothing past it: no column of its own to fill. -->
        <ViewBar
            v-if="!docked && !phone"
            :title="title"
            :align="width === `full` ? `px-(--ui-page-padding)` : `max-w-320 px-(--ui-page-padding)`"
        >
            <template v-if="$slots[`info`]" #info><slot name="info" /></template>
            <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
        </ViewBar>
        <Page v-if="!docked" :width="width" class="flex flex-col" :class="scroll === `panes` ? `min-h-0 flex-1 overflow-hidden` : ``">
            <PageHeader v-if="phone" :title="title" :description="description">
                <template v-if="$slots[`info`]" #info><slot name="info" /></template>
                <template v-if="$slots[`actions`]" #actions><slot name="actions" /></template>
            </PageHeader>
            <p v-else-if="hasDescription" class="mb-4 shrink-0 text-sm text-muted">{{ description }}</p>

            <!-- Screen-wide banners (error, live run, draft), above the split so they're never inside the pane they describe. -->
            <div v-if="$slots[`strips`]" class="mb-4 flex shrink-0 flex-col gap-3"><slot name="strips" /></div>

            <!-- Folded: the rail above the body, full width (`collapse`), or one of the two at a time (`swap`). -->
            <div class="flex flex-col gap-4" :class="scroll === `panes` ? `min-h-0 flex-1` : ``">
                <!-- Nothing to index means no rail at all; with room and a rail, the docked arrangement above draws it. -->
                <div v-if="showRail" class="flex min-w-0 shrink-0 flex-col" :class="scroll === `panes` ? `min-h-0` : ``">
                    <slot v-if="$slots[`compact`]" name="compact" />
                    <slot v-else name="rail" />
                </div>
                <!-- `compact` is passed as a slot prop too, since an inline caller body sits above this component's injection and can't read it directly. -->
                <div v-if="showDetail" class="flex min-w-0 flex-1 flex-col" :class="scroll === `panes` ? `min-h-0` : ``">
                    <slot name="detail" :compact="narrow" />
                </div>
            </div>
        </Page>
    </div>
</template>
