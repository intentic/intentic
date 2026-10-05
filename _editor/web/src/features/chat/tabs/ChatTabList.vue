<script setup lang="ts">
import { Button, ui, ContextMenu } from "@intentic/ui";
import { computed, nextTick, provide, ref, useId, watch } from "vue";
import ChatPersonaGrid from "../personas/ChatPersonaGrid.vue";
import { usePersonaScope } from "../personas/usePersonaScope";
import { activityIcon, activityLine, agentDisplayTitle, type FleetLane, laneOf, standingChip, turnInFlight } from "../../agents/fleet/agentStatus";
import { useAgents } from "../../agents/fleet/useAgents";
import { FINISHED_WINDOW, type FleetAgent, windowFinished } from "../../agents/fleet/useAgents-fleet";
import HoverCard from "../../../components/HoverCard.vue";
import RailCard from "../../../components/RailCard.vue";
import RailLane from "../../../components/RailLane.vue";
import type { OpenChat } from "./cardView";
import { useChatTrays } from "./chatTrays";
import { CHILD_ROWS } from "../../agents/board/cards/childRows";
import { closeSubagent, subagentOnScreen } from "../panel/subagent/subagentView";
import { dismissRows, rowsUnder, settleDismissed, useFoldFlip, useRowReveal } from "@intentic/ui/motion";
import ChatRowList from "./ChatRowList.vue";
import { laneOrdered, steadyLanes } from "./laneOrder";
import { personaOfAgent, personaOfTab, tabsInLane, tabsOfPersona } from "./tabs";
import { createChatRowActions, provideChatRowActions } from "./useChatRowActions";
import ChatShareDialog from "../panel/ChatShareDialog.vue";
import { useChat } from "../run/useChat";
import { previewOf } from "../panel/useChat-strip";
import { chatRun, showingRunGraph } from "../run/chatRun";
import { openRunInChat } from "../run/openRun";
import { insideRun, runIdsInLedger, runsInLane, runningTitles, runsNeedingYou, useWorkflowRuns } from "../../agents/fleet/useWorkflowRuns";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { startAgent } from "../../agents/fleet/agentActions";
import { useT } from "@intentic/ui/i18n";

// Switcher for every open conversation, hosted by both the docked ChatTabs sheet and the floating rail. Card and
// lane shell come from RailCard/RailLane; this file only decides which lanes exist, what goes in them, and what
// each card shows, and emits verbs rather than writing state directly. With personas on file, a grid above the lanes
// scopes them to one persona (usePersonaScope); without, the lanes are all there is.

const t = useT();

