<!--
    One session as a card, shared by every rail (fleet board, floating chat, Subagents) so they render identically. Row order is fixed — identity
    tile, title, trailing slot, status glyph, meta slot, live line, snippet — and a caller passes only the slots it has data for. Card chrome (fill,
    border, selection ring) is the shared `.session-card` class in styles.css.
-->
<script setup lang="ts">
import type { AgentProvider, MatchSnippet } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import { formatElapsed } from "../features/agents/fleet/agentStatus";
import { markSegments } from "../features/agents/review/markSegments";
import IdentityTile from "../features/capabilities/connect/IdentityTile.vue";
import MatchLine from "./MatchLine.vue";

const props = defineProps<{
    title: string;
    // Filter term (case-folded to match); title and snippet are marked using the same case rule as the search.
    needle?: string;
    matchCase?: boolean;
    provider?: AgentProvider;
    // Icon for a row that isn't a session and so has no identity tile.
    icon?: IconName;
    // Spread onto the Icon via v-bind; the host derives it once (agentStatusMeta) rather than field by field.
    status?: { name: IconName; spin?: boolean; class: string; "aria-label"?: string };
    live?: { icon: IconName; text: string; since?: number };
    now?: number;
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

const titleRuns = computed(() => markSegments(props.title, props.needle ?? ``, props.matchCase === true));
</script>

<template>
    <component
        :is="to === undefined ? `button` : RouterLink"
        :type="to === undefined ? `button` : undefined"
        :to="to"
        class="session-card group flex w-full min-w-0 shrink-0 scroll-mt-8 rounded-lg border p-3 text-left text-2xs"
        :class="[
            { 'session-card-on': selected, 'session-card-attention': attention, 'border-dashed': dashed },
            $slots[`aside`] ? `items-stretch gap-2.5` : `flex-col gap-1.5`,
        ]"
    >
        <!-- Aside slot for a mark beside the whole card; rows without it keep the default column layout. -->
        <slot name="aside" />
        <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="flex w-full min-w-0 items-start gap-2">
                <!--
                    Sized to the title's first line, so a two-line title hangs off the tile rather than wrapping around
                    it.
                -->
                <IdentityTile v-if="provider !== undefined" :title="title" :provider="provider" class="-mt-px h-4.5 w-4.5 text-2xs" />
                <span v-else-if="icon !== undefined" class="flex h-4 shrink-0 items-center">
                    <Icon :name="icon" class="text-2xs" :class="quiet ? 'text-subtle' : 'text-link'" />
                </span>
                <!-- Clamped to two lines; most titles fit whole at this width. -->
                <span
                    class="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-4"
                    :class="[quiet ? 'text-muted' : 'text-content', { italic: peek }]"
                >
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                    <!--
                        Italic is invisible to screen readers; stated in text since this element's role doesn't accept
                        aria-label.
                    -->
                    <span v-if="peek" class="sr-only">, temporary</span>
                </span>
                <slot name="trailing" />
                <span v-if="status !== undefined" class="flex h-4 shrink-0 items-center"><Icon v-bind="status" /></span>
            </span>

            <!-- Muted by default; these are reference numbers, not events, so colour here is reserved for what matters. -->
            <span
                v-if="$slots[`meta`] || (tight && live !== undefined)"
                class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted"
            >
                <slot name="meta" />
                <!--
                    Tight card's live readout, held at the end of the facts line; same corner a settled card's age
                    uses.
                -->
                <span v-if="tight && live !== undefined" class="ml-auto flex min-w-0 items-center gap-1 font-medium text-link">
                    <Icon :name="live.icon" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate">{{ live.text }}</span>
                    <span v-if="live.since !== undefined && now !== undefined" class="shrink-0 tabular-nums">{{
                        formatElapsed(live.since, now)
                    }}</span>
                </span>
            </span>

            <!-- Driven by turnInFlight, not `running`, so the live line doesn't flicker off during a stop's unwind. -->
            <span v-if="live !== undefined && tight !== true" class="flex w-full min-w-0 items-center gap-1.5 text-2xs font-medium text-link">
                <Icon :name="live.icon" class="shrink-0 text-2xs" />
                <span class="min-w-0 flex-1 truncate">{{ live.text }}</span>
                <span v-if="live.since !== undefined && now !== undefined" class="shrink-0">{{ formatElapsed(live.since, now) }}</span>
            </span>

            <span v-if="snippet !== undefined" class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="snippet" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </span>
        </span>
    </component>
</template>
