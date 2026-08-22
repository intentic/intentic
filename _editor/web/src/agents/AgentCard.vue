<script setup lang="ts">
import Button from "primevue/button";
import { ProgressRing, useDevice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { requestLandAgent } from "../composables/agents/agentActions";
import { useRole } from "../composables/sandbox/useRole";
import OriginMark from "../components/OriginMark.vue";
import WorkflowMark from "../components/WorkflowMark.vue";
import { dropActionFor, type PendingAction } from "../composables/agents/laneDrop";
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
    loopMeta,
    reviewAction,
    turnInFlight,
    unreadBadge,
    unregistered,
} from "../composables/agents/agentStatus";
import { type MatchSnippet, providerLabel } from "@intentic/sandbox-contract";
import { sessionCategory } from "../composables/sessionCategory";
import IdentityTile from "../components/IdentityTile.vue";
import MatchLine from "../components/MatchLine.vue";
import SessionChip from "./SessionChip.vue";
import { createInlineRename } from "../composables/inlineRename";
import { markSegments } from "../composables/agents/markSegments";
import { canArchive, useAgents, type FleetAgent } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/providerCatalog";

/* One fleet agent, mock-level hierarchy: provider mark + title + status/attention chip; model · session meta;
 * and one closing summary line that carries the stats (cost · +ins −dels · subagents · context ring) with the
 * card's "when" pinned to its right: for a running card what the turn is doing and how long it has been at it
 * (the chat rail's readout, to the letter), for a settled one its date.
 * `now` ticks from AgentsView so every card's elapsed readout advances together without per-card timers. The
 * title renames in place (hover pencil → inline input); the drill-in rides beside it as a hover glyph, except
 * on a card that needs the user, where it is spelled out on the summary line. The root is a div-button, not a
 * <button>, so the nested pencil/input stay valid HTML.
 *
 * `dense` is the same card in its ROW form, which the board switches on when it stacks its lanes (AgentsView).
 * A stacked lane is as wide as the view, so the blocks that have to stack inside a 280px column run along one
 * wrapping line instead, and a card that cost five rows of height costs two: the difference between five
 * agents on screen and a dozen. Nothing is dropped or added: same DOM, same facts, different flow. */

const props = defineProps<{
    agent: FleetAgent;
    now: number;
    dense?: boolean;
    dragging?: boolean;
    // What the board has in flight against this card, if anything: the action itself, so the button that
    // fired it can say so while the rest of the card only dims (see PendingAction).
    pending?: PendingAction;
    /* This agent's chat is ON SCREEN in the chat panel: one weight, however many columns it is sharing that
     * screen with. A split used to be ranked here (the focused column at full strength, the rest at half), and
     * the rail ranked it the same way; both have stopped, because nothing about a second column makes the
     * first one more real. See RailCard.selected, which this is the board's half of. */
    selected?: boolean;
    // The board's filter, when one is on. `match` is the line the query hit and who said it: the EVIDENCE for
    // this card being in a filtered lane. Absent when the hit was the title (already on the card, and marked
    // below instead). A card that matches for a reason the user can't see is what teaches people to stop
    // trusting a search, so the filter never narrows a lane without this.
    match?: MatchSnippet;
    query?: string;
    // The filter's `Aa` switch, so the marks are struck under the rule the search actually ran.
    matchCase?: boolean;
}>();
const emit = defineEmits<{
    // The click that opened it, when there was one: a modified click asks for a pane rather than the focus.
    open: [event?: MouseEvent];
    review: [];
    resolve: [];
    land: [];
    // The way back after landed work was discarded: a separate event from `land`, because it lands a
    // different span (the whole of the agent's output, not the remainder) and must never be fired by accident.
    reland: [];
    archive: [];
    restore: [];
    close: [];
    grab: [event: PointerEvent, card: HTMLElement];
}>();

const { mobile } = useDevice();
const meta = computed(() => agentStatusMeta(props.agent.status));
// The identity tile's category (sessionCategory over the title), undefined for a title that reads as nothing
//: read here as well as inside IdentityTile because the tooltip (the colour's legend) is this card's to say.
const category = computed(() => sessionCategory(props.agent.title));
const lane = computed(() => laneOf(props.agent));
const reason = computed(() => attentionReason(props.agent));
// What the live line says: the shared derivation (agentStatus.activityLine), because the rail's cards carry
// the same line and the two surfaces must never narrate the same turn differently.
const activityText = computed(() => activityLine(props.agent));
// Archiving is offered wherever it means something: which is NOT the same as "the Finished lane" (see
// canArchive): every card whose archive the daemon would take and that isn't holding a question for the user,
// dead ends in the Attention lane included. It sits beside the rename pencil rather than behind the drag
// gesture: this is the routine way to end an agent (nothing is lost, the branch, transcript and counters all
// stay), so it has to be reachable by touch and by keyboard, which a drag to a zone that only exists mid-drag
// never was.
const archivable = computed(() => canArchive(props.agent));
/* THE EXIT FOR A CARD THAT IS NOT AN AGENT: a draft, a send the daemon refused, a turn it has not filed yet
 * (`unregistered`). Every other way off this board addresses an id through the daemon, which has never heard of
 * this one: archive, discard, land and every drop are therefore refused, and what that left behind was a card
 * the user could do NOTHING with except rename it. A broken send would leave one in the Active lane, above the
 * agents actually working, for the life of the sandbox: it survives a reload, because the tab it belongs to does.
 *
 * So the exit it does have (closing the tab) is offered where the card is, instead of only on the chat rail
 * the board never mentions. It takes the archive glyph's slot because the two can never both apply, and asks
 * for no confirmation for the same reason no close in the rail does: with no branch, no worktree and no
 * daemon-side transcript, there is nothing here to lose but the words, and those are in the composer. */