const emit = defineEmits<{
    select: [id: string];
    // A set, not an id: a card's × closes one, the context menu's Close Others/Right/All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal, panes } = useChat();
const { agentById, fleet, loadArchived, open: openAgent } = useAgents();

// One set of row verbs; this list draws only their menu, hover card, share dialog and rename error.
const root = ref<HTMLElement | null>(null);
const actions = createChatRowActions({
    // A press on a card means that chat: one showing a subagent in its column steps back out of it (subagentView.ts).
    select: (id) => {
        closeSubagent(id);
        emit(`select`, id);
    },
    close: (ids) => emit(`close`, ids),
    // Reading order is whatever the list draws, top to bottom.
    rowOrder: () => [...(root.value?.querySelectorAll(`[data-chat-tab]`) ?? [])].map((row) => row.getAttribute(`data-chat-tab`) ?? ``),
});
provideChatRowActions(actions);
const { edit, hoverCard, menu: tabMenu, menuId, menuItems: tabMenuItems, shareTarget } = actions;
// Whom the lanes are scoped to: undefined is Anyone, every chat this window holds.
const { personas, known, scope, pick, inScope, liveNotOpenOf } = usePersonaScope();
const scoped = computed(() => scope.value?.id);
const listedIds = computed(
    () => new Set(conversations.value.filter((conversation) => inScope(conversation)).map((conversation) => conversation.conversationId)),
);

// The list always holds the chat on screen: focus landing on a chat the scope leaves out (a chat started as someone
// else, one opened from the board, the composer switching whom it speaks as) moves the scope to that chat's persona.
// Focus inside the scope moves nothing, so a press in the list never reshapes the list under the pointer.
const focusedPersona = computed(() => {
    const focused = conversations.value.find((conversation) => conversation.conversationId === activeId.value);
    return focused === undefined ? undefined : { conversation: focused, persona: personaOfTab(focused, known.value) };
});
watch(
    [activeId, tabReveal, () => focusedPersona.value?.persona],
    () => {
        const focused = focusedPersona.value;
        if (focused !== undefined && !inScope(focused.conversation)) {
            pick(focused.persona);
        }
    },
    { immediate: true },
);

// Runs are grouped by lane as long as the ledger holds them; chatRun marks only which row is selected.
const { runs: workflowRuns } = useWorkflowRuns();
// Finished lane's cap; runs obey it too. Lifted by the row's own expand.
const showAllFinished = ref(false);
const windowed = computed(() => !showAllFinished.value);
// A scoped list shows a run once any of its steps speaks as the persona, as a search reached a run through its steps.
// An archived run is excluded entirely.
const listedRuns = computed(() =>
    workflowRuns.value.filter(
        (run) =>
            run.archivedAt === undefined &&
            (scoped.value === undefined || fleet.value.some((agent) => agent.workflow?.runId === run.runId && personaOfAgent(agent) === scoped.value)),
    ),
);
// Same lane rule as the board, including a step's question putting the run in Attention.
const runsIn = (lane: FleetLane): WorkflowRun[] =>
    runsInLane(listedRuns.value, lane, windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY, runsNeedingYou(fleet.value));
// Selected only while the run's diagram is the thing on screen; a followed run keeps drawing its diagram with
// nothing live in the panes.
const runOnScreen = (run: WorkflowRun): boolean => chatRun.value?.runId === run.runId && showingRunGraph(run, chatRun.value, panes.value);

// The board's trays under the list's cards: every agent a chat's conversation started, riding under its card (chatTrays.ts).
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
// The list has no filter of its own: finding a chat by what was said in it is Past chats' search.
const NO_FILTER = { active: ref(false), needle: ref(``), matchCase: ref(false), matches: (): boolean => true };
const trays = useChatTrays({
    filter: NO_FILTER,
    idMatchOf: () => undefined,
    activeId,
    showing: actions.isSelected,
    isOpen: (id) => openIds.value.has(id),
    press: (event, id) => actions.click(event, id),
});
provide(CHILD_ROWS, trays.board);

// While the pointer is over the list its order holds (steadyLanes): opening a chat moved its card, and the next press
// on the same spot opened a different one. Leaving the list lets the fresh order in.
const pointerOver = ref(false);

// A run's steps live inside its row, not listed separately, though they're still open in the panes. Excluded
// here only while the run is on the ledger (insideRun); once it rolls off, its chats reappear as normal rows.
const lanes = computed<Record<FleetLane, OpenChat[]>>((drawn) => {
    const ledger = runIdsInLedger(workflowRuns.value);
    const listed: OpenChat[] = [];
    for (const conversation of conversations.value) {
        if (!listedIds.value.has(conversation.conversationId)) {
            continue;
        }
        const agent = agentById(conversation.conversationId);
        // A run's step rides in the run's row, and a child's own chat in its parent's tray while the parent is listed.
        if ((agent !== undefined && insideRun(agent, ledger)) || trays.ridesUnder(agent, (id) => listedIds.value.has(id))) {
            continue;
        }
        listed.push({ conversation, agent });
    }
    return steadyLanes(laneOrdered(listed), pointerOver.value ? drawn : undefined);
});
// The lane's heading, and what becomes of its chats once Clear takes them out of this window.
const LANES = computed((): readonly { key: FleetLane; label: string; keeps: string }[] => [
    { key: `attention`, label: t(`shared.attention`), keeps: t(`chat.chatTabList.keepsAttention`) },
    { key: `active`, label: t(`shared.active`), keeps: t(`chat.chatTabList.keepsActive`) },
    { key: `finished`, label: t(`shared.finished`), keeps: t(`chat.chatTabList.keepsFinished`) },
]);
// What Clear closes per lane, counted off the very set the press sends, so the button can't name a number it
// doesn't close. Includes the chats a run's row folds away: they lane here too, and the lane is the target.
// Scoped, it closes only the persona's own.
const sweepOf = (lane: FleetLane): ReadonlySet<string> => (scoped.value === undefined ? tabsInLane(lane) : tabsOfPersona(scoped.value, known.value, lane));
const clearing = computed<Record<FleetLane, ReadonlySet<string>>>(() => ({
    attention: sweepOf(`attention`),
    active: sweepOf(`active`),
    finished: sweepOf(`finished`),
}));
// "1 working chat", never "1 working chats": a lane holding one is the common case here.
const CLEAR_LABEL: Record<FleetLane, (count: number) => string> = {
    attention: (count) => t(`chat.chatTabList.clearAttention`, { count }, count),
    active: (count) => t(`chat.chatTabList.clearActive`, { count }, count),
    finished: (count) => t(`chat.chatTabList.clearFinished`, { count }, count),
};
const clearLabel = (lane: (typeof LANES.value)[number]): string => CLEAR_LABEL[lane.key](clearing.value[lane.key].size);

// CLEAR IS SEEN LEAVING, not blinked away: the cards it closes play out top to bottom (@intentic/ui/motion, dismissRows,
// the lanes' row reveal played back), a lane left with nothing takes its heading with its last card, and only then do
// the chats close, which the column answers by sliding what stood below up into the room (useFoldFlip, keyed on
// `sweeps`). What closes is the set the press saw, so a chat that changed lanes mid-sweep is neither taken nor spared
// by surprise. With motion off the close is immediate, as it always was. The press hands Button nothing to await, so
// the quarter second of leaving never reads as work on its spinner.
const sweeping = ref(false);
const sweeps = ref(0);
const clearLane = async (lane: FleetLane): Promise<void> => {
    if (sweeping.value) {
        return;
    }
    const ids = clearing.value[lane];
    const section = scroller.value?.querySelector<HTMLElement>(`[data-rail-lane="${lane}"]`) ?? null;
    // The lane's own rows only (a card's tray rides inside its card), and of those the cards this Clear closes: a run's
    // row and the persona's chats not open here stay.
    const rows = section === null ? [] : (rowsUnder(section)[0] ?? []);
    const leaving = rows.filter((row) => ids.has(row.getAttribute(`data-chat-row`) ?? ``));
    // Emptied means nothing of the lane is left to draw, a run the Finished window hides included.
    const emptied = section !== null && leaving.length === rows.length && (lane !== `finished` || hiddenRuns.value === 0);
    const played = emptied ? [...leaving, section] : leaving;
    sweeping.value = true;
    section?.style.setProperty(`pointer-events`, `none`);
    try {
        await dismissRows(played);
        sweeps.value++;
        emit(`close`, ids);
        await nextTick();
    } finally {
        // Whatever the close left standing (a chat it could not take) is drawn again and answers the pointer.
        settleDismissed(played);
        section?.style.removeProperty(`pointer-events`);
        sweeping.value = false;
    }
};

// Lane visibility is filtered in JS, not `v-show`: `LANES` is compile-time so `v-for` yields a stable fragment,
// and `v-show` (set only on mount) would freeze stale in a long-lived floating window.
// A lane holding only a run, or only a persona's work not open here, still counts as occupied.
const occupiedLanes = computed(() =>
    LANES.value.filter((lane) => lanes.value[lane.key].length > 0 || runsIn(lane.key).length > 0 || notOpenIn(lane.key).length > 0),
);

// The board's Finished cap as a browsing limit, not a close: the active chat rides in, pinned chats stand outside it,
// and a filter or the row's own expand lifts it.
const finishedWindow = computed(() => {
    const pinned = lanes.value.finished.filter((entry) => entry.conversation.pinned.value);
    const rest = windowFinished(
        lanes.value.finished.filter((entry) => !entry.conversation.pinned.value),
        windowed.value ? activeId.value : undefined,
        (entry) => entry.conversation.conversationId,
    );
    return { shown: [...pinned, ...rest.shown], hidden: rest.hidden };
});
// Includes hidden runs: hiding a run also hides its chats, so the count must cover the whole workflow.
const hiddenRuns = computed(
    () => runsInLane(listedRuns.value, `finished`, Number.POSITIVE_INFINITY, runsNeedingYou(fleet.value)).length - runsIn(`finished`).length,
);
const hiddenFinished = computed(() => finishedWindow.value.hidden + hiddenRuns.value);

// The drawn cards of every lane, built once a pass rather than per `cardsIn` call.
const laneCards = computed<Record<FleetLane, OpenChat[]>>(() => {
    const next: Record<FleetLane, OpenChat[]> = { attention: [], active: [], finished: [] };
    for (const lane of [`attention`, `active`, `finished`] as const) {
        next[lane] = lane === `finished` && windowed.value ? finishedWindow.value.shown : lanes.value[lane];
    }
    return next;
});
// A lane's visible chats after (for Finished) the browsing window.
const cardsIn = (lane: FleetLane): OpenChat[] => laneCards.value[lane];

// The scoped persona's work this window has not opened, in the lane it stands in: what waits on the reader and what
// works (liveNotOpenOf). A run's step rides in its run's row and a child in its listed parent's tray, as open ones do.
const notOpenIn = (lane: FleetLane): readonly FleetAgent[] => {
    const ledger = runIdsInLedger(workflowRuns.value);
    return liveNotOpenOf(scoped.value).filter(
        (agent) => laneOf(agent) === lane && !insideRun(agent, ledger) && !trays.ridesUnder(agent, (id) => listedIds.value.has(id)),
    );
};
const liveOf = (agent: FleetAgent) => ({
    icon: (agent.subagents?.running ?? 0) > 0 ? (`users` as const) : activityIcon(agent.activity?.tool),
    text: activityLine(agent) ?? t(`ui.status.working`),
    since: agent.startedAt,
});

// Re-fetches the archive when a registered conversation has no agent; `probed` skips ones already confirmed gone.
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
// Scrolls the active card into view (`nearest`) on activeId or tabReveal changes, and immediately at mount for
// the docked sheet; a scope just picked starts at the top of its lanes.
const scroller = ref<HTMLElement | null>(null);
// What opens and shuts the trays under the cards (ChildRows' `shown`): the chats selected here and a subagent shown in
// one's column, and a lane's Clear (`sweeps`). A render that moves it makes room below a tray, or closes up over what a
// Clear took, by sliding what stands there (the `data-fold-unit`s).
useFoldFlip(
    scroller,
    () =>
        `${conversations.value
            .filter((conversation) => actions.isSelected(conversation.conversationId))
            .map((conversation) => conversation.conversationId)
            .join(`,`)}|${subagentOnScreen.value?.id}|${sweeps.value}`,
);
// THE LANES OPEN ROW BY ROW, as the board's do (@intentic/ui/motion, reveal.ts): the lane labels are there at once and
// the cards arrive top to bottom. This rail is one column, so the order is simply down it. Unlike the board, whose
// cards have an entrance of their own, a card that turns up later plays in the same way (`arrivals`): a chat starting,
// one moving to Finished, a persona's lanes swapped in for another's, each seen arriving where it now stands.
useRowReveal(scroller, {
    key: () =>
        occupiedLanes.value
            .map((lane) =>
                [
                    runsIn(lane.key).map((run) => run.runId),
                    cardsIn(lane.key).map((entry) => entry.conversation.conversationId),
                    notOpenIn(lane.key).map((agent) => agent.id),
                ].join(`,`),
            )
            .join(`|`),
    arrivals: true,
});
watch(scoped, async () => {
    await nextTick();
    if (scroller.value !== null) {
        scroller.value.scrollTop = 0;
    }
    scroller.value?.querySelector(`[data-chat-tab="${activeId.value}"]`)?.scrollIntoView({ block: `nearest` });
});
const listId = useId();
const grid = ref<{ selectedTabId: string } | null>(null);
watch(
    [activeId, tabReveal],
    async () => {
        await nextTick();
        scroller.value?.querySelector(`[data-chat-tab="${activeId.value}"]`)?.scrollIntoView({ block: `nearest` });
    },
    { immediate: true },
);

// A rename cannot outlive the row it sits on: with no drawn row there is no input left to blur it shut, and the edit
// would redraw that row as an empty field in place of its card the next time the chat appeared.
watch([() => edit.editing, actions.renamingDrawn], ([editing, drawn]) => {
    if (editing && !drawn) {
        edit.cancel();
        actions.renamingId.value = undefined;
    }
});
// F2 in a floating window has no header, so the host forwards it here; docked, the header renames itself.
defineExpose({ beginRename: actions.beginRename });
</script>

<template>
    <div ref="root" class="flex min-h-0 flex-col gap-1.5" @pointerenter="pointerOver = true" @pointerleave="pointerOver = false">
        <!-- Whom the lanes are scoped to, only once there is anyone to pick: without personas the lanes are the whole column. -->
        <ChatPersonaGrid v-if="personas.length > 0" ref="grid" :controls="listId" class="px-0.5 pt-1" />
        <!-- LANE BREAKS OUTRANK CARD BREAKS, and at 20px against 14px they barely did: the eye groups by proximity. -->
        <div
            :id="listId"
            ref="scroller"
            :role="personas.length > 0 ? `tabpanel` : undefined"
            :aria-labelledby="personas.length > 0 ? grid?.selectedTabId : undefined"
            class="flex min-h-0 flex-1 flex-col items-stretch gap-5 overflow-y-auto"
        >
            <!-- An empty lane isn't drawn at all (see occupiedLanes). -->
            <RailLane v-for="lane in occupiedLanes" :key="lane.key" :label="lane.label" :data-rail-lane="lane.key" data-fold-unit>
                <!-- Closing a chat is lossless in every lane. -->
                <template #actions>
                    <Button
                        v-if="clearing[lane.key].size > 0"
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="shrink-0"
                        :aria-label="clearLabel(lane)"
                        v-tooltip.bottom="{
                            title: t(`chat.chatTabList.closeAll`),
                            rows: [{ label: t(`chat.chatTabList.chats`), value: clearing[lane.key].size }],
                            note: lane.keeps,
                        }"
                        @click="void clearLane(lane.key)"
                    >
                        {{ t(`ui.action.clear`) }}
                    </Button>
                </template>
                <!-- Dashed like the board's run card: a run is the container for the rows below it, not one of them. -->
                <div v-if="runsIn(lane.key).length > 0" class="flex min-w-0 flex-col gap-3.5">
                    <RailCard
                        v-for="run in runsIn(lane.key)"
                        :key="run.runId"
                        data-reveal
                        :title="run.workflow.name"
                        icon="sitemap"
                        dashed
                        :selected="runOnScreen(run)"
                        :aria-label="t(`chat.chatTabList.openWorkflowRun`, { name: run.workflow.name })"
                        @click="openRunInChat(run)"
                    >
                        <template #meta>
                            <span class="min-w-0 truncate text-subtle">
                                {{ run.steps.filter((step) => step.state === `done`).length }}/{{ run.steps.length }} {{ t(`chat.chatTabList.steps`)
                                }}<template v-if="runningTitles(run).length > 0"> · {{ runningTitles(run).join(` · `) }}</template>
                            </span>
                        </template>
                    </RailCard>
                </div>
                <ChatRowList v-if="cardsIn(lane.key).length > 0" :entries="cardsIn(lane.key)" />
                <!-- The persona's work not open in this window, quiet so it reads as a look rather than a chat of this window's. Attention's are never folded: a question can't be answered unseen. -->
                <RailCard
                    v-for="agent in notOpenIn(lane.key)"
                    :key="agent.id"
                    :title="agentDisplayTitle(agent, previewOf(agent.id))"
                    :title-action="agent.titleAction"
                    :provider="agent.provider"
                    :chip="standingChip(agent)"
                    :live="turnInFlight(agent) ? liveOf(agent) : undefined"
                    :attention="lane.key === `attention`"
                    quiet
                    data-fold-unit
                    data-reveal
                    @click="openAgent(agent, `peek`)"
                />
                <!-- Not a pager — the count itself is the point ("12 more open"), one press away rather than gone. -->
                <button
                    v-if="lane.key === 'finished' && hiddenFinished > 0"
                    type="button"
                    :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                    data-fold-unit
                    @click="showAllFinished = !showAllFinished"
                >
                    <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ showAllFinished ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: hiddenFinished }) }}
                </button>
            </RailLane>

            <!-- Someone with nothing to show yet still offers the one next step. -->
            <button
                v-if="scope !== undefined && occupiedLanes.length === 0"
                type="button"
                :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                @click="startAgent(undefined, scope.id)"
            >
                <Icon name="plus" class="text-2xs" />
                {{ t(`chat.chatPersonaRail.newChatAs`, { label: scope.label }) }}
            </button>
        </div>
        <!-- A failed rename leaves the card's field open with the typed name in it; this says why, and is cleared by
             the next attempt. -->
        <span v-if="edit.error !== undefined" class="shrink-0 truncate px-1 text-2xs text-danger" v-tooltip.bottom.overflow="edit.error">{{
            edit.error
        }}</span>

        <!-- Both teleport out (hover card to the overlay target, menu to `append-to`); kept here only so the component stays single-rooted. -->
        <HoverCard ref="hoverCard" />
        <!-- Unnamed again on close, so the model above collapses to its one dependency until the next right-click. -->
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :min-width="13" @hide="menuId = undefined" />
        <ChatShareDialog
            v-if="shareTarget"
            visible
            :conversation-id="shareTarget.id"
            :title="shareTarget.title"
            @update:visible="!$event && (shareTarget = undefined)"
        />
    </div>
</template>
