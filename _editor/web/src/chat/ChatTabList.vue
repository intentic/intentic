<script setup lang="ts">
import { cmp, ContextMenu, type IconName, SearchBar } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, watch } from "vue";
import { createTitleEdit } from "../composables/agents/titleEdit";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    attentionReason,
    type FleetLane,
    formatCost,
    turnInFlight,
    unreadBadge,
} from "../composables/agents/agentStatus";
import { sessionCategory } from "../composables/sessionCategory";
import { useNow } from "../composables/useNow";
import { useAgentFilter } from "../composables/agents/useAgentFilter";
import { FINISHED_WINDOW, type FleetAgent, useAgents, windowFinished } from "../composables/agents/useAgents";
import HoverCard from "../components/HoverCard.vue";
import OriginMark from "../components/OriginMark.vue";
import RailCard from "../components/RailCard.vue";
import RailLane from "../components/RailLane.vue";
import WorkflowMark from "../components/WorkflowMark.vue";
import { relativeTime, statusIcon, statusLabel } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { allTabs, finishedTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, toRightOf } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { chatRun, showingRunGraph } from "../composables/chat/chatRun";
import { openRunInChat } from "../composables/chat/openRun";
import {
    insideRun,
    runIdsInLedger,
    runMatches,
    runsInLane,
    runningTitles,
    runsNeedingYou,
    useWorkflowRuns,
} from "../composables/agents/useWorkflowRuns";
import { commandShortcut } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import { providerLabel, type WorkflowRun } from "@intentic/sandbox-contract";

/* THE OPEN CHATS, as the fleet board's three lanes in miniature — the switcher for every conversation this
 * window holds. It has two hosts and is the same list in both: the sheet the docked panel's header drops
 * (ChatTabs), and the rail down the left edge of a popped-out window. It used to be rail-only, while the
 * docked panel wore a row of pill tabs that wrapped to a second line — a strictly worse switcher (a dot and
 * ~28 characters of a title, in rows that reflowed on every open and close) built out of a second set of
 * components. One list, two frames.
 *
 * IT IS THE BOARD'S CARD IN A COLUMN ONE CARD WIDE, and that is a design rule rather than a resemblance —
 * /agents and this list are read minutes apart by the same eye, so anything they draw differently reads as
 * two different products. The card and the lane it lies on are therefore not this file's to draw: they are
 * RailCard and RailLane, which the Subagents area lists its rows with too, and which is where the reasoning
 * about the card's rows, its two selection channels and the lane slab now lives. What "in miniature" costs is
 * only the facts that need width the rail lacks (the branch, the token counters).
 *
 * This file's job is which lanes exist, what goes in them, and what each card knows — below.
 *
 * The list reads the stores and emits verbs rather than writing them: the panel that hosts it is what hands
 * each verb to useChat, exactly as the strip always did. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the right-click menu's Close Others / to the Right / All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal, panes, openBeside, closePane, setPanes } = useChat();
const { agentById, fleet, loadArchived } = useAgents();

const { poppedOut, toggle: togglePopout, overlayTarget } = useChatPopout();

interface OpenChat {
    readonly conversation: Conversation;
    readonly agent: FleetAgent | undefined;
}
const lastActive = (entry: OpenChat): number => entry.agent?.updatedAt ?? 0;

/* --- The filter -------------------------------------------------------------------------------
 * The same field, the same rule and the same evidence as the fleet board's (useAgentFilter): match what the
 * USER wrote — the title, which is their sanitized first prompt, and every later prompt in the transcript.
 * Two search boxes in one product that disagree about what "matches" means is worse than one of them not
 * existing, so both mount the one composable rather than each rolling its own.
 *
 * What differs is the SET. The board filters the fleet; this list holds the OPEN chats, which is a much
 * smaller thing to be looking through — a user asking "where did I say X" is almost never asking only about
 * the eight chats they happen to have open. So the query reaches the whole fleet here too, and everything it
 * finds that ISN'T open lands in a group below the lanes that opens on click. The History popover keeps its
 * own box for browsing; this one is for finding.
 *
 * Its state is per-INSTANCE, which means per-window and per-opening: a query typed on the board must not
 * narrow a pop-out the user isn't looking at.
 */
const {
    query: filterQuery,
    needle,
    active: filtering,
    matches: agentMatches,
    snippetOf,
    archivedMatches,
    sessionMatches,
    searching,
} = useAgentFilter();

/* THE WORKFLOW RUNS, IN THE LANES, exactly as the board draws them — which is this list's founding rule and
 * not a convenience: /agents and this rail are read minutes apart by the same eye, so a thing that appears on
 * one and not the other reads as two different products.
 *
 * IT USED TO BE ONE ROW FOR THE RUN THE PANEL HAPPENED TO BE SHOWING, which made a workflow the only entry
 * here that was a property of the current view rather than of the workspace: it appeared when you opened it
 * and vanished the moment you clicked any other chat. Nothing else in this list behaves that way, and it left
 * a run you had stepped away from with no way back into it short of the board.
 *
 * So they are listed by the run's own lane (laneOfRun — running is active, a failed or overspent one is
 * attention, the rest finished), for as long as the ledger holds them. `chatRun` decides only which row reads
 * as SELECTED, which is the same job the active conversation does for the rows below. */
const { runs: workflowRuns } = useWorkflowRuns();
/* The Finished lane's cap, declared here because the RUNS obey it too — see the long note on the window below,
 * which is where the rest of the reasoning lives. Lifted by a filter and by the row's own expand. */