const closable = computed(() => unregistered(props.agent.status));
/* ...and what closing it COSTS, which is the one thing that differs across those standings. A `starting` card's
 * turn is already running daemon-side: the close only stops this window rendering it, and the agent takes its
 * own card the moment the daemon files it: so the draft's reassurance ("this never started") would be a lie
 * about work in flight, and the sentence has to say which of the two the reader is looking at. */
const closeHint = computed(() =>
    props.agent.status === `starting`
        ? `Close: the turn keeps running, and its own card appears once the sandbox has filed it`
        : `Close, this never started, so there is no branch or transcript to keep`,
);
// The drill-in label, or undefined for a draft (nothing to review: a click only focuses the docked chat).
// Desktop only: on mobile the detail IS the chat, so a tap navigates and no separate affordance is needed.
const review = computed(() => (mobile.value ? undefined : reviewAction(props.agent)));

/* MAY THIS CARD HAND ITS CONFLICT BACK TO ITS AGENT? Asked of laneDrop rather than re-derived from
 * status/attention here, because it is the identical question the drop already answers: "would this board ask
 * the agent to resolve?": and a second reading of it would be free to disagree with the drag on the same card.
 * That also inherits the guards for nothing: a draft has no worktree, a running turn is offered Stop instead
 * (the review panel disables its own button while streaming for the same reason), and an agent blocked on a
 * question is answered rather than rebased.
 *
 * On mobile it is the ONLY way to trigger the resolve (the drag is mouse/pen only by design) and it stays
 * live while the board is filtered, where the drag is deliberately withdrawn (AgentsView.grabCard): a press
 * names its own target, so none of the reasons a filtered board refuses a drop apply to it.
 *
 * ARCHIVED CARDS ARE EXCLUDED. A follow-up message un-archives an agent (the daemon's registry.begin), so this
 * button pressed in the archive would quietly put the card back on the board: a side effect nobody browsing a
 * filing cabinet asked for. Restore first; the conflict will still be there. */
const resolvable = computed(() => props.agent.archivedAt === undefined && dropActionFor(props.agent, `finished`) === `resolve`);
/* WORK THIS AGENT LANDED THAT IS NO LONGER IN THE TREE: the line, and the offer under it (agentStatus.landedAway).
 *
 * Excluded in the archive like every other press on this card, and by the same logic: act on filed-away work
 * by restoring it first.
 *
 * IT TAKES THE READY CARD'S BUTTON RATHER THAN SITTING BESIDE IT, which is why `landable` below yields to it.
 * Both can be true at once (an agent whose first land was discarded and which has since written more) and
 * the two presses are NOT interchangeable there: "Land now" carries the outstanding remainder and would put
 * the newer work in while leaving the discarded half exactly as missing as it was, which is the one outcome
 * nobody wants and the hardest to notice. "Land again" measures from the branch's base and so covers both, so
 * where both apply there is only ever one honest button. */
const away = computed(() => (props.agent.archivedAt === undefined ? landedAway(props.agent) : undefined));
/* THE READY CARD'S PRESS. `ready` exists because the user turned auto-land off, so the one thing this card is
 * waiting for is the deliberate land: offered where the state is announced, as a real button for the same
 * reasons the conflict card's resolve is one (touch, keyboard, a scanning eye). Same wording and mechanics as
 * the review panel's own button: one vocabulary for one action. Excluded in the archive like `resolvable`,
 * and by the same logic: act on filed-away work by restoring it first. */
const landable = computed(() => props.agent.archivedAt === undefined && props.agent.status === `ready` && away.value === undefined);
/* THE PRESS WHILE IT IS STILL OUT. A card mid-action dims, which says the board is doing SOMETHING with it:
 * not which something, and that is the half that matters on the two controls the card fires itself: a button
 * holding its resting label through a round trip reads as a press that didn't take, which is what makes people
 * press it again. So each of them names its own action back, and strictly its own: `pending` carries the
 * action precisely so archiving a `ready` card doesn't leave its Land button spinning over work nobody asked
 * to land. What ENDS the state is the daemon's next roster frame: for a land, a card with no button left. */
