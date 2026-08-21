<!-- ONE SESSION, AS A CARD IN A RAIL: the fleet board's AgentCard in a column one card wide, and the one
     component every rail in this app draws its rows with: the floating chat's open chats and its search
     hits (ChatTabList), the workflow runs above them, and the agents this sandbox's agents started
     (pages/Subagents.vue).

     ONE CARD, NOT A RESEMBLANCE. Those lists are read minutes apart by the same eye, so anything they drew
     differently read as two different products, and they did drift: the Subagents area had its own row, with
     its own status glyphs, its own facts in its own order and no card surface at all, so the agents an agent
     started looked like a different KIND of thing from the agents the user started. Everything below is the
     board's own vocabulary, and a caller picks which parts it has facts for rather than picking how they look.

     The rows, top to bottom:
       · the LEADING mark is the IDENTITY TILE (IdentityTile): the kind-of-work glyph on a tint of the
         session's CATEGORY hue, falling back to the provider mark. A row that is not a session (a workflow
         run) passes a plain `icon` instead.
       · the title is the card's one piece of CONTENT and takes the content tier (text-xs, semibold) over a
         card of text-2xs meta. A card set entirely in one size is a card with no first line to land on.
         Marked in place when the host is filtering (`needle`), never coloured: the status colour lives in the
         glyph beside it, and a column of orange titles is one where nothing stands out.
       · `trailing` is the slot beside the status glyph: the chat's × and its presence avatars.
       · the STATUS glyph closes the title row, in a fixed slot, at the board's size.
       · `meta` is the card's facts, one wrapping line at the board's own picks. Passed as a slot rather than
         as data because the chips in it are components (provenance marks, the coloured diff) and because
         which facts a card HAS is the caller's question. Conditional (`<template v-if=… #meta>`) on a card
         that can have nothing to say, so a fresh draft draws no empty strip.
       · the LIVE LINE, in link: what the turn is doing this second and how long it has been at it. The one
         accent that makes a working card findable in a column of stopped ones. `now` ticks from the host, so
         every card's elapsed advances together without a per-card timer.
       · the SNIPPET: why this card survived the filter, when the reason isn't its title. A result the user
         can't see the cause of is one they stop believing.

     Colour is spent the way the board spends it: the work's category in the tile, status in the glyph, the
     live readout in link, and everything else neutral, so an accent on screen always means something.

     THE SURFACE ITSELF IS NOT DRAWN HERE. Fill, border, hover, the selection ring and the attention bar are
     `.session-card` in styles.css, which the fleet board's own card wears too — the one place the two frames
     cannot drift apart, and the one place a skin restyles them both at once. -->
<script setup lang="ts">
import type { AgentProvider, MatchSnippet } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { type RouteLocationRaw, RouterLink } from "vue-router";
import { formatElapsed } from "../composables/agents/agentStatus";
import { markSegments } from "../composables/agents/markSegments";
import IdentityTile from "./IdentityTile.vue";
import MatchLine from "./MatchLine.vue";

