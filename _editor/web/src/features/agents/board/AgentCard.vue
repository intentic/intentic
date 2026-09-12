<script setup lang="ts">
import { Button, ProgressRing, ui, useDevice } from "@intentic/ui";
import { errorMessage, useNow } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { requestLandAgent } from "../fleet/agentActions";
import { refreshAcross } from "../../sandbox/live/fleetAcross";
import { useRole } from "../../sandbox/secrets/useRole";
import OriginMark from "../../../components/OriginMark.vue";
import StartedByMark from "./StartedByMark.vue";
import UnsentMark from "../../../components/UnsentMark.vue";
import StatusGlyph from "../fleet/StatusGlyph.vue";
import WorkflowMark from "../../../components/WorkflowMark.vue";
import { dropActionFor, type PendingAction } from "./laneDrop";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    attentionReason,
    contextPct,
    formatCost,
    formatElapsed,
    landedAway,
    laneOf,
    limitClosed,
    limitCountdown,
    limited,
    loopMeta,
    reviewAction,
    turnInFlight,
    unreadBadge,
    unregistered,
    watching,
    watchLine,
} from "../fleet/agentStatus";
import { type MatchSnippet, providerLabel } from "@intentic/sandbox-contract";
import { sessionCategory } from "../../../app/sessionCategory";
import IdentityTile from "../../capabilities/connect/IdentityTile.vue";
import MatchLine from "../../../components/MatchLine.vue";
import SessionChip from "./SessionChip.vue";
import { boxImageOf, boxNameOf } from "../fleet/fleetScope";
import { accountBadge } from "./accountChip";
import { providerAccounts } from "../../chat/accounts/providerAccounts";
import { createInlineRename } from "../../../lib/inlineRename";
import { markSegments } from "../review/markSegments";
import { useAgents } from "../fleet/useAgents";
import { canArchive, type FleetAgent } from "../fleet/useAgents-fleet";
import { relativeTime } from "../../chat/models/catalog";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";

// One fleet agent: identity tile + title + status chip, a model/session line, and a closing summary line (stats,
// drill-in, and either the running elapsed or the settled date).
// Each card reads the shared useNow clock itself so its own elapsed advances without rerendering the board; root is a
// div-button (not <button>) so the nested rename input stays valid HTML.
// `dense` is the same card as a row, for stacked lanes: identical DOM and facts, just wrapped onto one line instead of
// stacked, so a lane fits more cards.

const props = defineProps<{
    agent: FleetAgent;
    dense?: boolean;
    dragging?: boolean;
    // Action the board has in flight, if any; only that button reports progress, the rest just dims.
    pending?: PendingAction;
    // This agent's chat is on screen, one weight regardless of how many columns share it.
    selected?: boolean;
    // Chat is open only as a temporary look (Conversation.peek); italic title, with a keep press to make it stick.
    peek?: boolean;
    // Evidence for why the board's filter matched; absent when the hit was the title, marked there instead.
    match?: MatchSnippet;
    query?: string;
    // Filter's case-sensitivity switch, so marks are struck under the rule search actually used.
    matchCase?: boolean;
}>();
// Ticks only while needed (turn, watch, limit countdown); settled cards share the clock without re-ticking.
const now = useNow(() => turnInFlight(props.agent) || watching(props.agent) || limitClosed(props.agent));
const emit = defineEmits<{
    // The click that opened it, if any; a modified click asks for a pane instead of focus.
    open: [event?: MouseEvent];
    review: [];
    resolve: [];
    land: [];
    // Separate from `land`: relands the whole output, not just the remainder, and must never fire by accident.
    reland: [];
    // Disarms every outside condition this conversation is parked on.
    unwatch: [];
    archive: [];
    restore: [];
    close: [];
    // Keeps a chat open that this card's click only opened as a look (see `peek`).
    keep: [];
    grab: [event: PointerEvent, card: HTMLElement];
}>();

const { mobile } = useDevice();
const meta = computed(() => agentStatusMeta(props.agent.status));
// Identity tile's category, undefined for an unreadable title; read here too since the tooltip is this card's.
const category = computed(() => sessionCategory(props.agent.title));
const lane = computed(() => laneOf(props.agent));
// Sandbox chip contents, or nothing when this is the box the app is already pointed at.
// Read live from the roster rather than passed in, since the owner can rename or re-image a sandbox at any time.
const box = computed(() =>
    props.agent.sandboxId === undefined
        ? undefined
        : { name: boxNameOf.value.get(props.agent.sandboxId) ?? `Another sandbox`, image: boxImageOf.value.get(props.agent.sandboxId) },
);
const reason = computed(() => attentionReason(props.agent));
// Muted only for a spent allowance (needs a person, but nothing is wrong); amber for every other attention reason.
// An ink tint, not a surface token: a surface token collides with the selected card's lifted fill and, in the light
// scheme, with the card fill itself.
const reasonTone = computed(() => (limited(props.agent) ? `bg-content/10 text-muted` : `bg-warning/15 text-warning`));
// Shared with agentStatus.activityLine so the rail and board never narrate the same turn differently.
const activityText = computed(() => activityLine(props.agent));
// Archive appears wherever it means something (not just the Finished lane, see canArchive), including in Attention,
// since nothing is lost by it.
// It sits beside the rename pencil, reachable by touch and keyboard, rather than behind the drag gesture which only
// exists mid-drag.
// Archive and rename are this sandbox's only: a card from another box has no entry in the active daemon's roster to
// write to.
// Land, discard, and stop differ: those address the agent by id through the daemon directly, so they cross sandboxes
// intact.
const localOnly = computed(() => props.agent.sandboxId === undefined);
const archivable = computed(() => localOnly.value && canArchive(props.agent));
// The only exit for a card with no daemon entry (a draft, a refused send, an unfiled turn): archive, discard, land, and
// drop are all unavailable to it.
// Without this, a broken send would sit unrecoverable in the Active lane, surviving reloads with the tab.
const closable = computed(() => unregistered(props.agent.status));
// What closing actually destroys differs: a `starting` turn keeps running daemon-side (only this window's view of it
// closes).
// A draft holding unsent text is the one case where closing does lose something, so the hint has to name it.
const closeHint = computed(() =>
    props.agent.status === `starting`
        ? `Close: the turn keeps running, and its own card appears once the sandbox has filed it`
        : props.agent.unsent
          ? `Close: this never started, and the unsent message goes with it`
          : `Close, this never started, so there is no branch or transcript to keep`,
);
// Drill-in label, undefined for a draft (nothing to review); desktop only, since a mobile tap navigates there.
const review = computed(() => (mobile.value ? undefined : reviewAction(props.agent)));

