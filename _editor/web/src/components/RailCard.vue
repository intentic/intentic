<!-- ONE SESSION, AS A CARD IN A RAIL — the fleet board's AgentCard in a column one card wide, and the one
     component every rail in this app draws its rows with: the popped-out chat's open chats and its search
     hits (ChatTabList), the workflow runs above them, and the agents this sandbox's agents started
     (pages/Subagents.vue).

     ONE CARD, NOT A RESEMBLANCE. Those lists are read minutes apart by the same eye, so anything they drew
     differently read as two different products — and they did drift: the Subagents area had its own row, with
     its own status glyphs, its own facts in its own order and no card surface at all, so the agents an agent
     started looked like a different KIND of thing from the agents the user started. Everything below is the
     board's own vocabulary, and a caller picks which parts it has facts for rather than picking how they look.

     The rows, top to bottom:
       · the LEADING mark is the IDENTITY TILE (IdentityTile) — the kind-of-work glyph on a tint of the
         session's CATEGORY hue, falling back to the provider mark. A row that is not a session (a workflow
         run) passes a plain `icon` instead.
       · the title is the card's one piece of CONTENT and takes the content tier (text-xs, semibold) over a
         card of text-2xs meta. A card set entirely in one size is a card with no first line to land on.
         Marked in place when the host is filtering (`needle`), never coloured: the status colour lives in the
         glyph beside it, and a column of orange titles is one where nothing stands out.
       · `trailing` is the slot beside the status glyph — the chat's × and its presence avatars.
       · the STATUS glyph closes the title row, in a fixed slot, at the board's size.
       · `meta` is the card's facts, one wrapping line at the board's own picks. Passed as a slot rather than
         as data because the chips in it are components (provenance marks, the coloured diff) and because
         which facts a card HAS is the caller's question. Conditional (`<template v-if=… #meta>`) on a card
         that can have nothing to say, so a fresh draft draws no empty strip.
       · the LIVE LINE, in link — what the turn is doing this second and how long it has been at it. The one
         accent that makes a working card findable in a column of stopped ones. `now` ticks from the host, so
         every card's elapsed advances together without a per-card timer.
       · the SNIPPET — why this card survived the filter, when the reason isn't its title. A result the user
         can't see the cause of is one they stop believing.

     Colour is spent the way the board spends it: the work's category in the tile, status in the glyph, the
     live readout in link, and everything else neutral, so an accent on screen always means something. -->
<script setup lang="ts">
import type { AgentProvider, MatchSnippet } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { formatElapsed } from "../composables/agents/agentStatus";
import { markSegments } from "../composables/agents/markSegments";
import IdentityTile from "./IdentityTile.vue";
import MatchLine from "./MatchLine.vue";

const props = defineProps<{
    title: string;
    // The filter's term, folded the way the filter folded it, when the host has one — the title and the snippet
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
    /* A card whose chat has a COLUMN on screen — a ring and a lifted surface.
     *
     * ONE WEIGHT, however many columns there are. A split used to be drawn as a ranking: the focused chat wore
     * this, and the others a half-strength version of the same two channels. Nothing about a split makes one
     * column subordinate — the reader put two chats up to read them together — so the list was quietly
     * answering a question ("which is the real one?") that has no answer, and a second, muddier accent weight
     * was the whole cost of it. Every chat on screen is on screen. */
    selected?: boolean;
    // This session needs the user — a bar down the left edge. A CHANNEL OF ITS OWN so it stacks with
    // selection: drawing both as an outline meant opening the card that needed you erased the very cue that
    // put it in the lane.
    attention?: boolean;
    // A container of other rows rather than one of them (a workflow run), dashed like its card on the board.
    dashed?: boolean;
    // A destination rather than a session you are in (the rail's off-list search hits): the ink drops a step.
    quiet?: boolean;
    // WHY this row survived the filter: the line the query hit and who said it (MatchLine draws both).
    snippet?: MatchSnippet;
}>();

const titleRuns = computed(() => markSegments(props.title, props.needle ?? ``, props.matchCase === true));
</script>

<template>
    <button
        type="button"
        class="rail-card group flex w-full min-w-0 shrink-0 scroll-mt-8 flex-col gap-1.5 rounded-lg border p-2.5 text-left text-2xs"
        :class="{ 'rail-card-on': selected, 'rail-card-attention': attention, 'border-dashed': dashed }"
    >
        <span class="flex w-full min-w-0 items-start gap-2">
            <!-- Sized to the title's first line so a two-line title hangs off the tile, not around it. -->
            <IdentityTile v-if="provider !== undefined" :title="title" :provider="provider" class="-mt-px h-4.5 w-4.5 text-2xs" />
            <span v-else-if="icon !== undefined" class="flex h-4 shrink-0 items-center">
                <Icon :name="icon" class="text-2xs" :class="quiet ? 'text-subtle' : 'text-link'" />
            </span>
            <!-- Two lines before the clamp — a card has the width for most titles whole. -->
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
        <span v-if="$slots[`meta`]" class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
            <slot name="meta" />
        </span>

        <!-- Held through a stop's unwind by whoever passes it (turnInFlight, not `running`): the turn is still
             live there, the elapsed keeps its meaning, and blinking the line off a beat before the card settles
             is the same flicker the stopping state exists to remove. -->
        <span v-if="live !== undefined" class="flex w-full min-w-0 items-center gap-1.5 text-2xs font-medium text-link">
            <Icon :name="live.icon" class="shrink-0 text-2xs" />
            <span class="min-w-0 flex-1 truncate">{{ live.text }}</span>
            <span v-if="live.since !== undefined && now !== undefined" class="shrink-0">{{ formatElapsed(live.since, now) }}</span>
        </span>

        <span v-if="snippet !== undefined" class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted">
            <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
            <MatchLine :snippet="snippet" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
        </span>
    </button>