const showAllFinished = ref(false);
const windowed = computed(() => !filtering.value && !showAllFinished.value);
/* The same lane rule the board uses, including a step's question putting its RUN in Attention — two lists that
 * disagreed about where a run belongs would be the resemblance breaking exactly where it matters.
 *
 * A QUERY NARROWS THE RUNS, it no longer drops them: a run answers for its steps now (runMatches), so dropping
 * the rows would take the whole workflow off a filtered rail with nothing left standing for it. An ARCHIVED
 * run is off this list outright — the rail lists what is open, and the archive is the board's column.
 */
const runsIn = (lane: FleetLane): WorkflowRun[] =>
    runsInLane(
        workflowRuns.value.filter(
            (run) => run.archivedAt === undefined && (!filtering.value || runMatches(run, needle.value, fleet.value, agentMatches)),
        ),
        lane,
        windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY,
        runsNeedingYou(fleet.value),
    );
// A run's row reads as selected only while its DIAGRAM is the thing on screen. In the run's sessions the
// focused chat's own row wears that, and two rows claiming it would be the list contradicting itself. The
// panel's own predicate rather than a second reading of the mode: a run being FOLLOWED draws its diagram too,
// for as long as it has nothing live to put in the panes, and this row has to say so during that window.
const runOnScreen = (run: WorkflowRun): boolean => chatRun.value?.runId === run.runId && showingRunGraph(run, chatRun.value, panes.value);

// A chat with no fleet entry (a plain conversation, or the roster briefly down) has no transcript the daemon
// can search under an agent id, so it is matched on what this browser holds: its title and its own messages —
// both sides of them, which is the rule everywhere else (see useAgentFilter). A `notice` row is neither side.
const tabMatches = (entry: OpenChat): boolean => {
    if (!filtering.value) {
        return true;
    }
    if (entry.agent !== undefined) {
        return agentMatches(entry.agent);
    }
    const title = entry.conversation.title.value;
    return (
        title?.toLowerCase().includes(needle.value) === true ||
        entry.conversation.messages.value.some((message) => message.role !== `notice` && message.text.toLowerCase().includes(needle.value))
    );
};

/* A RUN'S STEPS ARE INSIDE ITS ROW, not beside it — the same rule the fleet board follows, for the reason this
 * list exists at all: it IS the board one card wide, and a workflow that collapsed into one row there while
 * spilling five chats here would be two answers to "what am I looking at".
 *
 * The steps are still OPEN (the run's own row put them on screen, and the panes are showing them); what they
 * are not is separately listed. The run's row is how you get back to them, through its diagram.
 *
 * Gated on the LEDGER, exactly as the board gates it (insideRun says why): a run's row is somewhere for as
 * long as the ledger holds it, and every other reading — "is it drawn", "did the query keep it" — turned a
 * filtered rail back into five loose chats. Only a run that has rolled off the ledger releases them, because
 * then nothing stands for them and hiding a chat nothing else shows is worse than showing it twice.
 */
const lanes = computed<Record<FleetLane, OpenChat[]>>(() => {
    const grouped: Record<FleetLane, OpenChat[]> = { attention: [], active: [], finished: [] };
    const ledger = runIdsInLedger(workflowRuns.value);
    for (const conversation of conversations.value) {
        const agent = agentById(conversation.conversationId);
        if (agent !== undefined && insideRun(agent, ledger)) {
            continue;
        }
        grouped[laneOfTab(conversation, agent)].push({ conversation, agent });
    }
    // The board's own orderings (useAgents.lanes): fresh drafts lead Active, then turn start — fixed for the
    // turn's life, so a running card holds its slot; the other two lanes read newest-first.
    grouped.active.sort(
        (a, b) =>
            Number(b.agent?.status === `draft`) - Number(a.agent?.status === `draft`) ||
            (a.agent?.startedAt ?? lastActive(a)) - (b.agent?.startedAt ?? lastActive(b)),
    );
    grouped.attention.sort((a, b) => lastActive(b) - lastActive(a));
    // ...and Finished leads with the chats holding words that never went out, for the board's own reason: this
    // lane windows too (below), and a half-written message must not be what falls behind the fold.
    grouped.finished.sort((a, b) => Number(b.conversation.unsent.value) - Number(a.conversation.unsent.value) || lastActive(b) - lastActive(a));
    return grouped;
});
const LANES: readonly { key: FleetLane; label: string; dot: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning` },
    { key: `active`, label: `Active`, dot: `bg-success` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong` },
];

/* WHICH LANES ARE DRAWN AT ALL — a projection, never a `v-show` on all three, and that is a correctness rule
 * rather than a preference. `LANES` is a compile-time constant, so `v-for` over it compiles to a STABLE
 * fragment whose <section>s carry no patch flag: Vue patches their CHILDREN through the block tree and never
 * patches the sections themselves. A directive on one — `v-show`, which writes `display` from its `updated`
 * hook — is therefore applied once at mount and never again, and the lane's visibility freezes in whatever
 * shape it had then.
 *
 * That is invisible docked, where this list is a sheet that mounts on every open. The popped-out rail is
 * mounted once and lives for hours, and it is where the bug landed: the lanes froze as they were when the
 * window opened, so a chat opened from the fleet board arrived in a section that was still `display:none` and
 * the rail sat there looking empty while the panel beside it had the conversation open — the "the popped-out
 * chat stopped reacting to what I select" report. For the same reason a lane section must not grow a
 * directive, a `ref` or a dynamic prop: it would be stale out there in exactly the same way. */
// A lane holding only a workflow run is not empty. Without the second half, a run in a lane with no chats in
// it was listed into a section that is never drawn.
const occupiedLanes = computed(() => LANES.filter((lane) => lanes.value[lane.key].length > 0 || runsIn(lane.key).length > 0));

