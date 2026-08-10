<script setup lang="ts">
import Button from "primevue/button";
import { formatTokens, ProgressRing, useDevice } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { requestLandAgent } from "../composables/agents/agentActions";
import { useRole } from "../composables/sandbox/useRole";
import { errorMessage } from "../composables/useAsyncAction";
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
import { createTitleEdit } from "../composables/agents/titleEdit";
import { markSegments } from "../composables/agents/markSegments";
import { canArchive, useAgents, type FleetAgent } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/providerCatalog";

/* One fleet agent, mock-level hierarchy: provider mark + title + status/attention chip; model · branch meta;
 * a self-hiding stats row (tokens ↑in/out · cost · files · +ins −dels · msgs · context ring); the live
 * activity line while running; time-ago / Completed footer. `now` ticks from AgentsView so every card's
 * elapsed readout advances together without per-card timers. The title renames in place (hover pencil →
 * inline input); the root is a div-button, not a <button>, so the nested pencil/input stay valid HTML.
 *
 * `dense` is the same card in its ROW form, which the board switches on when it stacks its lanes (AgentsView).
 * A stacked lane is as wide as the view, so the blocks that have to stack inside a 280px column run along one
 * wrapping line instead, and a card that cost five rows of height costs two — the difference between five
 * agents on screen and a dozen. Nothing is dropped or added: same DOM, same facts, different flow. */