const landing = computed(() => props.pending === `land`);
/* THE ROLE SPLIT ON THE READY CARD. A maintainer (and the owner) gets "Land now"; a collaborator gets
 * "Request land": the same press redirected at the people who may answer it, because the daemon floors the
 * land itself at maintainer. The request is performed HERE rather than emitted: the board is only one of this
 * card's hosts, and an ask that three parents each had to wire would be an ask two of them forgot. A viewer
 * gets neither: watching is the whole grant. */
const { canDrive, canShip } = useRole();
const { refresh: refreshAgents, notice: agentsNotice, rename } = useAgents();
const requesting = ref(false);
const requestLand = async (): Promise<void> => {
    if (requesting.value) {
        return;
    }
    requesting.value = true;
    try {
        await requestLandAgent(props.agent.id);
        await refreshAgents();
    } catch (caught) {
        agentsNotice.value = errorMessage(caught, `Couldn't send the land request.`);
    } finally {
        requesting.value = false;
    }
};
// The standing ask, worn by the card for everyone: the collaborator sees their ask took, and a maintainer
// reads it as the call to press the button beside it.
const landAsk = computed(() => {
    const request = props.agent.landRequested;
    return request === undefined ? undefined : `${request.name ?? request.email} asked to land this`;
});
// Its own flag rather than a widened `landing`: the two buttons can never both be on a card (see `away`), but
// each has to name back the action that was actually pressed, which is the whole reason `pending` carries one.
const relanding = computed(() => props.pending === `reland`);
const handingOver = computed(() => props.pending === `resolve`);
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
/* WHETHER THE STAT ROW HAS ANYTHING TO SAY: every chip in it and NOTHING ELSE, which is the whole point of
 * naming it here. The row was once gated on cost/diff/turns, and all three are facts a turn only produces when
 * it ENDS: nothing is counted until the result message lands, `turns` moves at finish, the diff after a land.
 * So the two chips that mean something WHILE the agent works: the agents it started and how full its context
 * is: were hidden behind numbers that do not exist yet, and a first turn that delegated showed its children
 * nowhere. A row gated on a SUBSET of what it renders is a row that hides the rest.
 * The mirror of that mistake is a row gated on MORE than it renders, which opens an empty strip of padding: so
 * the diff clause is the diff chip's own condition rather than "there is a diff", since a diff of renames and
 * mode changes alone has nothing to draw: and `turns` left this list the moment the turn chip left the row,
 * or a card whose only number was its message count would have opened a strip with nothing in it. */
const stats = computed(
    () =>
        props.agent.costUsd !== undefined ||
        (props.agent.diff !== undefined && (props.agent.diff.insertions > 0 || props.agent.diff.deletions > 0)) ||
        props.agent.subagents !== undefined ||
        context.value !== undefined,
);
// Only a card with a registry entry behind it may say the work COMPLETED: that is the daemon's account of a
// turn, and the client-only standings have none to draw on. A chat reopened from History sits in this lane too
// (nothing is running, nothing is owed) and knows nothing about how it ended; its chip already says what it is.
const completed = computed(() => lane.value === `finished` && !unregistered(props.agent.status));
// Whether this card can date itself at all: a draft that has never been touched cannot, and neither can a
// RUNNING one — its own readout is the ticking elapsed that takes the same slot.
const dated = computed(() => props.agent.archivedAt !== undefined || (!turnInFlight(props.agent) && props.agent.updatedAt > 0));
/* WHETHER THE CLOSING LINE HAS ANYTHING TO SAY. The stats and the time-ago used to be two rows, and the second
 * of them held four characters and an affordance that only appears under the pointer: a full row of card
 * height, on every card on the board, so that a lane fit five agents where it could have fit six. They are one
 * wrapping line now: tallies from the left, the standing and the time pinned to the right, and a lane too
 * narrow for both wraps them rather than buying the row outright. Gated on everything it draws and nothing
 * else, so a card with no numbers, no date and nothing to drill into opens no empty strip of padding. */
const summary = computed(() => stats.value || review.value !== undefined || completed.value || dated.value || turnInFlight(props.agent));
const loopLine = computed(() => (props.agent.loop === undefined ? undefined : loopMeta(props.agent.loop)));
/* The card says WHO RUNS IT exactly once. While the tile wears the provider mark (no category yet), this
 * line needs no floor; once the category glyph takes the tile, a card with no recorded model would say the
 * provider nowhere: so the provider lands here, and only then. */