/* --- The Finished window ------------------------------------------------------------------------
 * THE BOARD'S CAP, ON THE BOARD'S OWN LANE — windowFinished, the same function /agents runs (see the note on
 * it). Attention and Active are self-emptying: a card leaves them the moment its turn settles. Finished is the
 * terminal shelf, so without a cap it is the one lane that only ever grows, and this list is the surface where
 * that hurts most — the docked sheet is dismissed between uses, but the popped-out rail is mounted once and
 * read for hours, so its Finished lane was a column of a hundred landed agents by the end of a working day
 * while the board beside it stayed six deep.
 *
 * The window is a cap on BROWSING, not a close: every chat is still open, still cycled by Alt+PageUp/Down and
 * still one click away behind the row. What actually keeps the list short is the retention sweep now closing
 * what it retires (useChat.closeRetired) and "Clear" below; this is what keeps the lane readable in between.
 *
 * Lifted by a FILTER (a result set is not a browsing list — hiding four of a query's six hits behind a row
 * would be the list deciding which of the user's own matches they meant) and by the row's own expand. The
 * ACTIVE chat is pinned in whatever its age, exactly as the board pins the card it has selected: this list is
 * the switcher for the panel beside it, and a switcher that drops the row for the thing it is showing reads as
 * having lost the conversation. The two refs it is made of are declared up beside the runs, which cap on the
 * same switch. */
const finishedWindow = computed(() =>
    windowFinished(lanes.value.finished, windowed.value ? activeId.value : undefined, (entry) => entry.conversation.conversationId),
);
// The runs the same window capped are part of this number, because a hidden run now takes its chats into
// hiding with it — leaving a whole workflow behind a row that does not count it is the one thing a browsing
// cap must never do.
const hiddenRuns = computed(
    () =>
        runsInLane(
            workflowRuns.value.filter((run) => run.archivedAt === undefined),
            `finished`,
            Number.POSITIVE_INFINITY,
            runsNeedingYou(fleet.value),
        ).length - runsIn(`finished`).length,
);
const hiddenFinished = computed(() => finishedWindow.value.hidden + hiddenRuns.value);

// A lane's visible chats, and how many of its own it is showing. Same `n of m` the board's lane headers carry,
// for the same reason: a lane that silently shrinks is a lane that has stopped saying anything. The denominator
// is the LANE, not the window — the row beneath the cards is what accounts for the difference.
const cardsIn = (lane: FleetLane): OpenChat[] => {
    const source = lane === `finished` && windowed.value ? finishedWindow.value.shown : lanes.value[lane];
    return source.filter(tabMatches);
};
// A run counts as the one ROW it is, on both sides — its steps are inside that row, not beside it, and a lane
// reading "0 of 3" with a workflow drawn under the header is the count calling the row beneath it a mistake.
const heldIn = (lane: FleetLane): number =>
    lanes.value[lane].length +
    runsInLane(
        workflowRuns.value.filter((run) => run.archivedAt === undefined),
        lane,
        Number.POSITIVE_INFINITY,
        runsNeedingYou(fleet.value),
    ).length;
const countIn = (lane: FleetLane): string =>
    filtering.value ? `${cardsIn(lane).length + runsIn(lane).length} of ${heldIn(lane)}` : String(heldIn(lane));

/* The card's status glyph, in the trailing slot of the title row — AgentCard's slot for it, at AgentCard's
 * size. Fleet-carded chats read the agent's own status (the richer machine: landed, conflict…); a plain chat
 * degrades to what its conversation is doing right now, through the same statusIcon the panel's header draws.
 *
 * Returned ready to `v-bind` onto the Icon, because the template needs the whole of it at once and a card that
 * asked for its status four times (name, spin, class, label) recomputed it four times. */
const statusOf = (entry: OpenChat): { name: IconName; spin?: boolean; class: string; "aria-label": string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { name: meta.icon, spin: meta.spin, class: `text-xs ${meta.class}`, "aria-label": meta.label };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { name: icon.name, spin: icon.spin, class: `text-xs ${icon.class}`, "aria-label": statusLabel(status) };
};

/* --- What the card knows ------------------------------------------------------------------------------
 * THE FLEET ENTRY IS THE BEST SOURCE, NOT THE ONLY ONE. Every number on this card used to be read straight
 * off the FleetAgent behind one `v-if="agent !== undefined"`, which made the card all-or-nothing: a chat the
 * roster could not resolve collapsed to a bare title over a grey dot — no model, no cost, no count, nothing —
 * and a rail of them read as a list of dead links.
 *
 * And "cannot resolve" is a NORMAL state, not a broken one. The roster carries live agents only: the daemon's
 * retention sweep files finished ones away (archive.ts), the archive half is pull-only, and a conversation
 * opened from History may have outlived its registry entry altogether. Meanwhile the browser is holding a
 * Conversation for every one of these tabs, and that object knows what it is running on, what it has spent
 * here and how much has been said — so the card asks the agent first and the conversation second, and only
 * the facts NEITHER of them holds (the diff, the daemon's cross-device age, unread) are agent-only.
 *
 * The conversation's figures are this TAB's own tally, so they are rendered only when they are non-zero: a
 * chat restored from history has streamed nothing here, and printing `$0.00` under it would be the card
 * inventing a fact rather than lacking one. */

// The model, as the label the pickers use — worth a word the moment a fleet stops being one model deep (an
// Opus session next to a Codex one is a real difference in what the card will cost and how it behaves). The
// card says WHO RUNS IT exactly once — AgentCard's rule: while the tile wears the provider mark (no category
// yet) this line needs no floor, and once the category glyph takes the tile, a card with no recorded model
// says the provider here instead. `activeModel` is what the last turn actually ran on; `model` is what the
// composer would send next, which is the honest answer for a chat that has not run one here.
const modelOf = (entry: OpenChat): string | undefined => {
    const { agent, conversation } = entry;
    const provider = agent?.provider ?? conversation.provider.value;
    const model = agent?.model ?? conversation.activeModel.value ?? conversation.model.value;
    if (model !== null && model !== ``) {
        return modelLabelFor(provider, model);
    }
    return sessionCategory(tabLabel(conversation)) === undefined ? undefined : providerLabel(provider);
};

