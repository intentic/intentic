<!-- Shared session-card shell for every rail. -->
<script setup lang="ts">
import type { AgentProvider, MatchSnippet } from "@intentic/sandbox-contract";
import { formatElapsed, type IconName, ProgressRing, SegmentRing, timeAgo, type Tip } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import type { StandingChip, TileRim } from "../../agents/fleet/agentStatus";
import { sandboxNow } from "../../agents/fleet/sandboxClock";
import { markSegments } from "../../../lib/markSegments";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";
import MatchLine from "../../../components/MatchLine.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{
    title: string;
    // Filter term (case-folded to match); title and snippet are marked using the same case rule as the search.
    needle?: string;
    matchCase?: boolean;
    provider?: AgentProvider;
    // The session's stored work word (AgentSummary.titleAction), which tints the identity tile; rows without one
    // (personas) let the tile read the title.
    titleAction?: string;
    // Icon for a row that isn't a session and so has no identity tile.
    icon?: IconName;
    // Spread onto the Icon via v-bind; the host derives it once (agentStatusMeta) rather than field by field.
    status?: { name: IconName; spin?: boolean; class: string; "aria-label"?: string };
    // Why this row needs the reader, or that it has news: the corner's word, decided by agentStatus.standingChip so a
    // rail row and its board card say and tint the same thing. Takes the seat `status` would otherwise hold.
    chip?: StandingChip;
    // What the identity mark's rim draws: checklist ticks or a context arc, decided once by agentStatus.tileRim so
    // this card and the board's cannot disagree. Undefined for a row with nothing measured (and for every row that
    // isn't a session), which wears the empty rim instead.
    rim?: TileRim;
    live?: { icon: IconName; text: string; since?: number };
    // When true, the live readout trails the facts line instead of taking its own row, for narrow rails.
    tight?: boolean;
    // True when this card's chat is open in a column: ring and lifted surface, same weight for every open column.
    selected?: boolean;
    // True when the session needs the user: left-edge bar, kept separate from selection so both can show at once.
    attention?: boolean;
    // True for a container of rows (a workflow run) rather than a row itself; matches its board card's dashed border.
    dashed?: boolean;
    // For a destination rather than an open session (e.g. off-list search hits): drops the ink a step.
    quiet?: boolean;
    // True while a card is only being previewed (Conversation.peek); italic, matching FileTabs' preview tabs.
    peek?: boolean;
    // Why this row matched the filter: the hit line and its speaker (rendered by MatchLine).
    snippet?: MatchSnippet;
    // When set, renders as a RouterLink instead of a button, for rows that are addresses, not selections.
    to?: RouteLocationRaw;
}>();

// The card reads the shared clock itself, armed only while it draws an elapsed readout, so a settled rail ticks
// nothing and a running one redraws one card rather than the list around it.
// On the sandbox's clock, which stamped `since` (sandboxClock.ts): a browser clock running fast drew a fresh turn as minutes old.
const tick = useNow(() => props.live?.since !== undefined);
const now = computed(() => sandboxNow(tick.value));

const titleRuns = computed(() => markSegments(props.title, props.needle ?? ``, props.matchCase === true));
// Only the "Updated" chip earns a hover: "New" already says unopened, while this hides when you last looked.
const chipHint = computed((): Tip | undefined =>
    props.chip?.seenAt === undefined
        ? undefined
        : { title: props.chip.label, rows: [{ label: t(`common.railCard.lastOpened`), value: timeAgo(props.chip.seenAt, { days: true }) }] },
);
</script>