const props = defineProps<{
    agent: FleetAgent;
    now: number;
    dense?: boolean;
    dragging?: boolean;
    // What the board has in flight against this card, if anything — the action itself, so the button that
    // fired it can say so while the rest of the card only dims (see PendingAction).
    pending?: PendingAction;
    /* This agent's chat is ON SCREEN in the chat panel — one weight, however many columns it is sharing that
     * screen with. A split used to be ranked here (the focused column at full strength, the rest at half), and
     * the rail ranked it the same way; both have stopped, because nothing about a second column makes the
     * first one more real. See RailCard.selected, which this is the board's half of. */
    selected?: boolean;
    // The board's filter, when one is on. `match` is the line the query hit and who said it — the EVIDENCE for
    // this card being in a filtered lane. Absent when the hit was the title (already on the card, and marked
    // below instead). A card that matches for a reason the user can't see is what teaches people to stop
    // trusting a search, so the filter never narrows a lane without this.
    match?: MatchSnippet;
    query?: string;
}>();
const emit = defineEmits<{
    // The click that opened it, when there was one — a modified click asks for a pane rather than the focus.
    open: [event?: MouseEvent];
    review: [];
    resolve: [];
    land: [];
    // The way back after landed work was discarded — a separate event from `land`, because it lands a
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
// — read here as well as inside IdentityTile because the tooltip (the colour's legend) is this card's to say.
const category = computed(() => sessionCategory(props.agent.title));
const router = useRouter();
const lane = computed(() => laneOf(props.agent));
const reason = computed(() => attentionReason(props.agent));
// What the live line says — the shared derivation (agentStatus.activityLine), because the rail's cards carry
// the same line and the two surfaces must never narrate the same turn differently.
const activityText = computed(() => activityLine(props.agent));
// Archiving is offered wherever it means something — which is NOT the same as "the Finished lane" (see
// canArchive): every card whose archive the daemon would take and that isn't holding a question for the user,
// dead ends in the Attention lane included. It sits beside the rename pencil rather than behind the drag
// gesture: this is the routine way to end an agent (nothing is lost — the branch, transcript and counters all
// stay), so it has to be reachable by touch and by keyboard, which a drag to a zone that only exists mid-drag
// never was.
const archivable = computed(() => canArchive(props.agent));
/* THE EXIT FOR A CARD THAT IS NOT AN AGENT — a draft, a send the daemon refused, a turn it has not filed yet
 * (`unregistered`). Every other way off this board addresses an id through the daemon, which has never heard of
 * this one: archive, discard, land and every drop are therefore refused, and what that left behind was a card
 * the user could do NOTHING with except rename it. A broken send would leave one in the Active lane, above the
 * agents actually working, for the life of the sandbox — it survives a reload, because the tab it belongs to does.
 *
 * So the exit it does have — closing the tab — is offered where the card is, instead of only on the chat rail
 * the board never mentions. It takes the archive glyph's slot because the two can never both apply, and asks
 * for no confirmation for the same reason no close in the rail does: with no branch, no worktree and no
 * daemon-side transcript, there is nothing here to lose but the words, and those are in the composer. */
const closable = computed(() => unregistered(props.agent.status));
/* ...and what closing it COSTS, which is the one thing that differs across those standings. A `starting` card's
 * turn is already running daemon-side — the close only stops this window rendering it, and the agent takes its
 * own card the moment the daemon files it — so the draft's reassurance ("this never started") would be a lie
 * about work in flight, and the sentence has to say which of the two the reader is looking at. */
const closeHint = computed(() =>
    props.agent.status === `starting`
        ? `Close — the turn keeps running, and its own card appears once the sandbox has filed it`
        : `Close — this never started, so there is no branch or transcript to keep`,
);
// The drill-in label, or undefined for a draft (nothing to review — a click only focuses the docked chat).
// Desktop only: on mobile the detail IS the chat, so a tap navigates and no separate affordance is needed.
const review = computed(() => (mobile.value ? undefined : reviewAction(props.agent)));

/* MAY THIS CARD HAND ITS CONFLICT BACK TO ITS AGENT? Asked of laneDrop rather than re-derived from
 * status/attention here, because it is the identical question the drop already answers — "would this board ask
 * the agent to resolve?" — and a second reading of it would be free to disagree with the drag on the same card.
 * That also inherits the guards for nothing: a draft has no worktree, a running turn is offered Stop instead
 * (the review panel disables its own button while streaming for the same reason), and an agent blocked on a
 * question is answered rather than rebased.
 *
 * On mobile it is the ONLY way to trigger the resolve — the drag is mouse/pen only by design — and it stays
 * live while the board is filtered, where the drag is deliberately withdrawn (AgentsView.grabCard): a press
 * names its own target, so none of the reasons a filtered board refuses a drop apply to it.
 *
 * ARCHIVED CARDS ARE EXCLUDED. A follow-up message un-archives an agent (the daemon's registry.begin), so this
 * button pressed in the archive would quietly put the card back on the board — a side effect nobody browsing a
 * filing cabinet asked for. Restore first; the conflict will still be there. */
const resolvable = computed(() => props.agent.archivedAt === undefined && dropActionFor(props.agent, `finished`) === `resolve`);
/* WORK THIS AGENT LANDED THAT IS NO LONGER IN THE TREE — the line, and the offer under it (agentStatus.landedAway).
 *
 * Excluded in the archive like every other press on this card, and by the same logic: act on filed-away work
 * by restoring it first.
 *
 * IT TAKES THE READY CARD'S BUTTON RATHER THAN SITTING BESIDE IT, which is why `landable` below yields to it.
 * Both can be true at once — an agent whose first land was discarded and which has since written more — and
 * the two presses are NOT interchangeable there: "Land now" carries the outstanding remainder and would put
 * the newer work in while leaving the discarded half exactly as missing as it was, which is the one outcome
 * nobody wants and the hardest to notice. "Land again" measures from the branch's base and so covers both, so
 * where both apply there is only ever one honest button. */
const away = computed(() => (props.agent.archivedAt === undefined ? landedAway(props.agent) : undefined));
/* THE READY CARD'S PRESS. `ready` exists because the user turned auto-land off, so the one thing this card is
 * waiting for is the deliberate land — offered where the state is announced, as a real button for the same
 * reasons the conflict card's resolve is one (touch, keyboard, a scanning eye). Same wording and mechanics as
 * the review panel's own button: one vocabulary for one action. Excluded in the archive like `resolvable`,
 * and by the same logic — act on filed-away work by restoring it first. */
const landable = computed(() => props.agent.archivedAt === undefined && props.agent.status === `ready` && away.value === undefined);
/* THE PRESS WHILE IT IS STILL OUT. A card mid-action dims, which says the board is doing SOMETHING with it —
 * not which something, and that is the half that matters on the two controls the card fires itself: a button
 * holding its resting label through a round trip reads as a press that didn't take, which is what makes people
 * press it again. So each of them names its own action back, and strictly its own: `pending` carries the
 * action precisely so archiving a `ready` card doesn't leave its Land button spinning over work nobody asked
 * to land. What ENDS the state is the daemon's next roster frame — for a land, a card with no button left. */
const landing = computed(() => props.pending === `land`);
/* THE ROLE SPLIT ON THE READY CARD. A maintainer (and the owner) gets "Land now"; a collaborator gets
 * "Request land" — the same press redirected at the people who may answer it, because the daemon floors the
 * land itself at maintainer. The request is performed HERE rather than emitted: the board is only one of this
 * card's hosts, and an ask that three parents each had to wire would be an ask two of them forgot. A viewer
 * gets neither — watching is the whole grant. */
const { canDrive, canShip } = useRole();
const { refresh: refreshAgents, notice: agentsNotice } = useAgents();
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
/* WHETHER THE STAT ROW HAS ANYTHING TO SAY — every chip in it, which is the whole point of naming it here.
 * The row used to be gated on tokens/cost/diff/turns, and all four are facts a turn only produces when it
 * ENDS: nothing is counted until the result message lands, `turns` moves at finish, the diff after a land. So
 * the two chips that mean something WHILE the agent works — the agents it started and how full its context
 * is — were hidden behind four numbers that do not exist yet, and a first turn that delegated showed its
 * children nowhere. A row gated on a subset of what it renders is a row that hides the rest. */
const stats = computed(
    () =>
        props.agent.inputTokens !== undefined ||
        props.agent.costUsd !== undefined ||
        props.agent.diff !== undefined ||
        props.agent.turns !== undefined ||
        props.agent.subagents !== undefined ||
        context.value !== undefined,
);
const loopLine = computed(() => (props.agent.loop === undefined ? undefined : loopMeta(props.agent.loop)));
/* The card says WHO RUNS IT exactly once. While the tile wears the provider mark (no category yet), this
 * line needs no floor; once the category glyph takes the tile, a card with no recorded model would say the
 * provider nowhere — so the provider lands here, and only then. */
const model = computed(() => {
    if (props.agent.model !== undefined) {
        return modelLabelFor(props.agent.provider, props.agent.model);
    }
    return category.value === undefined ? undefined : providerLabel(props.agent.provider);
});
// A nameless card, named for what it IS: a tab waiting to be typed into, a past conversation whose session
// never earned a title, or an agent whose own naming has yet to land.
const displayTitle = computed(() => {
    if (props.agent.title !== undefined) {
        return props.agent.title;
    }
    if (props.agent.status === `draft`) {
        return `New agent`;
    }
    return props.agent.status === `resumed` ? `Untitled chat` : `Untitled agent`;
});
// The title with the filter's term marked, and one plain run when no filter is on. The matched LINE is marked
// by MatchLine, which also names the speaker — the two are never shown apart.
const titleRuns = computed(() => markSegments(displayTitle.value, props.query?.toLowerCase() ?? ``));
// The unread chip (agentStatus.unreadBadge — the rail's cards wear the same one). "New" already says you have
// not opened it; "Updated" is the flavour that hides a fact — WHEN you last looked — so only it earns a hover.
const unread = computed(() => {
    const badge = unreadBadge(props.agent);
    if (badge === undefined) {
        return undefined;
    }
    return { label: badge.label, hint: badge.seenAt === undefined ? undefined : `Worked since you last opened it — ${relativeTime(badge.seenAt)}` };
});

const edit = createTitleEdit(
    () => props.agent.id,
    () => props.agent.title,
);
// A blur-commit's click on the card body must commit the rename, not also focus the agent. The EVENT rides
// along because a modified click means something else on this board — a column of its own for this agent, or a
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

// The header's quiet icon affordances (rename, archive, restore) — one class string, since they differ only
// in glyph and in the opacity rule the template applies per form factor.
const HOVER_ACTION = `flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted transition-opacity hover:bg-overlay hover:text-content`;

// Offer the card to the board's drag as long as the press starts on the card BODY — the rename pencil and its
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
        class="group flex w-full cursor-pointer select-none flex-col gap-1.5 rounded-lg border p-3 text-left outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary-500/25"
        :class="[
            /* TWO STATES, TWO CHANNELS. `selected` (this card's chat is the one docked) and the Attention lane
               are unrelated facts that were both drawn as a coloured 1px outline plus a faint ring — near
               identical at a glance, and mutually exclusive, so selecting a card that needed the user ERASED
               the very cue that put it there. They are now told apart by WHERE they are drawn, which means they
               also stack: selection is a ring around the whole card plus a lifted surface (a property of the
               user's focus, in the app's own primary), attention is a solid bar down the left edge (a property
               of the agent, in warning — the same colour as its chip on the row above). */
            lane === 'attention' ? 'border-l-[3px] border-l-warning' : '',
            selected ? 'border-primary-500 bg-overlay ring-2 ring-primary-500/50' : 'border-line bg-card hover:border-line-strong',
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
            <!-- The IDENTITY TILE (IdentityTile) — the kind-of-work glyph on a tint of this agent's CATEGORY
                 hue (sessionCategory: the title's action word read as a Conventional Commit type — audits a
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
                        agent.branch === undefined ? 'Archive — the conversation is kept' : 'Archive — the branch, diff and conversation are kept'
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
             that fits a kanban lane. Row (`dense`): the same blocks along one wrapping line — each block already
             shrinks or wraps internally, so the line degrades on its own as the board narrows. -->
        <div :class="dense ? 'flex flex-wrap items-center gap-x-3 gap-y-1' : 'flex flex-col gap-1.5'">
            <!-- WHY this card survived the filter: the line the query hit, and which side of the chat said it.
                 Leads the body, because while a filter is on that is the question the card is being read to
                 answer — and only renders when the hit was NOT the title, which is marked in place above
                 instead (echoing it here would push every other card down the lane to repeat what is already on
                 screen). Two lines before the clamp: a snippet cut to one is usually cut mid-phrase, and a
                 fragment that doesn't contain the sentence is no longer evidence. Full width in the `dense`
                 row form, so it stays a line of prose rather than a column squeezed between two stat blocks. -->
            <p v-if="match !== undefined" class="flex min-w-0 items-start gap-1.5 text-2xs text-muted" :class="dense ? 'w-full' : ''">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <MatchLine :snippet="match" :needle="query?.toLowerCase()" class="line-clamp-2 min-w-0 flex-1 leading-4" />
            </p>

            <!-- WORDS OF THE USER'S STILL SITTING IN THIS CHAT'S COMPOSER (FleetAgent.unsent). Leads the body,
                 above even provenance: everything else on this card is the agent's account of itself, and this
                 one line is the reader's own unfinished business — the only thing here that no one but them can
                 clear. It is the whole reason such a card is on the board at all (see `fleet`, which lifts an
                 ARCHIVED session back onto the lanes for it), so a card that came back without saying why would
                 read as the archive leaking.
                 The composer's own send glyph, in the link hue the board spends on "an offer to act" (the same
                 one Ready-to-land wears) — nothing is wrong here, so none of the warning colours apply. The
                 text itself is deliberately NOT shown: a board is read at a glance, often over someone's
                 shoulder, and a half-written message is the most private thing this app holds. -->
            <p v-if="agent.unsent" class="flex min-w-0 items-center gap-1.5 text-2xs text-link" v-tooltip.top="'You have an unsent message here'">
                <Icon name="send" class="shrink-0 text-2xs" />
                <span class="truncate font-medium">Unsent message</span>
            </p>

            <!-- WHY IT DIED. The daemon carries this only while the card still reads as failed (AgentSummary's
                 `failure`), so no state check belongs here — its presence IS the state. Above provenance and
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

            <div v-if="model !== undefined || agent.branch !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                <span v-if="model !== undefined" class="truncate">{{ model }}</span>
                <template v-if="agent.branch !== undefined">
                    <span v-if="model !== undefined">·</span>
                    <!-- The session name is the only thing on this card anybody needs CHARACTER-EXACT — every
                         other word here is read, not retyped — but it is still a LABEL here, not a control.
                         It briefly was one, and a small target for a rare want, sitting mid-card in the path of
                         the press that focuses the agent, is a target hit by accident more often than on
                         purpose. Copying it is on the right-click menu (AgentsView), where the board keeps the
                         decisions that are made about a card rather than to it. -->
                    <SessionChip :branch="agent.branch" />
                </template>
            </div>

            <div v-if="stats" class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted">
                <!-- No hover labels on this row. Five chips side by side each raising its own box turned a
                     glance across the card's numbers into a strip of pop-ups, and every label was the legend
                     for a glyph the reader had already decoded: the arrow is tokens, the pages are files, the
                     speech bubbles are turns, the ring is context. A stat you cannot name from its icon does
                     not belong in a chip row. -->
                <span v-if="agent.inputTokens !== undefined">
                    <Icon name="arrow-circle-up" class="mr-0.5 text-2xs" />{{ formatTokens(agent.inputTokens)
                    }}<template v-if="agent.outputTokens !== undefined"> / {{ formatTokens(agent.outputTokens) }}</template>
                </span>
                <!-- The card's cost is this agent's lifetime total, read only — the Usage tab still breaks it
                     down by day and model, but reaching it from here put a route change inside the chip row a
                     click aims THROUGH on its way to focusing the agent, and the misfires cost more than the
                     shortcut saved. -->
                <span v-if="agent.costUsd !== undefined">{{ formatCost(agent.costUsd) }}</span>
                <span v-if="agent.diff !== undefined && agent.diff.files > 0">
                    <Icon name="copy" class="mr-0.5 text-2xs" />{{ agent.diff.files }}
                </span>
                <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                    <span class="text-success">+{{ agent.diff.insertions }}</span>
                    <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                </span>
                <span v-if="agent.turns !== undefined && agent.turns > 0"> <Icon name="comments" class="mr-0.5 text-2xs" />{{ agent.turns }} </span>
                <!-- THE AGENTS THIS AGENT STARTED. A card is the answer to "what is this agent up to", and one
                     running five children used to look exactly like one running none. A nested button, like the
                     cost above and for the same reason: the click opens the Subagents area rather than the agent
                     — narrowed to THIS agent's children, because the chip is a claim about one card and a list of
                     everything the sandbox has ever spawned answers a question nobody asked here. The chip counts
                     live-of-total while any are working and settles to the lifetime total once none are — "3 / 5"
                     says something a bare "5" cannot, and only while it is true. -->
                <button
                    v-if="agent.subagents !== undefined"
                    type="button"
                    class="cursor-pointer transition-colors hover:text-content hover:underline"
                    :class="{ 'text-link': agent.subagents.running > 0 }"
                    v-tooltip.top="
                        agent.subagents.running > 0 ? `${agent.subagents.running} of ${agent.subagents.total} still working` : 'Agents it started'
                    "
                    @click.stop="router.push({ name: `subagents`, query: { agent: agent.id } })"
                >
                    <Icon name="users" class="mr-0.5 text-2xs" />{{
                        agent.subagents.running > 0 ? `${agent.subagents.running} / ${agent.subagents.total}` : agent.subagents.total
                    }}
                </button>
                <span v-if="context !== undefined" class="inline-flex items-center gap-1">
                    <ProgressRing :value="context" :class="context >= 80 ? 'text-warning' : 'text-primary-500'" />
                    <span>{{ context }}%</span>
                </span>
            </div>

            <!-- THE LOOP LINE. Above the activity line and never instead of it: the activity says what the
                 agent is doing this second, this says what it is doing it TOWARDS, and a looping agent without
                 the second one is a spinner with no end in sight. Survives the loop's end on purpose — how a
                 loop stopped is the thing the card is read for afterwards. -->
            <p v-if="agent.loop !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs" :class="loopLine?.class">
                <Icon name="repeat" class="shrink-0 text-2xs" :class="loopLine?.spin ? 'animate-spin' : ''" />
                <span class="truncate">{{ loopLine?.text }}</span>
            </p>

            <!-- The live line and the footer both claim the row's leftovers, so a wide board splits them and a
                 narrow one wraps the footer onto its own line rather than shaving the activity to an ellipsis. -->
            <p
                v-if="turnInFlight(agent) && activityText"
                class="flex min-w-0 items-center gap-1.5 text-2xs text-link"
                :class="dense ? 'min-w-32 flex-1' : ''"
            >
                <!-- The glyph follows whichever fact leads the line: the children when they are the work, else
                     the tool the agent itself is on. -->
                <Icon :name="(agent.subagents?.running ?? 0) > 0 ? 'users' : activityIcon(agent.activity?.tool)" class="shrink-0 text-2xs" />
                <span class="truncate">{{ activityText }}</span>
            </p>

            <!-- THE CONFLICTED CARD'S WAY OUT, ON THE CARD. A refused land is the one state on this board that
                 is a decision point rather than a report, and the decision has an obvious first answer: the
                 agent redoes the merge in its own worktree, where a wrong answer costs the user nothing. Until
                 now that answer existed only as a drag to the Finished lane — mouse-and-pen only, gone while
                 the board is filtered, and invisible until you tried it — or one route change away in the
                 review panel, whose button this borrows its exact wording from. One vocabulary for one action.
                 A real button rather than the hover-revealed link below: this is the press the card exists to
                 collect, and an affordance that appears on hover is not one a touch device or a scanning eye
                 ever finds. The mechanics sit UNDER the button as a line of muted prose — the same shape, and
                 the same sentence, the conflict report uses beside its own copy of this button. They were a
                 35-word tooltip, which is what makes the press deliberate enough to skip the drop's
                 confirmation dialog (see useAgentDrag.resolveNow) and so had to be readable without a pointer:
                 hover reaches no touch device, and a paragraph in a box that closes on the first click is not
                 disclosure, it is a formality. -->
            <div v-if="resolvable" class="flex min-w-0 flex-col gap-0.5">
                <Button size="small" class="gap-0 self-start whitespace-nowrap px-2 py-0.5 text-2xs" @click.stop="emit('resolve')">
                    <Icon :name="handingOver ? 'spinner' : 'sparkles'" :spin="handingOver" class="mr-1 text-2xs" />{{
                        handingOver ? "Handing it over…" : "Have the agent resolve it"
                    }}
                </Button>
                <span class="text-2xs leading-snug text-subtle"
                    >It merges in its own worktree — nothing reaches your workspace unless it succeeds.</span
                >
            </div>

            <!-- LANDED WORK THAT IS NO LONGER IN THE TREE. The user discarded it in the Changes panel (or took
                 it back out by hand), and until this line existed the card went on wearing its landed chip over
                 a workspace that held none of it — the one lie on this board the user could not catch, because
                 every other reading here is taken between commits and a discard moves no commit.
                 THE SENTENCE LEADS AND THE BUTTON FOLLOWS, which is the reverse of the two blocks above and the
                 whole point of the block: those are decisions waiting to be made, this is a FACT the card owes
                 the reader whether or not they act on it. The offer under it is deliberately quiet — a bordered
                 text button, not the success-filled primary "Land now" wears — because discarding is very often
                 a rejection, and a board that answers it with a bright green button is arguing with a decision
                 the user already made. Never automatic, for the same reason: nothing re-lands this without the
                 press. The reassurance is not decoration either — "removed from your workspace" reads as work
                 destroyed unless the card says, in the same breath, that the branch still has all of it. -->
            <div v-if="away !== undefined" class="flex min-w-0 flex-col gap-0.5">
                <p class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="undo" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ away.text }}</span>
                </p>
                <button
                    type="button"
                    class="inline-flex shrink-0 items-center self-start whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click.stop="emit('reland')"
                >
                    <Icon :name="relanding ? 'spinner' : 'undo'" :spin="relanding" class="mr-1 text-2xs" />{{ relanding ? "Landing…" : "Land again" }}
                </button>
                <span class="text-2xs leading-snug text-subtle">{{ away.hint }}</span>
            </div>

            <!-- The READY card's press — the deliberate land the user opted into by turning auto-land off (see
                 `landable`). Success-styled with the check glyph exactly like the review panel's "Land now":
                 the two are the same action on the same work, and must read as such. What landing DOES follows
                 it in prose rather than on hover, like the resolve button above. -->
            <div v-if="landable && canShip" class="flex min-w-0 flex-col gap-0.5">
                <!-- The standing ask leads the button it is about: a maintainer reading top-to-bottom meets the
                     reason before the press. -->
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-warning">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }}</span>
                </p>
                <Button size="small" severity="success" class="gap-0 self-start whitespace-nowrap px-2 py-0.5 text-2xs" @click.stop="emit('land')">
                    <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" class="mr-1 text-2xs" />{{ landing ? "Landing…" : "Land now" }}
                </Button>
                <span class="text-2xs leading-snug text-subtle">Arrives as uncommitted changes — your own commit stays the review step.</span>
            </div>

            <!-- The same ready card in a collaborator's hands: the land is a maintainer's press, so the card
                 offers the ask instead — same spot, same size, quieter chrome. Once asked, the card says so
                 and stands down (re-asking only re-stamps the same fact). A viewer gets neither. -->
            <div v-else-if="landable && canDrive" class="flex min-w-0 flex-col gap-0.5">
                <p v-if="landAsk" class="flex min-w-0 items-start gap-1.5 text-2xs leading-snug text-muted">
                    <Icon name="clock" class="mt-0.5 shrink-0 text-2xs" /><span class="min-w-0">{{ landAsk }} — waiting for a maintainer</span>
                </p>
                <template v-else>
                    <Button
                        size="small"
                        severity="secondary"
                        :outlined="true"
                        class="gap-0 self-start whitespace-nowrap px-2 py-0.5 text-2xs"
                        @click.stop="requestLand"
                    >
                        <Icon :name="requesting ? 'spinner' : 'send'" :spin="requesting" class="mr-1 text-2xs" />{{
                            requesting ? "Asking…" : "Request land"
                        }}
                    </Button>
                    <span class="text-2xs leading-snug text-subtle">Landing needs a maintainer — this puts the ask on their board.</span>
                </template>
            </div>

            <div class="flex min-w-0 items-center gap-2 text-2xs text-subtle" :class="dense ? 'min-w-32 flex-1' : ''">
                <!-- The deliberate view-change: a contextual CTA that names its destination, so a plain card click
                     stays a lightweight focus. Persistent when the agent needs the user (attention lane); a quiet
                     hover-reveal otherwise — the rename-pencil pattern. Absent for drafts (review is undefined). -->
                <button
                    v-if="review !== undefined"
                    type="button"
                    class="inline-flex shrink-0 items-center gap-1 rounded font-medium text-link transition-opacity hover:underline"
                    :class="lane === 'attention' ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                    @click.stop="reviewCard"
                >
                    {{ review }}<Icon name="arrow-right" class="text-2xs" />
                </button>
                <!-- Only a card with a registry entry behind it may say the work COMPLETED — that is the
                     daemon's account of a turn, and the client-only standings have none to draw on. A chat
                     reopened from History sits in this lane too (nothing is running, nothing is owed) and knows
                     nothing about how it ended; its chip already says what it is. -->
                <span v-else-if="lane === 'finished' && !unregistered(agent.status)" class="inline-flex shrink-0 items-center gap-1 text-muted">
                    <Icon name="check" class="text-2xs" />Completed
                </span>
                <span class="flex-1"></span>
                <span v-if="agent.startedAt !== undefined" class="shrink-0 text-link">{{ formatElapsed(agent.startedAt, now) }}</span>
                <!-- An archived card is read as a record, so it dates itself by when it LEFT the board — "last
                     active 3d ago" is the same fact its neighbours already show and answers a question nobody in
                     an archive is asking. -->
                <span v-else-if="agent.archivedAt !== undefined" class="shrink-0"> Archived {{ relativeTime(agent.archivedAt) }} </span>
                <span v-else-if="agent.updatedAt > 0" class="shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
            </div>
        </div>
    </div>
</template>