const costOf = (entry: OpenChat): number | undefined =>
    entry.agent?.costUsd ?? (entry.conversation.costUsd.value > 0 ? entry.conversation.costUsd.value : undefined);

// Completed turns. The registry counts them across every device; a conversation this browser holds can count
// the prompts in its own transcript, which is the same number whenever this tab saw the whole conversation.
const turnsOf = (entry: OpenChat): number | undefined => {
    const turns = entry.agent?.turns ?? entry.conversation.messages.value.filter((message) => message.role === `user`).length;
    return turns > 0 ? turns : undefined;
};

/* THE LIVE LINE'S CONTENT, from whichever half is watching the turn. The registry's activity frames say what
 * the tool is doing and are the richer reading; a conversation streaming a turn the roster hasn't caught up
 * with (or has retired) still knows that it is streaming and when it started, which is the whole point of the
 * line — a working card must be findable in a column of stopped ones even when the join is cold. */
const liveOf = (entry: OpenChat): { icon: IconName; text: string; since: number | undefined } | undefined => {
    const { agent, conversation } = entry;
    if (agent !== undefined && turnInFlight(agent)) {
        return {
            icon: (agent.subagents?.running ?? 0) > 0 ? `users` : activityIcon(agent.activity?.tool),
            text: activityLine(agent) ?? `Working…`,
            since: agent.startedAt,
        };
    }
    if (conversation.streaming.value) {
        return { icon: activityIcon(undefined), text: `Working…`, since: conversation.turnStartedAt.value };
    }
    return undefined;
};

/* HAS THE CARD'S SECOND LINE ANYTHING TO SAY? A fresh draft has no numbers, no age, no marks and no model, so
 * the row would render as an empty strip under its title — which is exactly what the old card did, leaving a
 * lone provider glyph floating on a line of its own. Asked per card rather than assumed from the join. */
const hasMeta = (entry: OpenChat): boolean =>
    (entry.agent !== undefined &&
        (attentionReason(entry.agent) !== undefined ||
            unreadBadge(entry.agent) !== undefined ||
            (entry.agent.diff !== undefined && (entry.agent.diff.insertions > 0 || entry.agent.diff.deletions > 0)) ||
            entry.agent.updatedAt > 0)) ||
    entry.conversation.unsent.value ||
    originOf(entry.conversation) !== undefined ||
    isArchived(entry.conversation) ||
    modelOf(entry) !== undefined ||
    costOf(entry) !== undefined ||
    turnsOf(entry) !== undefined;

// The card's hover preview note: what kind of work the tile's colour says this is (the legend for the tint —
// a colour code nothing ever spells out is one the user has to break), the model (with the provider as its
// floor) and the UNTRUNCATED live activity — the card's own meta line clamps both, so the hover is where a
// long command or model name is read whole.
const noteOf = (entry: OpenChat): string | undefined => {
    const parts = [
        sessionCategory(tabLabel(entry.conversation))?.type,
        modelOf(entry) ?? providerLabel(entry.agent?.provider ?? entry.conversation.provider.value),
        entry.agent === undefined ? undefined : activityLine(entry.agent),
    ].filter((part) => part !== undefined && part !== ``);
    return parts.length === 0 ? undefined : parts.join(` · `);
};

/* What the query found that ISN'T open in this window — the whole point of the filter reaching past its own
 * list. Live fleet agents first (the likeliest thing to want), then the archive, each as a row that opens the
 * conversation. Conversations no agent owns come from `sessionMatches` and open the same way.
 *
 * The archive is off the live roster, so its contents have to be asked for; the board does that at mount, but
 * a user who never opened /agents has no reason to have paid for it. Asked for once, the first time a query
 * is typed here.
 */
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
const notOpen = computed<FleetAgent[]>(() => {
    if (!filtering.value) {
        return [];
    }
    return [...fleet.value.filter((agent) => agentMatches(agent)), ...archivedMatches.value].filter((agent) => !openIds.value.has(agent.id));
});
const notOpenCount = computed(() => notOpen.value.length + sessionMatches.value.length);

/* THE ARCHIVE IS ASKED FOR WHENEVER A CHAT NEEDS IT, not once at mount. The open chats a long session
 * accumulates are mostly agents the daemon's retention sweep has already ARCHIVED — off the live roster,
 * findable by agentById only once loadArchived has run. A mount-time load only covers what was already filed
 * away when the window opened: this list stays up for hours while the sweep keeps running underneath it, and
 * every agent it retires after that turned its card into a bare title over a grey dot.
 *
 * So the trigger is the SYMPTOM: a conversation the fleet has registered (`registered` latches, so this is
 * never a draft) that neither half of the join can resolve. Probed once per id — the set below is the memory
 * that keeps a genuinely gone agent, which no fetch will ever produce, from asking again on every frame. */
const probed = new Set<string>();
watch(
    () => conversations.value.filter((conversation) => conversation.registered.value && agentById(conversation.conversationId) === undefined),
    (unresolved) => {
        const fresh = unresolved.filter((conversation) => !probed.has(conversation.conversationId));
        if (fresh.length === 0) {
            return;
        }
        for (const conversation of fresh) {
            probed.add(conversation.conversationId);
        }
        void loadArchived();
    },
    { immediate: true },
);
// And once more whenever a search STARTS, because the query reaches past the open chats into the archive
// (archivedMatches) — a hit sitting one click away that the filter reports as "no matches" is the failure a
// search is least forgiven for, and no card being unresolved is exactly when the probe above stays quiet.
watch(filtering, (on) => {
    if (on) {
        void loadArchived();
    }
});