<template>
    <component
        :is="to === undefined ? `button` : RouterLink"
        :type="to === undefined ? `button` : undefined"
        :to="to"
        class="session-card group flex w-full min-w-0 shrink-0 scroll-mt-8 rounded-2xl border p-3 text-left text-2xs"
        :class="[
            { 'session-card-on': selected, 'session-card-attention': attention, 'border-dashed': dashed },
            $slots[`aside`] ? `items-stretch gap-2.5` : `flex-col gap-1.5`,
        ]"
    >
        <!-- Aside slot for a mark beside the whole card; rows without it keep the default column layout. -->
        <slot name="aside" />
        <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="flex w-full min-w-0 items-start gap-2">
                <!-- THE MARK, on the board's construction at the rail's scale (AgentCard argues the proportion at length): a disc inside a rim. -->
                <span
                    v-if="provider !== undefined || icon !== undefined"
                    class="relative -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                    :class="rim === undefined ? 'ring-(length:--ring-track) ring-inset ring-content/12' : ''"
                >
                    <SegmentRing
                        v-if="rim?.kind === `steps`"
                        :segments="rim.segments"
                        :filled="rim.filled"
                        :size="24"
                        :stroke="1.5"
                        class="absolute inset-0"
                        :class="rim.tone"
                    />
                    <ProgressRing
                        v-else-if="rim?.kind === `context`"
                        :value="rim.percent"
                        :size="24"
                        :stroke="1.5"
                        class="absolute inset-0"
                        :class="rim.tone"
                    />
                    <IdentityTile
                        v-if="provider !== undefined"
                        :title="title"
                        :action="titleAction"
                        :provider="provider"
                        class="h-4.5 w-4.5 text-2xs"
                    />
                    <!-- A row that is not a session (a workflow run, a search hit) wears its glyph on the same disc. -->
                    <span v-else class="flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full bg-primary-600/15">
                        <Icon :name="icon!" class="text-2xs" :class="quiet ? 'text-subtle' : 'text-link'" />
                    </span>
                </span>
                <!-- Clamped to two lines; most titles fit whole at this width. -->
                <span
                    class="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-4"
                    :class="[quiet ? 'text-muted' : 'text-content', { italic: peek }]"
                >
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                    <!-- Italic is invisible to screen readers; stated in text since this element's role doesn't accept aria-label. -->
                    <span v-if="peek" class="sr-only">{{ t(`common.railCard.temporary`) }}</span>
                </span>
                <slot name="trailing" />
                <!-- THE CORNER SAYS IT IN WORDS WHEN THERE ARE WORDS, exactly as the board's card does: a glyph in this seat can say
     "something ended" but never "Usage limit", and the two surfaces drawing the same standing differently was the
     whole complaint. The resting glyph gets the seat back the moment there is nothing to say. -->
                <span v-if="chip !== undefined" v-tooltip.top="chipHint" class="ui-status-pill shrink-0 text-2xs font-semibold" :class="chip.tone">{{
                    chip.label
                }}</span>
                <!-- Fixed-height box so a row's title never shifts between a spinning glyph and a resting one. -->
                <span v-else-if="status !== undefined" class="flex h-4 shrink-0 items-center">
                    <Icon v-bind="status" />
                </span>
            </span>

            <!-- Muted by default; these are reference numbers, not events, so colour here is reserved for what matters. -->
            <span
                v-if="$slots[`meta`] || (tight && live !== undefined)"
                class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted"
            >
                <slot name="meta" />
                <!-- Tight card's live readout, held at the end of the facts line; same corner a settled card's age uses. Takes the line's leftover width with its words in a size container, so a long command truncates (whole in the hover) instead of wrapping the readout onto a row of its own. -->
                <span v-if="tight && live !== undefined" class="flex min-w-max flex-[1_1_0] items-center justify-end gap-1 font-medium text-link">
                    <span v-tooltip.top="live.text" class="@container min-w-4 flex-1 truncate text-right"
                        ><Icon :name="live.icon" class="mr-1 inline-block align-[-0.1em] text-2xs" /><span class="hidden @[4.5rem]:inline">{{
                            live.text
                        }}</span></span
                    >
                    <span v-if="live.since !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed((now - live.since) / 1000) }}</span>
                </span>
            </span>

            <!-- Driven by turnInFlight, not `running`, so the live line doesn't flicker off during a stop's unwind. -->
            <span v-if="live !== undefined && tight !== true" class="flex w-full min-w-0 items-center gap-1.5 text-2xs font-medium text-link">
                <Icon :name="live.icon" class="shrink-0 text-2xs" />
                <span class="min-w-0 flex-1 truncate">{{ live.text }}</span>
                <span v-if="live.since !== undefined" class="shrink-0">{{ formatElapsed((now - live.since) / 1000) }}</span>
            </span>

            <span v-if="snippet !== undefined" class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="snippet" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </span>
        </span>
    </component>
</template>
