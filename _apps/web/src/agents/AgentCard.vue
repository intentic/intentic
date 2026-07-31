<script setup lang="ts">
import { cmp, ProgressRing, useDevice } from "@intentic-app/ui";
import { computed } from "vue";
import { useRouter } from "vue-router";
import ProviderLogo from "../chat/ProviderLogo.vue";
import OriginMark from "../components/OriginMark.vue";
import { dropActionFor, type PendingAction } from "../composables/agents/laneDrop";
import {
    activityIcon,
    agentStatusMeta,
    attentionReason,
    contextPct,
    formatCost,
    formatElapsed,
    formatTokens,
    laneOf,
    reviewAction,
} from "../composables/agents/agentStatus";
import { createTitleEdit } from "../composables/agents/titleEdit";
import { markSegments } from "../composables/agents/useAgentFilter";
import { canArchive, type FleetAgent } from "../composables/agents/useAgents";
import { relativeTime } from "../composables/chat/catalog";
import { modelLabelFor } from "../composables/chat/conversation";

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
    selected?: boolean;
    // The board's filter, when one is on. `match` is the line of the user's own prompt the query hit — the
    // EVIDENCE for this card being in a filtered lane. Absent when the hit was the title (already on the card,
    // and marked below instead). A card that matches for a reason the user can't see is what teaches people
    // to stop trusting a search, so the filter never narrows a lane without this.
    match?: string;
    query?: string;
}>();
const emit = defineEmits<{ open: []; review: []; resolve: []; land: []; archive: []; restore: []; grab: [event: PointerEvent, card: HTMLElement] }>();

const { mobile } = useDevice();
const meta = computed(() => agentStatusMeta(props.agent.status));
const router = useRouter();
const lane = computed(() => laneOf(props.agent));
const reason = computed(() => attentionReason(props.agent));
// Archiving is offered wherever it means something — which is NOT the same as "the Finished lane" (see
// canArchive): every card whose archive the daemon would take and that isn't holding a question for the user,
// dead ends in the Attention lane included. It sits beside the rename pencil rather than behind the drag
// gesture: this is the routine way to end an agent (nothing is lost — the branch, transcript and counters all
// stay), so it has to be reachable by touch and by keyboard, which a drag to a zone that only exists mid-drag
// never was.
const archivable = computed(() => canArchive(props.agent));
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
/* THE READY CARD'S PRESS. `ready` exists because the user turned auto-land off, so the one thing this card is
 * waiting for is the deliberate land — offered where the state is announced, as a real button for the same
 * reasons the conflict card's resolve is one (touch, keyboard, a scanning eye). Same wording and mechanics as
 * the review panel's own button: one vocabulary for one action. Excluded in the archive like `resolvable`,
 * and by the same logic — act on filed-away work by restoring it first. */
const landable = computed(() => props.agent.archivedAt === undefined && props.agent.status === `ready`);
/* THE PRESS WHILE IT IS STILL OUT. A card mid-action dims, which says the board is doing SOMETHING with it —
 * not which something, and that is the half that matters on the two controls the card fires itself: a button
 * holding its resting label through a round trip reads as a press that didn't take, which is what makes people
 * press it again. So each of them names its own action back, and strictly its own: `pending` carries the
 * action precisely so archiving a `ready` card doesn't leave its Land button spinning over work nobody asked
 * to land. What ENDS the state is the daemon's next roster frame — for a land, a card with no button left. */
const landing = computed(() => props.pending === `land`);
const handingOver = computed(() => props.pending === `resolve`);
const context = computed(() => contextPct(props.agent.contextTokens, props.agent.contextWindow));
const model = computed(() => (props.agent.model !== undefined ? modelLabelFor(props.agent.provider, props.agent.model) : undefined));
const displayTitle = computed(() => props.agent.title ?? (props.agent.status === `draft` ? `New agent` : `Untitled agent`));
// The title with the filter's term marked, and one plain run when no filter is on.
const titleRuns = computed(() => markSegments(displayTitle.value, props.query?.toLowerCase() ?? ``));
const matchRuns = computed(() => (props.match === undefined ? undefined : markSegments(props.match, props.query?.toLowerCase() ?? ``)));
// The unread chip, in the two flavours worth telling apart: an agent nobody has opened yet is "New"; one you
// HAVE opened that has worked since is "Updated" — with "New" on both, every returning agent reads as a
// stranger. The marker behind it lives on the daemon entry, so opening it anywhere clears it everywhere.
const unread = computed(() =>
    !props.agent.unread
        ? undefined
        : props.agent.seenAt === undefined
          ? { label: `New`, hint: `You haven't opened this agent yet` }
          : { label: `Updated`, hint: `Worked since you last opened it — ${relativeTime(props.agent.seenAt)}` },
);