// The shared clock ticks every running card's elapsed readout together — armed while this list is on screen,
// which for the docked sheet means only while it is open.
const now = useNow();

/* --- Keeping the active card in view ------------------------------------------------------------
 * The list scrolls, and the chat it is pointing at is almost always selected from somewhere else — a card on
 * the fleet board, a history row, Alt+PageUp/Down, a brand-new agent appended to the end. A list that opens
 * scrolled past the card it is highlighting reads as one that lost your place. `nearest` moves the least it
 * can and no-ops on a card already visible, so clicking a card in the list never shifts it under the pointer.
 *
 * Two triggers, because the id is not the whole story: activeId covers a focus that MOVED, and the store's
 * tabReveal counter covers a focus asked for again (the board card of the chat you are already in, clicked
 * while this list is scrolled elsewhere). `immediate` covers the third case, which is the docked one: the
 * sheet mounts on open, and the card it must show is whichever was already active. */
const scroller = ref<HTMLElement | null>(null);
watch(
    [activeId, tabReveal],
    async () => {
        await nextTick();
        scroller.value?.querySelector(`[data-chat-tab="${activeId.value}"]`)?.scrollIntoView({ block: `nearest` });
    },
    { immediate: true },
);

/* --- Inline rename ------------------------------------------------------------------------------
 * One edit state for the whole list (only one card renames at a time), pointed at a card by `renamingId`. The
 * write goes through the same createTitleEdit the fleet cards use, so a chat renamed here renames the agent
 * registry entry too — the card here and the card on /agents are one thing under two skins. Reached by
 * double-clicking a card or through its menu; F2 is the panel header's, and renames the ACTIVE chat there. */
const renamingId = ref<string | undefined>(undefined);
const renaming = computed(() => conversations.value.find((conversation) => conversation.conversationId === renamingId.value));
const edit = createTitleEdit(
    () => renaming.value?.conversationId ?? ``,
    () => renaming.value?.title.value ?? undefined,
);
const beginRename = (id: string): void => {
    renamingId.value = id;
    edit.begin();
};
// F2 in a POPPED-OUT window has no header to rename in — the rail is the whole surface out there — so the host
// hands the press down to the card it names. Docked, the header renames itself and never calls this.
defineExpose({ beginRename });

// --- Hover preview --------------------------------------------------------------------------------
// A card clamps its title to two lines, on top of the 40-char derivation, so hovering reveals the FULL derived
// title and, under it, the first message that title was derived from. The card itself is the shared HoverCard
// — the Changes panel's agent chips raise the same one for the same session.
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showPreview = (event: MouseEvent, entry: OpenChat): void => {
    const firstUser = entry.conversation.messages.value.find((message) => message.role === `user`);
    // A fresh "New chat"/"New agent" card has neither, and the preview declines to open on empty content.
    hoverCard.value?.show(event, { title: entry.conversation.title.value ?? undefined, note: noteOf(entry), body: firstUser?.text });
};
const hidePreview = (): void => {
    hoverCard.value?.hide();
};

/* --- Picking chats into panes -------------------------------------------------------------------
 * The terminal strip's gesture, on the surface that is this panel's equivalent of it (TerminalPanel's
 * onSegmentClick): a plain click SWITCHES, Ctrl/Cmd+click toggles a chat into a column of its own beside the
 * others, and Shift+click takes the run between the anchor and the row — all three landing on the pane verbs
 * in useChat. Learning it once on either strip is learning it for both, which is the whole reason the
 * gestures are the same to the letter rather than merely similar.
 *
 * The MENU is what makes it discoverable; the modifiers are the accelerator for whoever already knows. */
const showing = (id: string): boolean => panes.value.includes(id);
// More than one chat has a column, so a row can say "on screen" without that being the same claim as "focused".
const split = computed(() => panes.value.length > 1);
// Panes exist in the POP-OUT window only — the docked column is ~22rem, and a second chat in it would be two
// unusable slivers (ChatPanel holds that rule). So the gestures and the rows that teach them are offered where
// they do something, rather than sitting in the docked sheet quietly doing nothing.
const paneable = computed(() => poppedOut.value);

// The rows as the eye reads them, top to bottom, across the lanes that are drawn — what a Shift+range means.
// The lanes SORT (by status, then recency), so this is the list's own order rather than the tab order; a range
// is "these rows", which is what the user is pointing at.
const rowOrder = computed<string[]>(() => occupiedLanes.value.flatMap((lane) => cardsIn(lane.key).map((entry) => entry.conversation.conversationId)));
const anchor = ref<string>();

const onRowClick = (event: MouseEvent, id: string): void => {
    if (!paneable.value) {
        anchor.value = id;
        emit(`select`, id);
        return;
    }
    if (event.shiftKey) {
        const order = rowOrder.value;
        const from = order.indexOf(anchor.value ?? activeId.value);
        const to = order.indexOf(id);
        if (to !== -1) {
            setPanes(from === -1 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1));
        }
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        anchor.value = id;
        // Toggle: a chat that already has a column gives it back, one that doesn't takes one beside the focus.
        if (showing(id) && split.value) {
            closePane(id);
            return;
        }
        openBeside(id);
        return;
    }
    anchor.value = id;
    emit(`select`, id);
};