const model = computed(() => {
    if (props.agent.model !== undefined) {
        return modelLabelFor(props.agent.provider, props.agent.model);
    }
    return category.value === undefined ? undefined : providerLabel(props.agent.provider);
});
/* A nameless card, named for what it IS: a tab waiting to be typed into, a past conversation whose session
 * never earned a title, or an agent whose own naming has yet to land.
 *
 * ...unless the user has already written the thing that names it. A title is minted by the first turn, so a
 * lane of cards waiting to be sent all read "New agent" at exactly the moment the reader has to tell them
 * apart, while the sentence that would tell them apart sits in each one's composer (FleetAgent.preview). The
 * card wears it until a real title lands and then never again. */
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
// The title with the filter's term marked, and one plain run when no filter is on. The matched LINE is marked
// by MatchLine, which also names the speaker: the two are never shown apart. The term is folded to the card's
// own case rule, which is the filter's: under `Aa` it stands as typed.
const needle = computed(() => (props.matchCase === true ? (props.query ?? ``) : (props.query?.toLowerCase() ?? ``)));
const titleRuns = computed(() => markSegments(displayTitle.value, needle.value, props.matchCase === true));
// The unread chip (agentStatus.unreadBadge: the rail's cards wear the same one). "New" already says you have
// not opened it; "Updated" is the flavour that hides a fact (WHEN you last looked) so only it earns a hover.
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
// A blur-commit's click on the card body must commit the rename, not also focus the agent. The EVENT rides
// along because a modified click means something else on this board: a column of its own for this agent, or a
// run of them (AgentsView.focusAgent); a keyboard open carries none and is the plain act.
const openCard = (event?: MouseEvent): void => {
    if (edit.editing || edit.consumeSuppressedOpen()) {
        return;
    }
    emit(`open`, event);
};

// The view-change is deliberate, never a side effect of a plain click: the contextual affordance below fires
// it, and double-clicking the body is its power-user accelerator (same guard as openCard).
const reviewCard = (): void => {
    if (edit.editing || review.value === undefined) {
        return;
    }
    emit(`review`);
};

/* The header's quiet icon affordances (rename, archive, restore): one class string, since they differ only
 * in glyph and in the opacity rule the template applies per form factor.
 *
 * 20px of ink, which is right beside a 12px title and hopeless under a thumb: and the template already knows
 * it is on a phone, because it drops the hover-reveal there (an affordance that only appears on hover appears
 * never on touch). What it could not fix by showing them is that four of them sit in one 390px row. So the
 * INK stays 20px and `touch-target` takes the hit area to 44 on a coarse pointer: the card's density is the
 * reason a fleet board fits on a phone at all, and it survives. */
const HOVER_ACTION = `touch-target flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-overlay hover:text-content`;