const edit = createTitleEdit(
    () => props.agent.id,
    () => props.agent.title,
);
// A blur-commit's click on the card body must commit the rename, not also focus the agent.
const openCard = (): void => {
    if (edit.editing || edit.consumeSuppressedOpen()) {
        return;
    }
    emit(`open`);
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
    if (edit.editing || !(event.currentTarget instanceof HTMLElement) || !(event.target instanceof Element)) {
        return;
    }
    if (event.target.closest(`input, button`) !== null) {
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
        @keydown.enter.self.prevent="openCard"
        @keydown.space.self.prevent="openCard"
    >
        <div class="flex items-center gap-2">
            <ProviderLogo :provider="agent.provider" class="shrink-0 text-sm text-muted" />
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
            <!-- WHY this card survived the filter: the line of the user's own prompt the query hit. Leads the
                 body, because while a filter is on that is the question the card is being read to answer —
                 and only renders when the hit was NOT the title, which is marked in place above instead
                 (echoing it here would push every other card down the lane to repeat what is already on
                 screen). Two lines before the clamp: a snippet cut to one is usually cut mid-phrase, and a
                 fragment that doesn't contain the sentence is no longer evidence. Full width in the `dense`
                 row form, so it stays a line of prose rather than a column squeezed between two stat blocks. -->
            <p v-if="matchRuns !== undefined" class="flex min-w-0 items-start gap-1.5 text-2xs text-muted" :class="dense ? 'w-full' : ''">
                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                <span class="line-clamp-2 min-w-0 flex-1 italic leading-4">
                    <span v-for="(run, at) in matchRuns" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''">{{
                        run.text
                    }}</span>
                </span>
            </p>

            <!-- Provenance, ahead of the model/branch line: for an agent the user never started, "who asked for
                 this" outranks what it runs on. Renders nothing for a user-started agent. -->
            <OriginMark :origin="agent.origin" />

            <div v-if="model !== undefined || agent.branch !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
                <span v-if="model !== undefined" class="truncate">{{ model }}</span>
                <template v-if="agent.branch !== undefined">
                    <span v-if="model !== undefined">·</span>
                    <Icon name="code" class="shrink-0 text-2xs" />
                    <span class="truncate font-mono">{{ agent.branch }}</span>
                </template>
            </div>

            <div
                v-if="agent.inputTokens !== undefined || agent.costUsd !== undefined || agent.diff !== undefined || agent.turns !== undefined"
                class="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs text-muted"
            >
                <span v-if="agent.inputTokens !== undefined" v-tooltip.top="'Tokens in / out'">
                    <Icon name="arrow-circle-up" class="mr-0.5 text-2xs" />{{ formatTokens(agent.inputTokens)
                    }}<template v-if="agent.outputTokens !== undefined"> / {{ formatTokens(agent.outputTokens) }}</template>
                </span>
                <!-- The card's cost is this agent's lifetime total; the Usage tab is where it breaks down by day
                     and model. A nested button, so the click opens the breakdown instead of the agent (the drag
                     gesture already excludes buttons). -->
                <button
                    v-if="agent.costUsd !== undefined"
                    type="button"
                    class="cursor-pointer transition-colors hover:text-content hover:underline"
                    v-tooltip.top="'Cost across this agent\'s turns — open the usage breakdown'"
                    @click.stop="router.push({ name: `sandbox`, params: { tab: `usage` }, query: { agent: agent.id } })"
                >
                    {{ formatCost(agent.costUsd) }}
                </button>
                <span v-if="agent.diff !== undefined && agent.diff.files > 0" v-tooltip.top="'Files the agent changed'">
                    <Icon name="copy" class="mr-0.5 text-2xs" />{{ agent.diff.files }}
                </span>
                <span v-if="agent.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)" class="font-mono">
                    <span class="text-success">+{{ agent.diff.insertions }}</span>
                    <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                </span>
                <span v-if="agent.turns !== undefined && agent.turns > 0" v-tooltip.top="'Completed turns'">
                    <Icon name="comments" class="mr-0.5 text-2xs" />{{ agent.turns }}
                </span>
                <span v-if="context !== undefined" class="inline-flex items-center gap-1" v-tooltip.top="'Context window fill'">
                    <ProgressRing :value="context" :class="context >= 80 ? 'text-warning' : 'text-primary-500'" />
                    <span>{{ context }}%</span>
                </span>
            </div>

            <!-- The live line and the footer both claim the row's leftovers, so a wide board splits them and a
                 narrow one wraps the footer onto its own line rather than shaving the activity to an ellipsis. -->
            <p
                v-if="agent.status === 'running' && agent.activity !== undefined"
                class="flex min-w-0 items-center gap-1.5 text-2xs text-link"
                :class="dense ? 'min-w-32 flex-1' : ''"
            >
                <Icon :name="activityIcon(agent.activity.tool)" class="shrink-0 text-2xs" />
                <span class="truncate">{{ agent.activity.todo ?? [agent.activity.tool, agent.activity.target].filter(Boolean).join(" · ") }}</span>
            </p>

            <!-- THE CONFLICTED CARD'S WAY OUT, ON THE CARD. A refused land is the one state on this board that
                 is a decision point rather than a report, and the decision has an obvious first answer: the
                 agent redoes the merge in its own worktree, where a wrong answer costs the user nothing. Until
                 now that answer existed only as a drag to the Finished lane — mouse-and-pen only, gone while
                 the board is filtered, and invisible until you tried it — or one route change away in the
                 review panel, whose button this borrows its exact wording from. One vocabulary for one action.
                 A real button rather than the hover-revealed link below: this is the press the card exists to
                 collect, and an affordance that appears on hover is not one a touch device or a scanning eye
                 ever finds. Its tooltip carries the mechanics the review panel states in prose beside its own
                 copy of this button — which is what makes the press deliberate enough to skip the drop's
                 confirmation dialog (see useAgentDrag.resolveNow). -->
            <div v-if="resolvable" class="flex min-w-0">
                <button
                    type="button"
                    :class="cmp.buttonPrimary('gap-0 whitespace-nowrap px-2 py-0.5 text-2xs')"
                    v-tooltip.top="
                        'Starts a turn: it rebases onto your workspace, resolves in its own worktree, and lands the result. Nothing is written to your workspace unless it succeeds — and you can stop the turn any time.'
                    "
                    @click.stop="emit('resolve')"
                >
                    <Icon :name="handingOver ? 'spinner' : 'sparkles'" :spin="handingOver" class="mr-1 text-2xs" />{{
                        handingOver ? "Handing it over…" : "Have the agent resolve it"
                    }}
                </button>
            </div>

            <!-- The READY card's press — the deliberate land the user opted into by turning auto-land off (see
                 `landable`). Success-styled with the check glyph exactly like the review panel's "Land now":
                 the two are the same action on the same work, and must read as such. -->
            <div v-if="landable" class="flex min-w-0">
                <button
                    type="button"
                    :class="cmp.buttonSuccess('gap-0 whitespace-nowrap px-2 py-0.5 text-2xs')"
                    v-tooltip.top="
                        'Applies this agent\'s finished work to your workspace as uncommitted changes — your own commit stays the review step.'
                    "
                    @click.stop="emit('land')"
                >
                    <Icon :name="landing ? 'spinner' : 'check'" :spin="landing" class="mr-1 text-2xs" />{{ landing ? "Landing…" : "Land now" }}
                </button>
            </div>

            <div class="flex min-w-0 items-center gap-2 text-2xs text-subtle" :class="dense ? 'min-w-32 flex-1' : ''">
                <!-- The deliberate view-change: a contextual CTA that names its destination, so a plain card click
                     stays a lightweight focus. Persistent when the agent needs the user (attention lane); a quiet
                     hover-reveal otherwise — the rename-pencil pattern. Absent for drafts (review is undefined). -->
                <button
                    v-if="review !== undefined"
                    type="button"
                    v-tooltip.top="'Open the review detail (or double-click the card)'"
                    class="inline-flex shrink-0 items-center gap-1 rounded font-medium text-link transition-opacity hover:underline"
                    :class="lane === 'attention' ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100'"
                    @click.stop="reviewCard"
                >
                    {{ review }}<Icon name="arrow-right" class="text-2xs" />
                </button>
                <span v-else-if="lane === 'finished' && agent.status !== 'draft'" class="inline-flex shrink-0 items-center gap-1 text-muted">
                    <Icon name="check" class="text-2xs" />Completed
                </span>
                <span class="flex-1"></span>
                <span v-if="agent.startedAt !== undefined" class="shrink-0 text-link">{{ formatElapsed(agent.startedAt, now) }}</span>
                <!-- An archived card is read as a record, so it dates itself by when it LEFT the board — "last
                     active 3d ago" is the same fact its neighbours already show and answers a question nobody in
                     an archive is asking. -->
                <span v-else-if="agent.archivedAt !== undefined" class="shrink-0" v-tooltip.top="`Last active ${relativeTime(agent.updatedAt)}`">
                    Archived {{ relativeTime(agent.archivedAt) }}
                </span>
                <span v-else-if="agent.updatedAt > 0" class="shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
            </div>
        </div>
    </div>
</template>