/* --- Right-click menu -----------------------------------------------------------------------------
 * The same close set the workspace's file tabs carry, plus this list's own rename and the pop-out toggle. It
 * acts on the RIGHT-CLICKED card (`menuTabId`), never on the active one — the split the workspace makes, and
 * the reason the keyboard commands (which act on the active chat) live with the header rather than here. */
const tabMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuTabId = ref<string>();

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined || !conversations.value.some((conversation) => conversation.conversationId === id)) {
        return []; // no card named, or the right-clicked one closed under the open menu
    }
    const others = othersOf(id);
    const toRight = toRightOf(id);
    const finished = finishedTabs();
    return [
        { label: `Rename`, icon: `pencil`, shortcut: commandShortcut(`chat.rename`), command: () => beginRename(id) },
        { separator: true },
        /* The pane pair. "Open Beside" is the discoverable half of Ctrl/Cmd+click, and it names the result
         * rather than the mechanism — a column of its own next to the one you are in. Its opposite takes the
         * column back WITHOUT closing the chat, which is the distinction the two rows have to carry between
         * them: the Close block below ends the conversation's place in this window, this one only ends its
         * share of the screen. Offered only where there is room to use it (see `paneable`). */
        ...(paneable.value
            ? [
                  // No glyph on either, like the terminal's own Split row — and pointedly not the × the Close
                  // block wears, which would say this ends the chat.
                  showing(id) && split.value
                      ? { label: `Close Pane`, shortcut: commandShortcut(`chat.closePane`), command: () => closePane(id) }
                      : { label: `Open Beside`, shortcut: commandShortcut(`chat.splitView`), command: () => openBeside(id) },
                  { separator: true },
              ]
            : []),
        { label: `Close`, icon: `times`, shortcut: commandShortcut(`chat.closeTab`), command: () => emit(`close`, new Set([id])) },
        {
            label: `Close Others`,
            disabled: others.size === 0,
            shortcut: commandShortcut(`chat.closeOtherTabs`),
            command: () => emit(`close`, others),
        },
        {
            label: `Close to the Right`,
            disabled: toRight.size === 0,
            shortcut: commandShortcut(`chat.closeTabsToRight`),
            command: () => emit(`close`, toRight),
        },
        { separator: true },
        {
            label: `Close Finished`,
            disabled: finished.size === 0,
            shortcut: commandShortcut(`chat.closeFinishedTabs`),
            command: () => emit(`close`, finished),
        },
        { label: `Close All`, shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
        { separator: true },
        {
            label: poppedOut.value ? `Dock chat back` : `Move chat into new window`,
            shortcut: commandShortcut(`chat.togglePopout`),
            command: togglePopout,
        },
    ];
});