</template>

<style scoped>
/* The card's surface — AgentCard's skin: a visible border and an OPAQUE fill. A transparent pill blends into
 * a column of pills; a bordered card is what makes each session a countable thing.
 *
 * `--color-card` over the LANE's fill, exactly as the board's cards sit on their lanes: a card has to be
 * LIGHTER than what it lies on to read as an object rather than as an outline, and `.lane` is mixed to land
 * between canvas and card in both schemes precisely so this holds. The fill this replaced was a 45% wash of
 * the canvas colour, which in the pop-out — whose body IS canvas — composited to the ground it was drawn on,
 * leaving nothing but the 1px border.
 *
 * Border WIDTH is the utility's (so `border-dashed` can restyle it); the colour is here, where the states
 * below can move it.
 *
 * EVERY STATE IS A VARIABLE, not a property — border colour, fill, and the three shadows. Written as plain
 * properties, `.rail-card:hover` (a class AND a pseudo-class) outranked `.rail-card-on` (one class), so
 * putting the pointer on the SELECTED card repainted its accent border grey: the list erased the mark for
 * the chat it was pointing at, for as long as the cursor rested there. Through variables the states can be
 * ordered after hover and win the tie, and hover keeps a channel of its own on a card that already wears the
 * accent — the halo below, rather than a second opinion about the edge. */
.rail-card {
    color: var(--color-muted);
    cursor: pointer;
    border-color: var(--rail-border);
    background: var(--rail-fill);
    --rail-border: var(--color-line);
    --rail-fill: var(--color-card);
    /* Three independent marks on one box-shadow: the attention bar (left edge), the selection ring, and the
       halo that lifts a selected card off its lane. Held as variables because a second box-shadow rule would
       REPLACE the first, which is what once forced the first two into an either/or.
       All three keep their INSET-NESS across every state — `inset 0 0 #0000` rather than a bare `0 0 #0000`
       for the two inset slots — because box-shadow only interpolates between lists that agree on it, and a
       transition that cannot interpolate snaps. */
    --rail-accent: inset 0 0 #0000;
    --rail-ring: inset 0 0 #0000;
    --rail-lift: 0 0 #0000;
    box-shadow: var(--rail-accent), var(--rail-ring), var(--rail-lift);
    /* The shadows transition WITH the colours. They used not to, so selecting a card faded its border over
       150ms while the ring snapped in on the first frame — one gesture arriving as two. The curve is the
       app's standard one (Tailwind's `transition-*` default), so a card animates like every other control. */
    transition:
        color 150ms cubic-bezier(0.4, 0, 0.2, 1),
        background-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
        border-color 150ms cubic-bezier(0.4, 0, 0.2, 1),
        box-shadow 150ms cubic-bezier(0.4, 0, 0.2, 1);
}
.rail-card:hover {
    color: var(--color-content);
    --rail-border: var(--color-line-strong);
    --rail-fill: var(--color-overlay);
}
/* THE SELECTION RING IS INSET, and that is what keeps it whole. Drawn outwards it lay OUTSIDE the card's own
 * box, where two things ate it: the lane's pinned header, which is opaque and painted over the top of the
 * first card in every lane — the reported "the top border is cut" — and the 6px between cards, which a 2px
 * ring on each neighbour closed to 2. Inside the box nothing can clip it, it follows the card's radius
 * exactly, and the accent is one even weight the whole way round.
 *
 * The ring is a hairline against a border of the same colour, so the edge reads as a solid 2px of accent
 * rather than as the old 1px line under a 50%-opacity wash — a translucent ring picks up whatever it lies on,
 * which is why the edge looked soft on the lane and muddy between cards. */
.rail-card.rail-card-on {
    color: var(--color-content);
    --rail-border: var(--color-primary-500);
    --rail-fill: var(--color-overlay);
    --rail-ring: inset 0 0 0 1px var(--color-primary-500);
    /* Offset down and pulled in by its spread, so it is a shadow under the card rather than a glow around it:
       it reaches barely a pixel above the card, which is the one direction a pinned lane header can cover. */
    --rail-lift: 0 1px 3px -1px color-mix(in srgb, var(--color-primary-500) 28%, transparent);
}
/* Hover on a card that already wears the accent deepens the halo instead of recolouring the edge. Its fill is
   already the hover fill, so without this a selected card was the one row in the list that answered the
   pointer with nothing at all. */
.rail-card.rail-card-on:hover {
    --rail-lift: 0 1px 6px -1px color-mix(in srgb, var(--color-primary-500) 45%, transparent);
}
/* An inset shadow rather than a wider left border: no layout shift, so a lane's cards keep their text on one
   axis whether or not one of them needs the user. First in the list, so it paints OVER the selection ring —
   a card that is both selected and waiting on you must not lose the reason it is in the lane. */
.rail-card-attention {
    --rail-accent: inset 3px 0 0 0 var(--color-warning);
}
</style>