// Offer the card to the board's drag as long as the press starts on the card BODY: the rename pencil and its
// input run their own pointer gestures, and a press while renaming belongs to the input's caret.
const grab = (event: PointerEvent): void => {
    // THE PRIMARY BUTTON ONLY. A right-press opens the card's menu (AgentsView), and a menu that opens over a
    // card the board has already picked up for dragging is one gesture answered twice.
    if (event.button !== 0) {
        return;
    }
    if (edit.editing || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`input, button`) !== null) {
        return;
    }
    // A MODIFIED press is picking this card into a chat pane, not dragging it to a lane (see AgentsView's
    // focusAgent). Without this the selection click would also start a drag, and the board would be answering
    // one gesture two ways.
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
        class="session-card group flex w-full select-none flex-col gap-1.5 rounded-lg border p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
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
        <div class="flex items-center gap-2">
            <!-- The IDENTITY TILE (IdentityTile): the kind-of-work glyph on a tint of this agent's CATEGORY
                 hue (sessionCategory: the title's action word read as a Conventional Commit type, audits a
                 blue magnifier, redesigns purple arrows, new work a green plus, fixes a red wrench). Shape
                 and colour say the same thing twice, and the tint is also the cross-reference to the same
                 session's card on the chat rail. The tooltip is the legend; an unreadable title wears the
                 provider mark on neutral chrome instead. -->
            <IdentityTile v-tooltip.top="category?.type" :title="agent.title" :provider="agent.provider" class="h-5 w-5 text-xs" />
            <input
                v-if="edit.editing"
                v-model="edit.draft"
                type="text"
                maxlength="80"
                aria-label="Agent title"
                class="min-w-0 flex-1 select-text rounded bg-overlay px-1 text-xs font-semibold text-content outline-none ring-1 ring-primary-500/50"
                @click.stop
                @keydown.enter.stop.prevent="edit.commit()"
                @keydown.esc.stop.prevent="edit.cancel()"
                @blur="edit.blurCommit()"
                @vue:mounted="edit.focusInput"
            />
            <template v-else>
                <span class="min-w-0 flex-1 truncate text-xs font-semibold text-content">
                    <span v-for="(run, at) in titleRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{
                        run.text
                    }}</span>
                </span>
                <button
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
                <!-- THE DRILL-IN, among the other quiet affordances rather than spelled out at the foot of the
                     card. It was a text link down there ("Review changes", "See where it stopped") and being
                     in the flow of the line it had to RESERVE its hundred-odd pixels while invisible, which is
                     what pushed the time onto a row of its own and cost every card on the board a line of
                     height for something nobody could see. As an icon it costs nothing at rest, and the words
                     it lost are on its tooltip. The exception is a card that needs the user: there the label is
                     the point and stays spelled out on the summary line below, where it is always visible. -->
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
            <span v-else-if="reason !== undefined" class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px text-2xs font-semibold text-warning">{{
                reason
            }}</span>
            <span
                v-else-if="unread !== undefined"
                v-tooltip.top="unread.hint"
                class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px text-2xs font-semibold text-link"
                >{{ unread.label }}</span
            >
            <Icon v-else :name="meta.icon" :spin="meta.spin" class="shrink-0 text-xs" :class="meta.class" />
        </div>
        <p v-if="edit.error !== undefined" class="text-2xs text-danger">{{ edit.error }}</p>

        <!-- The card's body, in whichever direction it has room for. Column: one block per row, the only thing
             that fits a kanban lane. Row (`dense`): the same blocks along one wrapping line, each block already
             shrinks or wraps internally, so the line degrades on its own as the board narrows. -->
        <div :class="dense ? 'flex flex-wrap items-center gap-x-3 gap-y-1' : 'flex flex-col gap-1.5'">
            <!-- WHY this card survived the filter: the line the query hit, and which side of the chat said it.
                 Leads the body, because while a filter is on that is the question the card is being read to
                 answer: and only renders when the hit was NOT the title, which is marked in place above
                 instead (echoing it here would push every other card down the lane to repeat what is already on
                 screen). Two lines before the clamp: a snippet cut to one is usually cut mid-phrase, and a
                 fragment that doesn't contain the sentence is no longer evidence. Full width in the `dense`
                 row form, so it stays a line of prose rather than a column squeezed between two stat blocks. -->
            <p v-if="match !== undefined" class="flex min-w-0 items-start gap-1.5 text-2xs text-muted" :class="dense ? 'w-full' : ''">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="match" :needle="needle" :match-case="matchCase" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </p>

            <!-- WORDS OF THE USER'S STILL SITTING IN THIS CHAT'S COMPOSER (FleetAgent.unsent). Leads the body,
                 above even provenance: everything else on this card is the agent's account of itself, and this
                 one line is the reader's own unfinished business: the only thing here that no one but them can
                 clear. It is the whole reason such a card is on the board at all (see `fleet`, which lifts an
                 ARCHIVED session back onto the lanes for it), so a card that came back without saying why would
                 read as the archive leaking.
                 The composer's own send glyph, in the link hue the board spends on "an offer to act" (the same
                 one Ready-to-land wears): nothing is wrong here, so none of the warning colours apply. The
                 text itself is deliberately NOT shown: a board is read at a glance, often over someone's
                 shoulder, and a half-written message is the most private thing this app holds. -->
            <p v-if="agent.unsent" class="flex min-w-0 items-center gap-1.5 text-2xs text-link" v-tooltip.top="'You have an unsent message here'">
                <Icon name="send" class="shrink-0 text-2xs" />
                <span class="truncate font-medium">Unsent message</span>
            </p>

            <!-- WHY IT DIED. The daemon carries this only while the card still reads as failed (AgentSummary's
                 `failure`), so no state check belongs here: its presence IS the state. Above provenance and
                 the model line because on a red card nothing else on it is what the reader came for: without
                 this the board said "Error", and the sentence naming the spent plan or the organization that
                 switched Claude Code off lived only inside the dead session. Two lines, then the full text on
                 hover: a provider's explanation is a sentence, and a fragment of one is not an explanation. -->
            <p v-if="agent.failure" class="flex min-w-0 items-start gap-1.5 text-2xs text-danger" v-tooltip.top="agent.failure">
                <Icon name="exclamation-circle" class="mt-px shrink-0 text-2xs" />
                <span class="line-clamp-2 min-w-0 flex-1 leading-4">{{ agent.failure }}</span>
            </p>

            <!-- Provenance, ahead of the model/branch line: for an agent the user never started, "who asked for
                 this" outranks what it runs on. Both render nothing for a user-started agent. -->
            <OriginMark :origin="agent.origin" />
            <WorkflowMark :workflow="agent.workflow" />

            <!-- The row itself is revealed too when the MODEL is missing, which is the case where hiding the
                 branch would otherwise leave a flex row holding one `display:none` child: no height of its own,
                 but still a gap in the column above and below it. One display utility per state, chosen here
                 rather than stacked in the class list: `hidden` and `flex` are the same property, and which
                 wins between two plain utilities is Tailwind's emit order, not the order they are written. A
                 variant (`group-hover:`) always sorts after its unvaried counterpart, so that pair is safe. -->
            <div
                v-if="model !== undefined || agent.branch !== undefined"
                class="min-w-0 items-center gap-1.5 text-2xs text-subtle"
                :class="model !== undefined || mobile ? 'flex' : 'hidden group-hover:flex'"
            >
                <span v-if="model !== undefined" class="truncate">{{ model }}</span>
                <!-- THE SESSION NAME IS REVEALED, NOT PRINTED, and the argument for that is the lane rather
                     than the name. It is the only thing on this card anybody needs CHARACTER-EXACT: every
                     other word here is read, not retyped: but "needed exactly, occasionally" and "shown on
                     forty cards at once" are different claims, and it was answering the second while only ever
                     being asked the first. A column of forty machine names in mono is the largest block of
                     text on the board and the one nobody reads on the way past.
                     ON HOVER, WHICH IS WHEN IT IS ASKED FOR. A pointer resting on a card is a reader who has
                     stopped on it, which is exactly the moment the name becomes a fact about something rather
                     than a row of noise. Revealed by `display`, not by opacity: an invisible chip that still
                     holds its width leaves a gap in the line and puts a hover target under a pointer aiming
                     at the card, and this line has no other reason to reserve space. Nothing moves vertically
                    : the row exists either way, and only its own width changes.
                     TOUCH GETS IT UNCONDITIONALLY. There is no hover on a phone, and a fact reachable only by
                     a pointer is a fact a phone does not have: the same rule the card's hover actions follow.
                     It stays a LABEL, not a control: a small target for a rare want, sitting mid-card in the
                     path of the press that focuses the agent, is a target hit by accident more often than on
                     purpose. Copying it is on the right-click menu (AgentsView), where the board keeps the
                     decisions that are made about a card rather than to it; the full string is on its own
                     hover, since what shows here is abbreviated (SessionChip). -->
                <!-- The reveal rides a WRAPPER rather than the chip itself, because `hidden` and the chip's own
                     `inline-flex` are both display utilities and which of them wins is Tailwind's emit order,
                     not the order they are written in. A wrapper has no display of its own to argue with. -->
                <span
                    v-if="agent.branch !== undefined"
                    class="min-w-0 items-center gap-1.5"
                    :class="mobile ? 'inline-flex' : 'hidden group-hover:inline-flex'"
                >
                    <span v-if="model !== undefined">·</span>
                    <SessionChip :branch="agent.branch" />
                </span>
            </div>

            <!-- THE LOOP LINE. Never instead of the live readout below: that says what the agent is doing this
                 second, this says what it is doing it TOWARDS, and a looping agent without the second one is a
                 spinner with no end in sight. Survives the loop's end on purpose: how a
                 loop stopped is the thing the card is read for afterwards. -->
            <p v-if="agent.loop !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs" :class="loopLine?.class">
                <Icon name="repeat" class="shrink-0 text-2xs" :class="loopLine?.spin ? 'animate-spin' : ''" />
                <span class="truncate">{{ loopLine?.text }}</span>
            </p>

            <!-- THE CONFLICTED CARD'S WAY OUT, ON THE CARD. A refused land is the one state on this board that
                 is a decision point rather than a report, and the decision has an obvious first answer: the
                 agent redoes the merge in its own worktree, where a wrong answer costs the user nothing. Until
                 now that answer existed only as a drag to the Finished lane: mouse-and-pen only, gone while
                 the board is filtered, and invisible until you tried it: or one route change away in the
                 review panel, whose button this borrows its exact wording from. One vocabulary for one action.
                 A real button rather than the hover-revealed link below: this is the press the card exists to
                 collect, and an affordance that appears on hover is not one a touch device or a scanning eye
                 ever finds. The mechanics sit UNDER the button as a line of muted prose: the same shape, and
                 the same sentence, the conflict report uses beside its own copy of this button. They were a
                 35-word tooltip, which is what makes the press deliberate enough to skip the drop's
                 confirmation dialog (see useAgentDrag.resolveNow) and so had to be readable without a pointer:
                 hover reaches no touch device, and a paragraph in a box that closes on the first click is not
                 disclosure, it is a formality. -->
            <div v-if="resolvable" class="flex min-w-0 flex-col gap-0.5">
                <Button size="small" class="self-start whitespace-nowrap" @click.stop="emit('resolve')">
                    <Icon :name="handingOver ? 'spinner' : 'sparkles'" :spin="handingOver" />{{
                        handingOver ? "Handing it over…" : "Have the agent resolve it"
                    }}
                </Button>
                <span class="text-2xs leading-snug text-subtle"
                    >It merges in its own worktree: nothing reaches your workspace unless it succeeds.</span
                >
            </div>

            <!-- LANDED WORK THAT IS NO LONGER IN THE TREE. The user discarded it in the Changes panel (or took
                 it back out by hand), and until this line existed the card went on wearing its landed chip over
                 a workspace that held none of it: the one lie on this board the user could not catch, because
                 every other reading here is taken between commits and a discard moves no commit.
                 IT IS ONE ROW, NOT A STACK, which is the whole difference between this block and the two above.
                 Those are decisions waiting to be made and are read top-to-bottom: the ask, the press, the
                 consequence. This is a FACT the card owes the reader whether or not they act on it, and it used
                 to be spelled the same way: an amber line, a hand-rolled bordered button on its own line under
                 it, and a two-line reassurance paragraph under THAT. Four rows and three left edges for one
                 sentence and one press, on a card whose entire job is to be glanced at, and the tallest thing
                 on the board belonged to the state the user cares least about. So the sentence and its offer
                 share a line: fact left, press right, the mechanics folded into the sentence as a clause (see
                 agentStatus.landedAway). It wraps rather than truncates on a narrow card: a fact clipped to an
                 ellipsis is a fact not delivered: and the button drops below it when the row runs out.
                 THE PRESS IS THE QUIETEST BUTTON ON THE CARD: the shared outlined secondary at the card's own
                 micro type with a muted label, not the success-filled primary "Land now" wears, and no longer a
                 one-off border that matched nothing else here: because discarding is very often a rejection,
                 and a board that answers it with a bright button is arguing with a decision the user already
                 made. Muted rather than the theme's near-white label for the same reason in miniature: the
                 amber fact is what the row is FOR, and it has to be read before the offer beside it is. Never
                 automatic either: nothing re-lands this without the press. -->
            <div v-if="away !== undefined" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <p class="flex min-w-0 flex-1 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="undo" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0"
                        >{{ away.text }} <span class="text-subtle">({{ away.hint }})</span></span
                    >
                </p>
                <!-- No resting glyph: the line it sits on already leads with this exact one, and the pair read
                     as a stutter across six words. The spinner is the exception: that one is not decoration
                     but the press reporting itself, and it only exists while the round trip is out. -->
                <Button
                    size="small"
                    severity="secondary"
                    :outlined="true"
                    class="shrink-0 whitespace-nowrap !px-2 !py-0.5 !text-2xs !text-muted hover:!text-content"
                    @click.stop="emit('reland')"
                >
                    <Icon v-if="relanding" name="spinner" spin class="text-2xs" />{{ relanding ? "Landing…" : "Land again" }}
                </Button>
            </div>

            <!-- The READY card's press: the deliberate land the user opted into by turning auto-land off (see
                 `landable`). Success-styled with the check glyph exactly like the review panel's "Land now":
                 the two are the same action on the same work, and must read as such.

                 IT USED TO CARRY A LINE OF PROSE UNDER IT ("Arrives as uncommitted changes, your own commit
                 stays the review step") and it is gone, which is a different judgement from the two sentences
                 that remain on this card rather than a change of mind about them. Those explain a SITUATION the
                 reader has not met before: why a conflicted card is offering to redo the merge, why a
                 collaborator is being offered an ask instead of a land. This one explained the MECHANICS of a
                 routine press, to the one person who cannot be surprised by them: landing is off by default, so
                 a card only ever offers this button to somebody who went into settings and turned auto-land
                 off. Two lines of standing explanation per card, on a board of forty, for a fact its own reader
                 configured. The board is scanned; a card earns its height from what changes what you do next. -->
            <div v-if="landable && canShip" class="flex min-w-0 flex-col gap-0.5">
                <!-- The standing ask leads the button it is about: a maintainer reading top-to-bottom meets the
                     reason before the press. -->
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
                </p>
                <Button size="small" severity="success" class="self-start whitespace-nowrap" @click.stop="emit('land')">
                    <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" />{{ landing ? "Landing…" : "Land now" }}
                </Button>
            </div>

            <!-- The same ready card in a collaborator's hands: the land is a maintainer's press, so the card
                 offers the ask instead: same spot, same size, quieter chrome. Once asked, the card says so
                 and stands down (re-asking only re-stamps the same fact). A viewer gets neither. -->
            <div v-else-if="landable && canDrive" class="flex min-w-0 flex-col gap-0.5">
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

            <!-- THE CLOSING SUMMARY LINE: the numbers this card counted, then the drill-in and the time held to
                 the right of the same line (see `summary`). -->
            <div
                v-if="summary"
                class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted"
                :class="dense ? 'min-w-32 flex-1' : ''"
            >
                <!-- No hover labels on the numbers. Chips side by side each raising its own box turned a glance
                     across the card's numbers into a strip of pop-ups, and every label was the legend for a
                     glyph the reader had already decoded: the ring is context. A stat you cannot name from its
                     icon does not belong in a chip row.
                     WHAT IS NOT HERE, AND WHY. The line carried a token reading (`277 / 65k`), a count of files
                     touched, and a count of TURNS, and a board is scanned rather than studied: every chip in
                     it spends the same glance, so a chip has to change what the reader does next or it is
                     taxing the ones that do. Tokens were the raw form of the cost sitting beside them: two
                     numbers, an icon, and no decision anybody makes from a board that the money figure does not
                     make shorter. The file count was drawn with the duplicate-pages glyph: which reads as
                     "copy", not as "files": and stood next to the +/− that already says how big the change is.
                     Turns are the newest to go and the clearest case: "9 messages" is a fact about a
                     CONVERSATION, and a board is not read to find out about conversations, it is read to find
                     out which agent needs a person. Nothing on this line was ever decided by it.
                     All three still exist where they are read on purpose rather than in passing: the tokens in
                     the Usage tab, the files in the agent's own Changes panel, and the turn count on the chat
                     rail's card: which answers "what is in the chat I have open" rather than "which of forty
                     agents do I go to", and is the one frame where the number is about the thing being read. -->

                <!-- The card's cost is this agent's lifetime total, read only: the Usage tab still breaks it
                     down by day and model, but reaching it from here put a route change inside the chip row a
                     click aims THROUGH on its way to focusing the agent, and the misfires cost more than the
                     shortcut saved. It stays while the tokens go because it is the board's ONE economic
                     signal, three characters wide, and an agent that has quietly spent $23 is worth catching. -->
                <span v-if="agent.costUsd !== undefined">{{ formatCost(agent.costUsd) }}</span>
                <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                    <span class="text-success">+{{ agent.diff.insertions }}</span>
                    <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                </span>
                <!-- THE AGENTS THIS AGENT STARTED. A card is the answer to "what is this agent up to", and one
                     running five children used to look exactly like one running none. A nested button, like the
                     cost above and for the same reason: the click opens the Subagents area rather than the agent
                    : narrowed to THIS agent's children, because the chip is a claim about one card and a list of
                     everything the sandbox has ever spawned answers a question nobody asked here. The chip counts
                     live-of-total while any are working and settles to the lifetime total once none are: "3 / 5"
                     says something a bare "5" cannot, and only while it is true. -->
                <!-- A LINK, which is what it always looked like: it underlines on hover and tints when live, and
                     it names a list with an address of its own. `.stop` keeps the card underneath from also
                     opening; it needs no `.prevent`, because the anchor going where it says it goes is now the
                     whole point: a Ctrl/⌘-click puts that list in its own tab. -->
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
                <span v-if="context !== undefined" class="inline-flex items-center gap-1">
                    <ProgressRing :value="context" :class="context >= 80 ? 'text-warning' : 'text-primary-500'" />
                    <span>{{ context }}%</span>
                </span>

                <!-- The standing and the clock, held to the END of the line by their own margin rather than by a
                     spacer element: a spacer is an item, and on a lane narrow enough to wrap it would take the
                     whole first line with it and leave the numbers stranded above an empty row. -->
                <span class="ml-auto inline-flex min-w-0 items-center gap-2 text-subtle">
                    <!-- The deliberate view-change, spelled out for the one card that has earned the width: an
                         agent waiting on the user, whose label IS the instruction ("Answer", "Approve spend",
                         "See what blocked it"). Every other card carries the same press as the arrow up in the
                         header, where it costs no height. -->
                    <button
                        v-if="review !== undefined && lane === 'attention'"
                        type="button"
                        class="inline-flex shrink-0 items-center gap-1 rounded font-medium text-link hover:underline"
                        @click.stop="reviewCard"
                    >
                        {{ review }}<Icon name="arrow-right" class="text-2xs" />
                    </button>
                    <span v-else-if="review === undefined && completed" class="inline-flex shrink-0 items-center gap-1">
                        <Icon name="check" class="text-2xs" />Completed
                    </span>
                    <!-- THE SETTLED CARD'S DATE, in the corner the running card puts its elapsed in: the two
                         are the same slot answering "when", and a card is never both.
                         An archived card is read as a record, so it dates itself by when it LEFT the board:
                         "last active 3d ago" is the same fact its neighbours already show and answers a question
                         nobody in an archive is asking. -->
                    <span v-if="agent.archivedAt !== undefined" class="shrink-0"> Archived {{ relativeTime(agent.archivedAt) }} </span>
                    <span v-else-if="!turnInFlight(agent) && agent.updatedAt > 0" class="shrink-0">{{ relativeTime(agent.updatedAt) }}</span>

                    <!-- WHAT IT IS DOING AND HOW LONG IT HAS BEEN AT IT, at the end of the line the settled
                         card ends with its date: the running card's clock in the same corner as the stopped
                         card's, so the eye finds one readout down a lane instead of two at two heights. It
                         used to be a ROW of its own above the numbers, which cost every running card a line of
                         height to carry two short words and a timer, and pushed the spend and the diff a line
                         further down the card. The three parts stay in the rail's order (glyph, tool, elapsed)
                         because a board card and a rail row are one card in two frames.
                         A turn with no frame yet still says `Working…` rather than dropping out, because
                         dropping it takes the clock with it and a running card with no clock is the one a
                         reader cannot triage. The tool name gives way to an ellipsis before the numbers on its
                         left do: it is the one part of this line that comes back a second later. -->
                    <span v-if="turnInFlight(agent)" class="inline-flex min-w-0 items-center gap-1.5 font-medium text-link">
                        <!-- The glyph follows whichever fact leads: the children when they are the work, else
                             the tool the agent itself is on. -->
                        <Icon :name="(agent.subagents?.running ?? 0) > 0 ? 'users' : activityIcon(agent.activity?.tool)" class="shrink-0 text-2xs" />
                        <span class="min-w-0 truncate">{{ activityText ?? "Working…" }}</span>
                        <span v-if="agent.startedAt !== undefined" class="shrink-0 tabular-nums">{{ formatElapsed(agent.startedAt, now) }}</span>
                    </span>
                </span>
            </div>
        </div>
    </div>
</template>