// Asks laneDrop the same question the drag already answers, so a second reading can't disagree with it on the same
// card.
// Excludes archived cards: pressing this would quietly un-archive the agent (the daemon's registry.begin) as a side
// effect.
const resolvable = computed(() => props.agent.archivedAt === undefined && dropActionFor(props.agent, `finished`) === `resolve`);
// Work this agent landed that's no longer in the tree; excluded in the archive, like every other press here (restore
// first).
// Takes the Ready button's slot: Land now would leave the discarded half missing (the hardest wrong to notice), so Land
// again replaces it when both apply.
const away = computed(() => (props.agent.archivedAt === undefined ? landedAway(props.agent) : undefined));
// The Ready card's press, offered because auto-land is off; same wording and mechanics as the review panel's own
// button.
// Excluded in the archive, like `resolvable`: restore first.
const landable = computed(() => props.agent.archivedAt === undefined && props.agent.status === `ready` && away.value === undefined);
// A RECEIPT: a finished card that asks nothing of anyone. It keeps every fact it had and spends none of the board's
// colour on them — the success green, the diff's red/green, the context tint all flatten to the row's own ink.
// Finished is the only lane that fills by itself, so on an ordinary board it is forty painted rows beside two lanes
// holding three cards each, and the eye went to the ledger because the ledger was the only column with colour in it.
// NOT every finished card qualifies, which is the whole point of asking rather than keying off the lane: `ready`
// still offers Land now, and landed-then-discarded work still says so in warning ink. Those are presses, not
// receipts, and a press that reads as quietly as a receipt is a press nobody makes.
// In the ARCHIVE that exception lapses: every press is withheld there until the card is restored (see `landable`,
// `away`, `resolvable`), so a `ready` card filed away has nothing to shout about and reads as the receipt it is.
const receipt = computed(
    () => lane.value === `finished` && (props.agent.archivedAt !== undefined || (props.agent.status !== `ready` && away.value === undefined)),
);
// Statuses whose ink is already quiet (`idle`, `resumed`, `stopped`) keep it: flattening those to `muted` would make
// a receipt LOUDER than it is today, which is the opposite of the errand.
const QUIET_INK: ReadonlySet<string> = new Set([`text-subtle`, `text-muted`]);
const statusMeta = computed(() => (receipt.value && !QUIET_INK.has(meta.value.class) ? { ...meta.value, class: `text-muted` } : meta.value));
// The two lanes about work in flight get the bigger card: a step up in title size and padding, so which lane a card
// is in is legible from its weight and not only from which column it landed in.
// Hierarchy through the CARD rather than through the column: widening Attention and Active instead would have bought
// nothing on an ordinary board, where those two lanes are near-empty and the widened columns are mostly air, and it
// would have taken the width out of the one lane whose rows are already tightest.
// Never in `dense` (the stacked, narrow board): there the lanes are stacked, so their order already says which is
// which, and the extra padding costs a card per screen where cards per screen is the scarce thing.
const live = computed(() => props.dense !== true && lane.value !== `finished`);
// True only while this card's own land is pending; `pending` names the action so archiving doesn't leave Land spinning
// too.
const landing = computed(() => props.pending === `land`);
// Maintainers get Land now; collaborators get Request land instead, since the daemon floors landing at maintainer;
// viewers get neither.
// The request is sent here rather than emitted, since the board is only one of this card's several hosts.
const { canDrive, canShip } = useRole();
const { refresh: refreshAgents, notice: agentsNotice, rename } = useAgents();
const requesting = ref(false);
const requestLand = async (): Promise<void> => {
    if (requesting.value) {
        return;
    }
    requesting.value = true;
    try {
        await requestLandAgent(props.agent.id, props.agent.sandboxId);
        await (props.agent.sandboxId === undefined ? refreshAgents() : Promise.resolve(refreshAcross()));
    } catch (caught) {
        agentsNotice.value = errorMessage(caught, `Couldn't send the land request.`);
    } finally {
        requesting.value = false;
    }
};
// The standing ask, worn for everyone: a collaborator sees it took, a maintainer reads it as the cue to land.
const landAsk = computed(() => {
    const request = props.agent.landRequested;
    return request === undefined ? undefined : `${request.name ?? request.email} asked to land this`;
});
// Its own flag, not a wider `landing`: each button must name back only the action actually pressed.
const relanding = computed(() => props.pending === `reland`);
const handingOver = computed(() => props.pending === `resolve`);
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
// Gated on exactly what it renders, no more and no less: gating on a subset hides what should show (subagents
// mid-turn), a superset opens an empty strip.
// The diff clause matches the diff chip's own condition, not merely `diff exists`, since renames alone render nothing.
// Context is deliberately absent: it moved to the identity tile's ring (see `tileHint`), so a card whose only stat was
// its context now opens no summary row at all.
const stats = computed(
    () =>
        props.agent.costUsd !== undefined ||
        (props.agent.diff !== undefined && (props.agent.diff.insertions > 0 || props.agent.diff.deletions > 0)) ||
        props.agent.subagents !== undefined,
);
// THE IDENTITY TILE IS ALSO THE FUEL GAUGE. The kind-of-work glyph was doing one job, telling cards apart, and it
// did it in the strongest position a card has — leading, where the eye lands first — while the one number that
// predicts what a session is about to do sat as a 14px ring in the summary row, last, among four other stats.
// So the ring moved around the tile: how much of the model's context window this session has spent. It is the stat
// that changes what to do next (an agent at 90% is one turn from compacting and starting to forget, which is when
// you split the work rather than send another message), and unlike cost it has a denominator, so it can be a ring at
// all. Cost stays a number, because "$3.26 of what?" has no answer to draw an arc against.
// Amber past 80%, the band where compaction is close; accent while the work is live; plain ink on a receipt, where
// the number is history rather than a warning.
const ringTone = computed(() => {
    if (receipt.value) {
        return `text-subtle`;
    }
    return (context.value ?? 0) >= 80 ? `text-warning` : `text-primary-500`;
});
// One hover for a tile that now carries two facts, since two nested tooltips would raise two boxes over the same
// 28 pixels. Either half can be missing: a title the category reading declines still has a context ring, and a fresh
// agent has a category and no context yet.
const tileHint = computed(() => {
    const parts = [category.value?.type, context.value === undefined ? undefined : `${context.value}% of context used`].filter(
        (part): part is string => part !== undefined,
    );
    return parts.length === 0 ? undefined : parts.join(` · `);
});
// Only a card with a daemon registry entry may claim "Completed": client-only standings have no such account of a turn.
// A history-reopened chat sits in this lane too but says nothing here, since its own chip already states what it is.
const completed = computed(() => lane.value === `finished` && !unregistered(props.agent.status));
// Whether the card can show a date at all: an untouched draft can't, and neither can a running turn, whose own elapsed
// readout takes the same slot.
const dated = computed(() => props.agent.archivedAt !== undefined || (!turnInFlight(props.agent) && props.agent.updatedAt > 0));
// Whether the closing line has anything to show: gated on everything it draws, so a card with nothing here opens no
// empty strip.
// One wrapping line (stats left, standing/time right) rather than two rows, so a lane fits more cards.
const summary = computed(() => stats.value || review.value !== undefined || completed.value || dated.value || turnInFlight(props.agent));
const loopLine = computed(() => (props.agent.loop === undefined ? undefined : loopMeta(props.agent.loop)));
// Recomputed against the ticking `now`, like the elapsed beside it, so the countdown moves without its own timer.
// Suppressed while a turn is in flight: the running corner already answers "doing what, for how long", and reclaims it
// the moment the turn ends.
const watch = computed(() => (turnInFlight(props.agent) ? undefined : watchLine(props.agent, now.value)));
// Shares the card's "when" corner with the running elapsed and the watch countdown; the chip already says what
// happened, this says when.
// Undefined once the window is open or the provider gave no instant; the corner then falls back to the ordinary date.
const limitBackAt = computed(() => limitCountdown(props.agent, now.value));
// Re-runs the exact held turn (useAgents.resumeHeldTurn), not a new message; a local flag, since `pending` names drop
// actions and this is neither.
// Cleared in `finally`, not only on success, since a roster frame is about to replace the card either way.
const resending = ref(false);
const sendAgain = async (): Promise<void> => {
    if (resending.value) {
        return;
    }
    resending.value = true;
    try {
        await useAgents().resumeHeldTurn(props.agent.id);
    } catch {
        // Left as-is: the commonest failure is a hold the daemon lost, and the words are still safe in the composer.
    } finally {
        resending.value = false;
    }
};
// Says which provider runs it exactly once: while the tile wears the provider mark this needs no floor.
// Once the category glyph replaces that mark, a card with no recorded model would otherwise never say the provider at
// all.
const model = computed(() => {
    if (props.agent.model !== undefined) {
        return modelLabelFor(props.agent.provider, props.agent.model);
    }
    return category.value === undefined ? undefined : providerLabel(props.agent.provider);
});
// Which login actually served this turn (from the turn's own session frame), not the composer's current pick, which may
// differ after a mid-chat switch.
// The summary carries only a UUID; read against the window's account list, so an unresolvable id (disconnected login)
// draws nothing.
const account = computed(() => accountBadge(providerAccounts.value[props.agent.provider] ?? [], props.agent.account));
// Fallback name for a card with no title yet (a new tab, an untitled history entry, naming not yet landed).
// Prefers the composer's own preview text over a generic placeholder, since a title is only minted by the first turn.
const displayTitle = computed(() => {
    if (props.agent.title !== undefined) {
        return props.agent.title;
    }
    if (props.agent.preview !== undefined) {
        return props.agent.preview;
    }
    if (props.agent.status === `draft`) {
        return `New agent`;
    }
    return props.agent.status === `resumed` ? `Untitled chat` : `Untitled agent`;
});
// Marks the filter term in the title; the matched line (via MatchLine, which also names the speaker) is never shown
// apart from it.
// Term is case-folded to match the filter's own rule, unless `Aa` (matchCase) is on.
const needle = computed(() => (props.matchCase === true ? (props.query ?? ``) : (props.query?.toLowerCase() ?? ``)));
const titleRuns = computed(() => markSegments(displayTitle.value, needle.value, props.matchCase === true));
// Shared with the rail's cards (agentStatus.unreadBadge).
// "New" already says unopened; "Updated" hides when you last looked, so only that one earns a hover hint.
const unread = computed(() => {
    const badge = unreadBadge(props.agent);
    if (badge === undefined) {
        return undefined;
    }
    return { label: badge.label, hint: badge.seenAt === undefined ? undefined : `Worked since you last opened it, ${relativeTime(badge.seenAt)}` };
});