const props = defineProps<{
    title: string;
    // The filter's term, folded the way the filter folded it, when the host has one: the title and the snippet
    // are marked with it, under the same `Aa` rule the search ran.
    needle?: string;
    matchCase?: boolean;
    provider?: AgentProvider;
    // The lead for a row that is NOT a session, and so has no identity to tile.
    icon?: IconName;
    // Ready to `v-bind` onto the Icon: the host derives it once (agentStatusMeta and its kin) rather than the
    // card asking for name, spin, class and label separately and recomputing the answer four times.
    status?: { name: IconName; spin?: boolean; class: string; "aria-label"?: string };
    live?: { icon: IconName; text: string; since?: number };
    now?: number;
    /* THE LIVE READOUT SHARES THE FACTS LINE INSTEAD OF TAKING ONE OF ITS OWN, for a list that has to stay
     * thin: the floating chat's rail, where the card's own line of facts is short (the model, and little
     * else) and a second row for "Bash · 12s" bought a third of a card's height per running chat. It TRAILS
     * that line, in the corner a settled card puts its age in, so the clock sits in one place whether or not
     * the turn has ended. Everywhere with room for it (the Subagents list) the readout keeps its own row. */
    tight?: boolean;
    /* A card whose chat has a COLUMN on screen: a ring and a lifted surface.
     *
     * ONE WEIGHT, however many columns there are. A split used to be drawn as a ranking: the focused chat wore
     * this, and the others a half-strength version of the same two channels. Nothing about a split makes one
     * column subordinate: the reader put two chats up to read them together, so the list was quietly
     * answering a question ("which is the real one?") that has no answer, and a second, muddier accent weight
     * was the whole cost of it. Every chat on screen is on screen. */
    selected?: boolean;
    // This session needs the user: a bar down the left edge. A CHANNEL OF ITS OWN so it stacks with
    // selection: drawing both as an outline meant opening the card that needed you erased the very cue that
    // put it in the lane.
    attention?: boolean;
    // A container of other rows rather than one of them (a workflow run), dashed like its card on the board.
    dashed?: boolean;
    // A destination rather than a session you are in (the rail's off-list search hits): the ink drops a step.
    quiet?: boolean;
    // WHY this row survived the filter: the line the query hit and who said it (MatchLine draws both).
    snippet?: MatchSnippet;
    /* WHERE THIS CARD GOES, for the lists whose rows are addresses rather than selections.
     *
     * Both kinds exist and they are genuinely different: a chat tab PICKS a conversation inside the panel you
     * are already looking at (no URL changes, nothing to open in a tab), while a subagent row is a page with
     * an address. Given `to` the card renders as a real link and everything a link brings comes with it: the
     * address in the status bar, the browser's own menu, Ctrl/⌘-click into a second tab: at not one pixel of
     * difference in how it looks. Without it the card stays the button it has always been. */
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
        <!-- A MARK BESIDE THE WHOLE CARD rather than inside its title row: the persona rail's rows are people,
             and a face is the thing you find them by, so it stands at the card's own height instead of sitting
             at the size of a status glyph. Only the rows that pass one are laid out this way; every other card
             keeps the column it has always been, which is why this is a slot's presence and not a prop. -->
        <slot name="aside" />
        <span class="flex min-w-0 flex-1 flex-col gap-1.5">
            <span class="flex w-full min-w-0 items-start gap-2">
                <!-- Sized to the title's first line so a two-line title hangs off the tile, not around it. -->
                <IdentityTile v-if="provider !== undefined" :title="title" :provider="provider" class="-mt-px h-4.5 w-4.5 text-2xs" />
                <span v-else-if="icon !== undefined" class="flex h-4 shrink-0 items-center">
                    <Icon :name="icon" class="text-2xs" :class="quiet ? 'text-subtle' : 'text-link'" />
                </span>
                <!-- Two lines before the clamp: a card has the width for most titles whole. -->
                <span class="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-4" :class="quiet ? 'text-muted' : 'text-content'">
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                </span>
                <slot name="trailing" />
                <span v-if="status !== undefined" class="flex h-4 shrink-0 items-center"><Icon v-bind="status" /></span>
            </span>

            <!-- Quiet by default: these are reference numbers, not events, so the only colour on the line is the
                 one that means something. -->
            <span
                v-if="$slots[`meta`] || (tight && live !== undefined)"
                class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted"
            >
                <slot name="meta" />
                <!-- The tight card's live readout, held to the END of its facts line: what the turn is doing
                     and how long it has been at it, in the one accent that makes a working card findable in a
                     column of stopped ones. Same three parts, same order, same colour as the full-height line
                     below. It sits in the corner the settled card's age sits in, which is the board card's
                     rule (AgentCard): the "when" of a card has ONE place on it, and a readout that led the
                     line put the clock at a different corner depending on whether the turn had ended. -->
                <span v-if="tight && live !== undefined" class="ml-auto flex min-w-0 items-center gap-1 font-medium text-link">
                    <Icon :name="live.icon" class="shrink-0 text-2xs" />
                    <span class="min-w-0 truncate">{{ live.text }}</span>
                    <span v-if="live.since !== undefined && now !== undefined" class="shrink-0 tabular-nums">{{
                        formatElapsed(live.since, now)
                    }}</span>
                </span>
            </span>

            <!-- Held through a stop's unwind by whoever passes it (turnInFlight, not `running`): the turn is
                 still live there, the elapsed keeps its meaning, and blinking the line off a beat before the
                 card settles is the same flicker the stopping state exists to remove. -->
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