const openTabMenu = (id: string, event: Event): void => {
    // The pointer stays on the card, so the hover preview would never leave on its own — and it floats exactly
    // where the menu is about to open.
    hidePreview();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// Close a chat without selecting it (the × sits inside the card button, so stop the bubble).
const closeTab = (event: Event, id: string): void => {
    event.stopPropagation();
    emit(`close`, new Set([id]));
};
</script>

<template>
    <div class="flex min-h-0 flex-col gap-1.5">
        <!-- Pinned above the list: narrow it (filter) → pick one (the lanes) → and, when the query reaches
             past what is open, the "Not open" group at the foot. -->
        <SearchBar
            v-model="filterQuery"
            variant="field"
            clearable
            :busy="searching"
            aria-label="Filter chats by your messages"
            placeholder="Filter by your messages…"
            class="shrink-0"
        />
        <div ref="scroller" class="scrollbar-thin flex min-h-0 flex-1 flex-col items-stretch gap-3 overflow-y-auto">
            <!-- A lane with nothing in it is not drawn at all (occupiedLanes — and see the note there before
                 reaching for `v-show` here); a lane the FILTER emptied keeps its header and says so, so the
                 list doesn't reshuffle under the cursor mid-keystroke. -->
            <RailLane v-for="lane in occupiedLanes" :key="lane.key" :label="lane.label" :dot="lane.dot" :count="countIn(lane.key)">
                <!-- "CLEAR", in the slot and the word the board's Finished lane uses — the same act on the
                     same lane, at the scale the lane is at: there it archives the agents, here it closes
                     their chats. Both are lossless and neither asks, which is what earns the one-press
                     treatment; the tooltip names where the chats go. It was reachable only through a card's
                     right-click menu before, which is a hunt for a target to perform an action that has no
                     target — the lane is the target, so the lane's header is where it belongs.
                     Gone while filtering, exactly as the board's is: this closes the WHOLE lane, and
                     offering it above a lane reading "1 of 12" is offering a bulk action whose scope is not
                     the one on screen. -->
                <template #actions>
                    <button
                        v-if="lane.key === 'finished' && !filtering"
                        type="button"
                        :aria-label="`Close all ${lanes.finished.length} finished chats`"
                        v-tooltip.bottom="`Close all ${lanes.finished.length} — they stay in Past chats`"
                        class="shrink-0 rounded px-1 py-px text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="emit('close', finishedTabs())"
                    >
                        Clear
                    </button>
                </template>
                <!-- THE LANE'S WORKFLOW RUNS, above its chats and dashed like their card on the board: a run
                     is the container of several of the rows beneath it, not one of them. Clicking one is the
                     board card's own press (openRunInChat) — its live sessions into the panes, or its diagram
                     when nothing is live — so the two doors into a run cannot behave differently. -->
                <div v-if="runsIn(lane.key).length > 0" class="mb-1.5 flex min-w-0 flex-col gap-1.5">
                    <RailCard
                        v-for="run in runsIn(lane.key)"
                        :key="run.runId"
                        :title="run.workflow.name"
                        icon="sitemap"
                        dashed
                        :selected="runOnScreen(run)"
                        :aria-label="`Open the workflow run ${run.workflow.name}`"
                        @click="void openRunInChat(run)"
                    >
                        <template #meta>
                            <span class="min-w-0 truncate text-subtle">
                                {{ run.steps.filter((step) => step.state === `done`).length }}/{{ run.steps.length }} steps<template
                                    v-if="runningTitles(run).length > 0"
                                >
                                    · {{ runningTitles(run).join(` · `) }}</template
                                >
                            </span>
                        </template>
                    </RailCard>
                </div>
                <p v-if="cardsIn(lane.key).length === 0 && runsIn(lane.key).length === 0" class="px-2.5 pb-1.5 text-2xs text-subtle">No matches</p>
                <div v-else-if="cardsIn(lane.key).length > 0" class="flex min-w-0 flex-col gap-1.5">
                    <template v-for="{ conversation: c, agent } in cardsIn(lane.key)" :key="c.conversationId">
                        <!-- Renaming REPLACES the card rather than nesting a field inside it: an input in a
                             button is neither valid markup nor a usable caret. Enter commits, Esc cancels, blur
                             commits, an empty or unchanged name silently cancels — the WorkspaceTree
                             convention, via createTitleEdit. -->
                        <input
                            v-if="edit.editing && renamingId === c.conversationId"
                            v-model="edit.draft"
                            type="text"
                            maxlength="80"
                            aria-label="Chat title"
                            :placeholder="c.isolated.value ? 'New agent' : 'New chat'"
                            class="w-full shrink-0 select-text rounded-lg bg-overlay px-2.5 py-2 text-xs font-semibold text-content outline-none ring-1 ring-primary-500/50 placeholder:font-normal placeholder:text-subtle"
                            @keydown.enter.stop.prevent="edit.commit()"
                            @keydown.esc.stop.prevent="edit.cancel()"
                            @blur="edit.blurCommit()"
                            @vue:mounted="edit.focusInput"
                        />
                        <RailCard
                            v-else
                            :data-chat-tab="c.conversationId"
                            :title="tabLabel(c)"
                            :needle="needle"
                            :provider="agent?.provider ?? c.provider.value"
                            :status="statusOf({ conversation: c, agent })"
                            :live="liveOf({ conversation: c, agent })"
                            :now="now"
                            :selected="activeId === c.conversationId"
                            :showing="split && activeId !== c.conversationId && showing(c.conversationId)"
                            :attention="lane.key === 'attention'"
                            :snippet="agent === undefined ? undefined : snippetOf(agent)"
                            @click="onRowClick($event, c.conversationId)"
                            @dblclick.prevent.stop="beginRename(c.conversationId)"
                            @contextmenu.prevent.stop="openTabMenu(c.conversationId, $event)"
                            @mouseenter="showPreview($event, { conversation: c, agent })"
                            @mouseleave="hidePreview"
                        >
                            <template #trailing>
                                <PresenceAvatars
                                    v-if="c.session.value !== undefined"
                                    :members="viewersOfSession(c.session.value.id)"
                                    label="in this chat"
                                />
                                <!-- The × is a HIT TARGET carrying the glyph, not the glyph itself: at text-2xs
                                     the svg is an 11px square, and a click that misses it lands on the card —
                                     which, on the card it is closing, selects an already-selected chat and so
                                     reads as a close that did nothing. It takes the slot BESIDE the status
                                     glyph on hover — AgentCard's rename/archive pattern — rather than the
                                     status glyph's own, so nothing about the card moves as the pointer
                                     crosses it. -->
                                <span
                                    v-if="conversations.length > 1"
                                    role="button"
                                    aria-label="Close chat"
                                    class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                                    @click="closeTab($event, c.conversationId)"
                                >
                                    <Icon name="times" class="text-2xs" />
                                </span>
                            </template>
                            <!-- The crucial facts, one wrapping line at the board's own picks: why it needs
                                 you (or that it's unread), where it came from, the model, cost, diff, how
                                 long a conversation it has been — and the age, right-aligned. Drawn from the
                                 fleet entry where there is one and from the conversation where there isn't
                                 (see "What the card knows"), so an off-roster chat keeps a populated card. -->
                            <template v-if="hasMeta({ conversation: c, agent })" #meta>
                                <span
                                    v-if="agent !== undefined && attentionReason(agent) !== undefined"
                                    class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-semibold text-warning"
                                    >{{ attentionReason(agent) }}</span
                                >
                                <!-- The board's unread chip, in the attention chip's slot: both answer "why
                                     should I look at this one", and a card never needs both ("needs you"
                                     outranks "you haven't looked"). -->
                                <span
                                    v-else-if="agent !== undefined && unreadBadge(agent) !== undefined"
                                    v-tooltip.top="
                                        unreadBadge(agent)!.seenAt === undefined
                                            ? undefined
                                            : `Worked since you last opened it — ${relativeTime(unreadBadge(agent)!.seenAt!)}`
                                    "
                                    class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px font-semibold text-link"
                                    >{{ unreadBadge(agent)!.label }}</span
                                >
                                <!-- Came in from outside (a Discord mention, a visitor, a webhook), and
                                     off the board, still open — both are marks about the card's PROVENANCE
                                     rather than its name, so they ride the meta line the way the board
                                     puts its OriginMark in the card body. -->
                                <OriginMark :origin="originOf(c)" compact />
                                <WorkflowMark :workflow="agent?.workflow" compact />
                                <!-- Words of the user's still in this chat's composer — the board's own mark
                                     (AgentCard) at the width a rail row can spend on it: the glyph alone, in
                                     the same link hue, with the sentence in its tooltip. Beside the archived
                                     box on purpose, since the pair is what an old chat being written into
                                     wears. -->
                                <span
                                    v-if="c.unsent.value"
                                    v-tooltip.top="'You have an unsent message here'"
                                    class="flex shrink-0 items-center text-link"
                                    aria-label="Unsent message"
                                >
                                    <Icon name="send" class="text-2xs" />
                                </span>
                                <span v-if="isArchived(c)" class="flex shrink-0 items-center" aria-label="Archived">
                                    <Icon name="box" class="text-2xs text-subtle" />
                                </span>
                                <span v-if="modelOf({ conversation: c, agent }) !== undefined" class="max-w-24 truncate">{{
                                    modelOf({ conversation: c, agent })
                                }}</span>
                                <span v-if="costOf({ conversation: c, agent }) !== undefined" class="shrink-0">{{
                                    formatCost(costOf({ conversation: c, agent })!)
                                }}</span>
                                <!-- The diff is the registry's alone: it is measured against the branch's base
                                     daemon-side, and nothing this browser holds can stand in for it. -->
                                <span
                                    v-if="agent?.diff !== undefined && (agent.diff.insertions > 0 || agent.diff.deletions > 0)"
                                    class="shrink-0 font-mono"
                                >
                                    <span class="text-success">+{{ agent.diff.insertions }}</span>
                                    <span class="text-danger"> −{{ agent.diff.deletions }}</span>
                                </span>
                                <span v-if="turnsOf({ conversation: c, agent }) !== undefined" class="shrink-0" aria-label="Turns">
                                    <Icon name="comments" class="mr-0.5 text-2xs" />{{ turnsOf({ conversation: c, agent }) }}
                                </span>
                                <!-- The age keeps to the settled cards: a running card's clock is the live
                                     line's ticking elapsed below, and two clocks on one card disagree by
                                     construction. -->
                                <span v-if="agent !== undefined && !turnInFlight(agent) && agent.updatedAt > 0" class="ml-auto shrink-0">{{
                                    relativeTime(agent.updatedAt)
                                }}</span>
                            </template>
                        </RailCard>
                    </template>
                </div>
                <!-- The lane's tail, not a pager: the count is the point ("there are 12 more open"), and the
                     row is what keeps them one press away instead of gone. The board's own row, at the rail's
                     width. Gone while filtering — the window is lifted there, so there is nothing behind it. -->
                <button
                    v-if="lane.key === 'finished' && !filtering && hiddenFinished > 0"
                    type="button"
                    :class="cmp.addTile(`mt-1.5 gap-1 rounded-lg py-1.5 text-2xs`)"
                    @click="showAllFinished = !showAllFinished"
                >
                    <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                </button>
            </RailLane>

            <!-- WHAT THE QUERY FOUND THAT ISN'T OPEN HERE. This list holds the chats of this window, which is
                 almost never the set the question "where did I say X" is about — so the filter reaches the
                 whole fleet (live agents, the archive) and the conversations no agent owns, and puts them here.
                 A row opens the conversation, which is exactly the act the History menu performs; the
                 difference is that this list was found rather than browsed.
                 A lane of the same shape as the three above it, down to the card skin: these are destinations,
                 not footnotes, and the board makes the same call with its own off-board hits (real cards, in a
                 group with a header). Only the ink is dropped a step — a muted title, no status glyph — since
                 nothing here is a session you are currently in. -->
            <RailLane v-if="filtering && notOpenCount > 0" label="Not open" icon="search" :count="notOpenCount">
                <div class="flex min-w-0 flex-col gap-1.5">
                    <!-- The same identity tile as the lanes above: a hit here is a destination, and the
                         category tint says what kind of work it will turn out to be. -->
                    <RailCard
                        v-for="agent in notOpen"
                        :key="agent.id"
                        :title="agent.title ?? 'Untitled agent'"
                        :needle="needle"
                        :provider="agent.provider"
                        quiet
                        :snippet="snippetOf(agent)"
                        @click="emit('open', agent.id)"
                    >
                        <template #meta>
                            <!-- Off the board but not gone: the branch, the diff and the transcript all survive an
                                 archive, so a hit here is a real destination rather than a tombstone. -->
                            <Icon v-if="agent.archivedAt !== undefined" name="box" class="shrink-0 text-2xs" aria-label="Archived" />
                            <span v-if="agent.updatedAt > 0" class="ml-auto shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
                        </template>
                    </RailCard>
                    <!-- Conversations no agent entry owns — a plain chat, or one whose entry is long gone. Nothing
                         to draw a provider mark or a status for; the title and the matched line are the whole of
                         what is known about them. -->
                    <RailCard
                        v-for="session in sessionMatches"
                        :key="session.id"
                        :title="session.title"
                        :needle="needle"
                        icon="comments"
                        quiet
                        :snippet="session.snippet"
                        @click="emit('open', session.id)"
                    >
                        <template #meta>
                            <span class="ml-auto shrink-0">{{ relativeTime(session.updatedAt) }}</span>
                        </template>
                    </RailCard>
                </div>
            </RailLane>
        </div>
        <!-- A failed rename already reverted the title; this says why. Cleared by the next rename. -->
        <span v-if="edit.error !== undefined" class="shrink-0 truncate px-1 text-2xs text-danger" v-tooltip.bottom.overflow="edit.error">{{
            edit.error
        }}</span>

        <!-- Both of these teleport out (the hover card to the overlay target, the menu to `append-to`), so
             they sit inside the root only to keep this component single-rooted — a fragment root would drop
             the sizing classes its two hosts hand it. Into the pop-out window while the chat floats there. -->
        <HoverCard ref="hoverCard" :to="overlayTarget" />
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :append-to="overlayTarget" :min-width="13" />
    </div>
</template>