const edit = createInlineRename(
    () => props.agent.title,
    (name) => rename(props.agent.id, name),
    `Couldn't rename the agent.`,
);
// A blur-commit click on the card body must commit the rename, not also open the agent.
// The event rides along since a modified click means something else on this board (a chat pane/column); a keyboard open
// carries none.
const openCard = (event?: MouseEvent): void => {
    if (edit.editing || edit.consumeSuppressedOpen()) {
        return;
    }
    emit(`open`, event);
};

// Never a side effect of a plain click: the drill-in fires this; a double-click on the body is its accelerator.
const reviewCard = (): void => {
    if (edit.editing || review.value === undefined) {
        return;
    }
    emit(`review`);
};

// One shared class for the header's icon affordances (rename, archive, etc), differing only by glyph and opacity rule.
// Ink stays 20px, but `touch-target` widens the hit area to 44 on a coarse pointer, so four icons still fit a narrow
// row on a phone.
// Hover fill is an ink tint, not `bg-overlay`: these glyphs sit ON the card.
// A surface-named fill would vanish on a selected card (whose own fill is that overlay) and in the light scheme, where
// overlay equals card.
const HOVER_ACTION = `touch-target flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-content/10 hover:text-content`;

// Starts the drag only when the press begins on the card body; the rename pencil and its input run their own pointer
// gestures.
const grab = (event: PointerEvent): void => {
    // Primary button only: a right-press opens the card's menu, and dragging should not also start under it.
    if (event.button !== 0) {
        return;
    }
    if (edit.editing || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`input, button`) !== null) {
        return;
    }
    // A modified press picks this card into a chat pane instead of dragging it, so the two gestures don't both fire.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
    }
    emit(`grab`, event, event.currentTarget);
};
</script>

<template>
    <div
        role="button"
        tabindex="0"
        :aria-label="`Focus agent: ${displayTitle}`"
        class="session-card group flex w-full select-none flex-col rounded-xl border text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            /* A LIVE CARD IS A BIGGER CARD (see `live`): the two lanes about work in flight get 16px of padding and
               a 14px title, the ledger keeps 14 and 12. This is the hierarchy signal, in place of widening the two
               live columns — the fact being told is that this one is happening, and a card is where that belongs.
               No double quotes in here: the whole array is one double-quoted attribute, and one closes it. */
            live ? 'gap-2.5 p-4' : 'gap-2 p-3.5',
            /* TWO STATES, TWO CHANNELS, AND NEITHER IS DRAWN HERE. `selected` (this card's chat is on screen)
               and the Attention lane are unrelated facts, told apart by WHERE they are drawn: selection is a
               ring around the whole card plus a lifted surface, attention is a bar down the left edge. Both,
               with the fill, the border and the hover, are `.session-card` in styles.css — the same surface
               the chat rail's row wears, because a board card and a rail row are one card in two frames and
               every time this skin was written twice the two drifted.

               THE BAR STACKS WITH SELECTION rather than standing down under it. The ring is an INSET hairline
               now, so the bar paints over it instead of doubling an outward edge beside it — which is what
               once forced the either/or — and opening the card that needs you no longer erases the reason it
               is in the lane. */
            lane === 'attention' ? 'session-card-attention' : '',
            selected ? 'session-card-on' : '',
            dragging ? 'opacity-40' : '',
            pending !== undefined ? 'pointer-events-none opacity-60' : '',
        ]"
        @pointerdown="grab"
        @click="openCard"
        @dblclick="reviewCard"
        @keydown.enter.self.prevent="openCard()"
        @keydown.space.self.prevent="openCard()"
    >
        <div class="flex items-center gap-2.5">
            <!--
                Kind-of-work glyph tinted by the title's category (sessionCategory: audit=blue magnifier,
                redesign=purple arrows, new=green plus, fix=red wrench), ringed by how much of the model's context
                window this session has spent (see `ringTone`).
                Tooltip is the legend for both; an unreadable title falls back to the provider mark on neutral chrome.

                The box is a fixed 28px whether or not a ring is drawn in it, so a lane of cards keeps its titles on
                one axis rather than shifting left on every card the daemon hasn't reported context for yet.
                TWO CONCENTRIC CIRCLES, which is the whole reason IdentityTile is round: the square this replaced had
                a gap running from 4px at the flats to under 1px at the corners, so the arc read as a flourish beside
                the tile instead of its rim.

                THE THREE NUMBERS ARE A PROPORTION, not three independent choices, and getting them wrong is what a
                correct centre calculation cannot save you from — measured dead concentric, the first attempt still
                looked wrong. A ring's own geometry: its outer edge is always at `size / 2` and its inner edge at
                `size / 2 - stroke`. So 28/1.5 puts the inner edge at 12.5, and a 22px disc (radius 11) sits 1.5px
                inside it.
                It replaced 28/2 around a 20px disc, which measured perfectly and read as a heavy donut with a small
                glyph adrift in it: the stroke was a tenth of the disc it circled, and the disc only 71% of the ring,
                so the eye read the ring as the object and the icon as filler. At 79% with a hairline the disc is the
                object and the ring is its rim, which is the thing being drawn.
                `stroke` is passed here rather than changed in ProgressRing: five other surfaces (UsageRing,
                ApplyProgress, ChatPaneStatus, the design kit) draw that component at its own weight and none of them
                is circling an icon.

                A CARD WITH NO CONTEXT WEARS THE EMPTY TRACK, and this is the other half of "the sizes look off": a
                bare 22px disc beside a ringed 28px one reads as two sizes of mark in one lane, even though both
                discs are identical. So the rim is always drawn and only the ARC is conditional. The inset ring
                reproduces ProgressRing's own track exactly — same 1.5px band with its outer edge at 14 — which is
                why the two can stand in for each other without a seam.
                Same size in every lane: lane weight is carried by the padding and the title, which have room for it.
            -->
            <span
                v-tooltip.top="tileHint"
                class="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
                :class="context === undefined ? 'ring-(length:--ring-track) ring-inset ring-content/12' : ''"
            >
                <ProgressRing v-if="context !== undefined" :value="context" :size="28" :stroke="1.5" class="absolute inset-0" :class="ringTone" />
                <IdentityTile :title="agent.title" :provider="agent.provider" class="h-5.5 w-5.5 text-xs" />
            </span>
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="ui-field-box ui-field-inline min-w-0 flex-1 select-text px-1 font-semibold"
                :class="live ? 'text-sm' : 'text-xs'"
                @click.stop
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <!--
                    A LIVE CARD'S TITLE WRAPS, a receipt's clips. The step up to 14px costs about four characters
                    against the same column, and beside a wide standing chip (`Question for you`, `Land conflict`)
                    that was the difference between reading the title and reading `Refactor the a…`. A live lane
                    holds a handful of cards and can spend the second line; Finished holds six and cannot, so it
                    keeps one clipped line, which is also what makes the two lanes scan differently at a glance.

                    `break-words` IS WHAT MAKES THE CLAMP TERMINATE, and it is not decoration. A clamp only draws
                    its ellipsis when the text overruns VERTICALLY; a title with one unbreakable run in it (a
                    branch, a path, a URL, anything a rename can put here) overruns sideways instead, so the box
                    cut it mid-glyph with no ellipsis and left the second line empty. `truncate` never had the
                    problem because nowrap plus text-overflow answers it in one. Breaking the long word puts the
                    overrun back on the axis the clamp reads.
                -->
                <span
                    class="min-w-0 flex-1 font-semibold text-content"
                    :class="[live ? 'line-clamp-2 break-words text-sm leading-snug' : 'truncate text-xs', peek ? 'italic' : '']"
                >
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                    <!--
                        Italic is invisible to a screen reader, so the peek state rides along as text, not an
                        aria-label with no role.
                    -->
                    <span v-if="peek" class="sr-only">, temporary</span>
                </span>
                <!--
                    Keeps a peeked chat open; leads the affordance row since it's the one press with a deadline (the
                    tab closes on the next click elsewhere).
                -->
                <button
                    v-if="peek"
                    type="button"
                    aria-label="Keep this chat open"
                    v-tooltip.top="'Keep open, otherwise this chat closes when you open another'"
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="emit(`keep`)"
                >
                    <Icon name="pin" class="text-2xs" />
                </button>
                <button
                    v-if="localOnly"
                    type="button"
                    aria-label="Rename agent"
                    v-tooltip.top="'Rename'"
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="edit.begin()"
                >
                    <Icon name="pencil" class="text-2xs" />
                </button>
                <button
                    v-if="archivable"
                    type="button"
                    aria-label="Archive agent"
                    v-tooltip.top="
                        agent.branch === undefined ? 'Archive, the conversation is kept' : 'Archive, the branch, diff and conversation are kept'
                    "
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="emit(`archive`)"
                >
                    <Icon name="box" class="text-2xs" />
                </button>
                <button
                    v-if="closable"
                    type="button"
                    aria-label="Close agent"
                    v-tooltip.top="closeHint"
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="emit(`close`)"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
                <button
                    v-if="agent.archivedAt !== undefined"
                    type="button"
                    aria-label="Restore agent"
                    v-tooltip.top="'Put this agent back on the board'"
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="emit(`restore`)"
                >
                    <Icon name="undo" class="text-2xs" />
                </button>
                <!--
                    An icon, not a spelled-out link, so it costs no space at rest; the words move to the tooltip.
                    Exception: a card that needs the user keeps the label spelled out on the summary line, where it's
                    always visible.
                -->
                <button
                    v-if="review !== undefined && lane !== 'attention'"
                    type="button"
                    :aria-label="review"
                    v-tooltip.top="review"
                    :class="[HOVER_ACTION, mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100']"
                    @click.stop="reviewCard"
                >
                    <Icon name="arrow-right" class="text-2xs" />
                </button>
            </template>
            <Icon v-if="pending !== undefined" name="spinner" spin class="shrink-0 text-xs text-link" />
            <span v-else-if="reason !== undefined" class="ui-status-pill shrink-0 text-2xs font-semibold" :class="reasonTone">{{
                reason
            }}</span>
            <span
                v-else-if="unread !== undefined"
                v-tooltip.top="unread.hint"
                class="ui-status-pill shrink-0 bg-primary-600/15 text-2xs font-semibold text-link"
                >{{ unread.label }}</span
            >
            <!--
                The resting standing for a card with no reason or unread mark; carries meta.label as a word in its
                hover, not just a glyph, and the one thing a resting status can't say alone: that the turn which
                settled it stopped short (a dot on the glyph, the sentence in the hover). The daemon sends
                `unfinished` only for a card at rest, so no status check is needed here.
                Deliberately not chip-styled like the exceptions above: a board of forty "Idle" pills would spend its
                whole attention budget on nothing, and an "Unfinished" pill per stopped-short card was the same spend.
            -->
            <StatusGlyph v-else :meta="statusMeta" :unfinished="agent.unfinished" :now="now" class="text-xs" />
        </div>
        <p v-if="edit.error !== undefined" class="text-2xs text-danger">{{ edit.error }}</p>

        <!--
            Card body, column or row depending on `dense`: column stacks one block per row; row wraps the same blocks
            along one line, each shrinking or wrapping on its own as the board narrows.
        -->
        <div :class="dense ? 'flex flex-wrap items-center gap-x-3.5 gap-y-1.5' : 'flex flex-col gap-2'">
            <!--
                Why this card matched the filter; leads the body while a filter is active. Skipped when the hit was the
                title, marked in place above instead.
                Two lines before clamping, so the snippet isn't cut mid-phrase.
            -->
            <p v-if="match !== undefined" class="flex min-w-0 items-start gap-2 text-2xs text-muted" :class="dense ? 'w-full' : ''">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="match" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </p>

            <!--
                `failure` is present only while the card reads as failed, so no extra status check is needed here.
                Leads above provenance and the model line: on a failed card, nothing else here is what the reader came
                for.
            -->
            <p v-if="agent.failure && !limited(agent)" class="flex min-w-0 items-start gap-2 text-2xs text-danger" v-tooltip.top="agent.failure">
                <Icon name="exclamation-circle" class="mt-px shrink-0 text-2xs" />
                <span class="line-clamp-2 min-w-0 flex-1 leading-4">{{ agent.failure }}</span>
            </p>

            <!--
                Provenance, ahead of the model/branch line: for an agent the user didn't start, who asked for it
                outranks what it runs on.
                All three render nothing for a user-started agent.
            -->
            <OriginMark :origin="agent.origin" />
            <StartedByMark :started-by="agent.startedBy" />
            <WorkflowMark :workflow="agent.workflow" />

            <!--
                WRAPS, which is what lets the unsent mark ride this line instead of taking one of its own. Unsent
                used to lead the body as a row of its own, and on the cards that actually carry it — a chat you
                typed into and left — the two rows below the title were a lone chip and a lone model name, both
                mostly empty. Here it costs a row only on a card whose line is genuinely full (sandbox, model,
                runner, branch and account all present), and nothing on the rest.
                It still LEADS this line: the reader's own unfinished business comes before what the agent is
                running on. The provenance marks above it render nothing for a user-started agent, which is nearly
                every card that has an unsent message in it.
            -->
            <div
                v-if="agent.unsent || box !== undefined || model !== undefined || agent.branch !== undefined || account !== undefined"
                class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle"
            >
                <!-- Shape, wording and hover live in UnsentMark, shared with the rail row. -->
                <UnsentMark v-if="agent.unsent" :preview="agent.preview" :at="agent.draftAt" :now="now" />
                <!--
                    Which sandbox this agent is in, shown only when it isn't the reader's own; leads the line since it
                    changes what every other number means.
                    Same ink-tint wash as the reason chip, and for the same reason: it must survive the selected card's
                    lifted fill and the light scheme.
                -->
                <span
                    v-if="box !== undefined"
                    class="flex min-w-0 shrink-0 items-center gap-1 truncate rounded bg-content/10 px-2.5 py-1 text-muted"
                    v-tooltip.top="`In ${box.name}, not in the sandbox you're in`"
                >
                    <img v-if="box.image !== undefined" :src="box.image" alt="" class="h-3 w-3 shrink-0 rounded-sm object-cover" />
                    <Icon v-else name="server" class="shrink-0 text-2xs" />
                    <span class="truncate">{{ box.name }}</span>
                </span>
                <span v-if="model !== undefined" class="truncate">{{ model }}</span>
                <!--
                    Where it's running, shown only when that's somewhere other than here: the fleet spreads work across
                    machines without a per-agent choice.
                -->
                <span v-if="agent.runner !== undefined" class="flex shrink-0 items-center gap-1 truncate" :title="`Runs on ${agent.runner}`">
                    <Icon name="desktop" class="text-2xs" />
                    {{ agent.runner }}
                </span>
                <!--
                    Abbreviated on the card, full string on hover; a label, not a control (copy is on the right-click
                    menu).
                -->
                <!-- Clipped on the card, full identity on hover; nothing renders if the sandbox can't name the account. -->
                <span v-if="agent.branch !== undefined" class="inline-flex min-w-0 items-center gap-1.5">
                    <span v-if="model !== undefined">·</span>
                    <SessionChip :branch="agent.branch" />
                </span>
                <span v-if="account !== undefined" class="inline-flex min-w-0 shrink items-center gap-1">
                    <span v-if="model !== undefined || agent.branch !== undefined">·</span>
                    <span v-tooltip.top="account.hint" class="inline-flex min-w-0 shrink items-center gap-1">
                        <Icon name="user" class="shrink-0 text-2xs" />
                        <span class="truncate">{{ account.label }}</span>
                    </span>
                </span>
            </div>

            <!--
                Never replaces the live readout below: this says what the loop is working toward, that says what it's
                doing right now.
                Survives the loop ending, since how it stopped is what the card gets read for afterward.
            -->
            <p v-if="agent.loop !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs" :class="loopLine?.class">
                <Icon name="repeat" :spin="loopLine?.spin" class="shrink-0 text-2xs" />
                <span class="truncate">{{ loopLine?.text }}</span>
            </p>

            <!--
                The one board state that's a decision, not a report: the agent redoes the merge in its own worktree, so
                a wrong answer costs nothing.
                A real button, not a hover link, so touch and keyboard reach it; the mechanics are prose under it
                rather than a tooltip, so they're readable without a pointer.
            -->
            <div v-if="resolvable" class="flex min-w-0 flex-col gap-1">
                <Button size="small" class="self-start whitespace-nowrap" @click.stop="emit('resolve')">
                    <Icon :name="handingOver ? 'spinner' : 'sparkles'" :spin="handingOver" />{{
                        handingOver ? "Handing it over…" : "Have the agent resolve it"
                    }}
                </Button>
                <span class="text-2xs leading-snug text-subtle"
                    >It merges in its own worktree: nothing reaches your workspace unless it succeeds.</span
                >
            </div>

            <!--
                One row (fact left, press right), not a stack: this is a fact the card owes the reader regardless of
                action, unlike the decision blocks above.
                The press is deliberately quiet (muted secondary, not the success-filled "Land now"): discarding is
                often a rejection, and a bright button would argue with it.
            -->
            <div v-if="away !== undefined" class="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
                <span v-tooltip.top="away.title" class="inline-flex shrink-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon :name="away.icon" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0"
                        >{{ away.text
                        }}<template v-if="away.hint !== undefined">
                            <span class="text-subtle"> ({{ away.hint }})</span></template
                        ></span
                    >
                </span>
                <!--
                    No resting glyph: the line above it already leads with this exact icon, and a repeat would read as
                    a stutter.
                -->
                <Button size="small" severity="secondary" :text="true" class="shrink-0 whitespace-nowrap" @click.stop="emit('reland')">
                    <Icon v-if="relanding" name="spinner" spin class="text-2xs" />{{ relanding ? "Landing…" : "Land again" }}
                </Button>
            </div>

            <!--
                Success-styled with the check glyph, matching the review panel's own Land now: the same action on the
                same work must read as such.
                Carries no explanatory prose, unlike the resolve/request-land blocks: this button's mechanics are
                routine to a user who already opted into auto-land-off.
            -->
            <div v-if="landable && canShip" class="flex min-w-0 flex-col gap-1">
                <!-- The standing ask leads the button it's about, so a maintainer meets the reason before the press. -->
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
                </p>
                <Button size="small" severity="success" class="self-start whitespace-nowrap" @click.stop="emit('land')">
                    <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" />{{ landing ? "Landing…" : "Land now" }}
                </Button>
            </div>

            <!--
                The same Ready card for a collaborator: land is a maintainer's press, so this offers the ask instead,
                same spot and size but quieter chrome.
                Once asked, the card says so and stands down; a viewer gets neither.
            -->
            <div v-else-if="landable && canDrive" class="flex min-w-0 flex-col gap-1">
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}: waiting for a maintainer</span>
                </p>
                <template v-else>
                    <Button size="small" severity="secondary" class="self-start whitespace-nowrap" @click.stop="requestLand">
                        <Icon :name="requesting ? 'spinner' : 'send'" :spin="requesting" />{{ requesting ? "Asking…" : "Request land" }}
                    </Button>
                    <span class="text-2xs leading-snug text-subtle">Landing needs a maintainer: this puts the ask on their board.</span>
                </template>
            </div>

            <!--
                The closing summary line: counted stats, then the drill-in and time held to the line's right (see
                `summary`).
            -->
            <div
                v-if="summary"
                class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-2xs text-muted"
                :class="dense ? 'min-w-32 flex-1' : ''"
            >
                <!--
                    No hover labels: a stat you can't name from its icon doesn't belong in this row.
                    Tokens, file counts and turn counts were dropped from this line since a scanned board only needs
                    stats that change what to do next; each still lives where it's actually read (Usage tab, Changes
                    panel, chat rail).
                -->

                <!--
                    Red and green only while the diff is a live signal. On a receipt the pair keeps its signs, its
                    monospace and its numbers and drops to the row's own ink: a lane of them was two saturated
                    numbers per row, repeated six times, saying nothing that the `+` and `−` don't already say.
                -->
                <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                    <span :class="receipt ? '' : 'text-success'">+{{ agent.diff.insertions }}</span>
                    <span :class="receipt ? '' : 'text-danger'"> −{{ agent.diff.deletions }}</span>
                </span>
                <!--
                    Lifetime cost total, read-only here.
                    The Usage tab breaks it down; a route change inside this chip row would cost more misfires than the
                    shortcut saves.
                -->
                <span v-if="agent.costUsd !== undefined">{{ formatCost(agent.costUsd) }}</span>
                <!--
                    Counts this agent's own children, live-of-total while any are running and settling to the lifetime
                    total once none are.
                    A nested link to the Subagents area narrowed to just this agent's children, not the whole
                    sandbox's.
                -->
                <!--
                    A real link (underlines on hover, tints live), so Ctrl/Cmd-click opens the list in its own tab.
                    `.stop` only keeps the card underneath from also opening.
                -->
                <RouterLink
                    v-if="agent.subagents !== undefined"
                    :to="{ name: `subagents`, query: { agent: agent.id } }"
                    class="touch-target cursor-pointer transition-colors hover:text-content hover:underline"
                    :class="{ 'text-link': agent.subagents.running > 0 }"
                    v-tooltip.top="
                        agent.subagents.running > 0 ? `${agent.subagents.running} of ${agent.subagents.total} still working` : 'Agents it started'
                    "
                    @click.stop
                >
                    <Icon name="users" class="mr-0.5 text-2xs" />{{
                        agent.subagents.running > 0 ? `${agent.subagents.running} / ${agent.subagents.total}` : agent.subagents.total
                    }}
                </RouterLink>

                <!--
                    Standing and clock pinned right by margin, not a spacer, so wrapping doesn't strand them on an
                    empty line.
                -->
                <span class="ml-auto inline-flex min-w-0 items-center gap-2 text-subtle">
                    <!--
                        Spelled out only for the one card that's earned the width: an agent waiting on the user, whose
                        label is itself the instruction (Answer, Approve spend...).
                        Every other card carries this same press as the header's arrow, at no extra height.
                    -->
                    <!--
                        For a stranded turn, the instruction is the action, not a trip to one: the daemon still holds
                        the exact turn to resend, so the slot is the press itself.
                        Offered even before the reset window reopens, since the provider's estimate runs early and a
                        premature press likely still succeeds; absent once the daemon drops the hold (a restart).
                    -->
                    <button
                        v-if="limited(agent) && agent.limitHeld === true"
                        type="button"
                        :class="ui.linkButton('inline-flex shrink-0 gap-1 font-medium')"
                        :disabled="resending"
                        v-tooltip.top="'Send this turn again. It is the same request as before, not a new message.'"
                        @click.stop="sendAgain"
                    >
                        {{ resending ? "Sending…" : "Send again" }}<Icon name="arrow-right" class="text-2xs" />
                    </button>
                    <button
                        v-else-if="review !== undefined && lane === 'attention'"
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded font-medium text-link hover:underline"
                        @click.stop="reviewCard"
                    >
                        {{ review }}<Icon name="arrow-right" class="text-2xs" />
                    </button>
                    <span v-else-if="review === undefined && completed" class="inline-flex shrink-0 items-center gap-1">
                        <Icon name="check" class="text-2xs" />Completed
                    </span>
                    <!--
                        Archived card dates itself by when it left the board, the same "when" slot a running card's
                        elapsed uses.
                    -->
                    <span v-if="agent.archivedAt !== undefined" class="shrink-0"> Archived {{ relativeTime(agent.archivedAt) }} </span>
                    <!--
                        Takes the date's slot: "back at X" tells the reader something to plan around, unlike "last
                        active".
                    -->
                    <span
                        v-else-if="limitBackAt !== undefined"
                        class="inline-flex shrink-0 items-center gap-1"
                        v-tooltip.top="agent.failure ?? 'The provider refused this turn: its usage limit is spent.'"
                    >
                        <Icon name="clock" class="shrink-0 text-2xs" />
                        <span class="tabular-nums">back {{ limitBackAt }}</span>
                    </span>
                    <span v-else-if="watch === undefined && !turnInFlight(agent) && agent.updatedAt > 0" class="shrink-0">{{
                        relativeTime(agent.updatedAt)
                    }}</span>

                    <!--
                        Same slot and grammar as the running tool and the settled date: a card is only ever one of
                        those three things at a time.
                        Takes the date's place, except on an archived card, which keeps both: a watch is exactly what
                        would drag a filed-away agent back onto the board.
                    -->
                    <span v-if="watch !== undefined" class="inline-flex min-w-0 items-center gap-1.5">
                        <!--
                            Readout and its hint wrap together, separately from the press beside them.
                            A second nested tooltip would raise both boxes over the same words.
                        -->
                        <span class="inline-flex min-w-0 items-center gap-1.5 font-medium text-link" v-tooltip.top="watch.hint">
                            <Icon name="eye" class="shrink-0 text-2xs" />
                            <span class="min-w-0 truncate">{{ watch.text }}</span>
                            <span class="shrink-0 tabular-nums">{{ watch.countdown }}</span>
                        </span>
                        <!--
                            The one visible way to disarm a watch; previously only a right-click menu or a drag,
                            neither discoverable from the readout that announces it.
                            The one exception to withholding presses in the archive: every other press there could
                            un-file the agent, but this one only prevents an unwanted return.
                        -->
                        <Button
                            size="small"
                            severity="secondary"
                            :text="true"
                            class="shrink-0"
                            aria-label="Stop watching"
                            v-tooltip.top="'Stop watching, this conversation stays put'"
                            :class="mobile ? 'opacity-60' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                            @click.stop="emit(`unwatch`)"
                        >
                            Stop
                        </Button>
                    </span>

                    <!--
                        Same corner as the settled card's date, so the eye finds one readout per card instead of two at
                        different heights.
                        Shows "Working…" even with no activity frame yet, since dropping it would take the clock with
                        it, and a running card with no clock can't be triaged.
                    -->
                    <span v-if="turnInFlight(agent)" class="inline-flex min-w-0 items-center gap-1.5 font-medium text-link">
                        <!--
                            Glyph follows whichever fact leads: running children if any, else the tool the agent itself
                            is using.
                        -->
                        <Icon :name="(agent.subagents?.running ?? 0) > 0 ? 'users' : activityIcon(agent.activity?.tool)" class="shrink-0 text-2xs" />
                        <span class="min-w-0 truncate">{{ activityText ?? "Working…" }}</span>
                        <span v-if="agent.startedAt !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed(agent.startedAt, now) }}</span>
                    </span>
                </span>
            </div>
        </div>
    </div>
</template>
