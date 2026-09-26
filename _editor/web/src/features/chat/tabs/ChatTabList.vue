<script setup lang="ts">
import { Button, ui, ContextMenu, SearchBar, SegmentedControl } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import { type ChatGrouping, useChatGrouping } from "../transcript/chatGrouping";
import ChatPersonaRail from "../personas/ChatPersonaRail.vue";
import { agentDisplayTitle, type FleetLane } from "../../agents/fleet/agentStatus";
import { useAgentFilter } from "../../agents/board/useAgentFilter";
import { useAgents } from "../../agents/fleet/useAgents";
import { FINISHED_WINDOW, type FleetAgent, finishedLaneOrder, windowFinished } from "../../agents/fleet/useAgents-fleet";
import { provideMainline } from "../../agents/mainline/useMainline";
import HoverCard from "../../../components/HoverCard.vue";
import RailCard from "../../../components/RailCard.vue";
import RailLane from "../../../components/RailLane.vue";
import { relativeTime } from "../models/catalog";
import type { OpenChat } from "./cardView";
import ChatRowList from "./ChatRowList.vue";
import { laneOfTab, tabsInLane } from "./tabs";
import { createChatRowActions, provideChatRowActions } from "./useChatRowActions";
import ChatShareDialog from "../panel/ChatShareDialog.vue";
import { useChat } from "../run/useChat";
import { previewOf } from "../panel/useChat-strip";
import { chatRun, showingRunGraph } from "../run/chatRun";
import { openRunInChat } from "../run/openRun";
import {
    insideRun,
    runIdsInLedger,
    runMatches,
    runsInLane,
    runningTitles,
    runsNeedingYou,
    useWorkflowRuns,
} from "../../agents/fleet/useWorkflowRuns";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";

// Switcher for every open conversation, hosted by both the docked ChatTabs sheet and the floating rail. Card and
// lane shell come from RailCard/RailLane; this file only decides which lanes exist, what goes in them, and what
// each card shows, and emits verbs rather than writing state directly.

const t = useT();

const emit = defineEmits<{
    select: [id: string];
    // A set, not an id: a card's × closes one, the context menu's Close Others/Right/All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal, panes } = useChat();
const { agentById, fleet, loadArchived } = useAgents();
// The main tree's check, read once for the whole list: the strip at its head draws it, and every row's card reads it
// from here (ChatRowList) rather than asking for its own.
const mainline = provideMainline();

// One set of row verbs for both cuts; this list draws only their menu, hover card, share dialog and rename error.
const root = ref<HTMLElement | null>(null);
const actions = createChatRowActions({
    select: (id) => emit(`select`, id),
    close: (ids) => emit(`close`, ids),
    // Reading order is whatever the open cut draws, top to bottom.
    rowOrder: () => [...(root.value?.querySelectorAll(`[data-chat-tab]`) ?? [])].map((row) => row.getAttribute(`data-chat-tab`) ?? ``),
});
provideChatRowActions(actions);
const { edit, hoverCard, menu: tabMenu, menuId, menuItems: tabMenuItems, shareTarget } = actions;
// Switches between open chats (lanes) and personas (ChatPersonaRail); swaps the whole list, not a regroup.
const { grouping, set: setGrouping } = useChatGrouping();
// Labelled "Agents", matching the fleet board's cards and how the product names them elsewhere.
const GROUPINGS = computed((): readonly { label: string; value: ChatGrouping; title: string }[] => [
    { label: t(`shared.agents`), value: `lane`, title: t(`chat.chatTabList.everyConversationWindowHolds`) },
    { label: t(`shared.personas`), value: `persona`, title: t(`chat.chatTabList.peopleSandboxPickOne`) },
]);

// The chat the Agents list was showing, parked while Personas is up and restored on return if it still exists.
let parked: string | undefined;
watch(grouping, (next, previous) => {
    if (next === `persona`) {
        parked = activeId.value;
        return;
    }
    const restore = previous === `persona` && parked !== undefined && parked !== activeId.value;
    if (restore && conversations.value.some((conversation) => conversation.conversationId === parked)) {
        emit(`select`, parked!);
    }
    parked = undefined;
});

const lastActive = (entry: OpenChat): number => entry.agent?.updatedAt ?? 0;

// Same match rule as the board's filter (useAgentFilter); state is per-window, not shared.
const {
    query: filterQuery,
    needle,
    matchCase,
    active: filtering,
    matches: agentMatches,
    snippetOf,
    archivedMatches,
    sessionMatches,
    searching,
} = useAgentFilter();

// Runs are grouped by lane as long as the ledger holds them; chatRun marks only which row is selected.
const { runs: workflowRuns } = useWorkflowRuns();
// Finished lane's cap; runs obey it too. Lifted by a filter or the row's own expand.
const showAllFinished = ref(false);
const windowed = computed(() => !filtering.value && !showAllFinished.value);
// Same lane rule as the board, including a step's question putting the run in Attention. A query narrows runs
// (via runMatches) rather than dropping them; an archived run is excluded entirely.
const runsIn = (lane: FleetLane): WorkflowRun[] =>
    runsInLane(
        workflowRuns.value.filter(
            (run) => run.archivedAt === undefined && (!filtering.value || runMatches(run, needle.value, fleet.value, agentMatches)),
        ),
        lane,
        windowed.value ? FINISHED_WINDOW : Number.POSITIVE_INFINITY,
        runsNeedingYou(fleet.value),
    );
// Selected only while the run's diagram is the thing on screen; a followed run keeps drawing its diagram with
// nothing live in the panes.
const runOnScreen = (run: WorkflowRun): boolean => chatRun.value?.runId === run.runId && showingRunGraph(run, chatRun.value, panes.value);

// A chat with no fleet entry matches on its title and messages (both roles), the same rule as useAgentFilter; a
// notice-role message never counts.
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
        entry.conversation.transcript.messages.value.some((message) => message.role !== `notice` && message.text.toLowerCase().includes(needle.value))
    );
};

// A run's steps live inside its row, not listed separately, though they're still open in the panes. Excluded
// here only while the run is on the ledger (insideRun); once it rolls off, its chats reappear as normal rows.
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
    // Same order as the board (useAgents.lanes): drafts lead Active, then turn start, fixed for the turn.
    grouped.active.sort(
        (a, b) =>
            Number(b.agent?.status === `draft`) - Number(a.agent?.status === `draft`) ||
            (a.agent?.startedAt ?? lastActive(a)) - (b.agent?.startedAt ?? lastActive(b)),
    );
    grouped.attention.sort((a, b) => lastActive(b) - lastActive(a));
    // Same order as the board (finishedLaneOrder); agent-less chats fall back to the same two keys read off the
    // conversation.
    grouped.finished.sort((a, b) => {
        if (a.agent !== undefined && b.agent !== undefined) {
            return finishedLaneOrder(a.agent, b.agent);
        }
        return Number(b.conversation.unsent.value) - Number(a.conversation.unsent.value) || lastActive(b) - lastActive(a);
    });
    // Pinned chats lead their lane; the sort is stable, so each side keeps the lane's own order.
    for (const lane of [grouped.attention, grouped.active, grouped.finished]) {
        lane.sort((a, b) => Number(b.conversation.pinned.value) - Number(a.conversation.pinned.value));
    }
    return grouped;
});
// The lane's heading, and what becomes of its chats once Clear takes them out of this window.
const LANES = computed((): readonly { key: FleetLane; label: string; dot: string; keeps: string }[] => [
    { key: `attention`, label: t(`shared.attention`), dot: `bg-warning`, keeps: t(`chat.chatTabList.keepsAttention`) },
    { key: `active`, label: t(`shared.active`), dot: `bg-success`, keeps: t(`chat.chatTabList.keepsActive`) },
    { key: `finished`, label: t(`shared.finished`), dot: `bg-line-strong`, keeps: t(`chat.chatTabList.keepsFinished`) },
]);
// What Clear closes per lane, counted off the very set the press sends, so the button can't name a number it
// doesn't close. Includes the chats a run's row folds away: they lane here too, and the lane is the target.
const clearing = computed<Record<FleetLane, ReadonlySet<string>>>(() => ({
    attention: tabsInLane(`attention`),
    active: tabsInLane(`active`),
    finished: tabsInLane(`finished`),
}));
// "1 working chat", never "1 working chats": a lane holding one is the common case here.
const CLEAR_LABEL: Record<FleetLane, (count: number) => string> = {
    attention: (count) => t(`chat.chatTabList.clearAttention`, { count }, count),
    active: (count) => t(`chat.chatTabList.clearActive`, { count }, count),
    finished: (count) => t(`chat.chatTabList.clearFinished`, { count }, count),
};
const clearLabel = (lane: (typeof LANES.value)[number]): string => CLEAR_LABEL[lane.key](clearing.value[lane.key].size);

// Lane visibility is filtered in JS, not `v-show`: `LANES` is compile-time so `v-for` yields a stable fragment,
// and `v-show` (set only on mount) would freeze stale in a long-lived floating window.
// A lane holding only a run still counts as occupied, or it's filtered into a section that's never drawn.
const occupiedLanes = computed(() => LANES.value.filter((lane) => lanes.value[lane.key].length > 0 || runsIn(lane.key).length > 0));

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
    () =>
        runsInLane(
            workflowRuns.value.filter((run) => run.archivedAt === undefined),
            `finished`,
            Number.POSITIVE_INFINITY,
            runsNeedingYou(fleet.value),
        ).length - runsIn(`finished`).length,
);
const hiddenFinished = computed(() => finishedWindow.value.hidden + hiddenRuns.value);

// The drawn cards of every lane, built once a pass rather than per `cardsIn` call.
const laneCards = computed<Record<FleetLane, OpenChat[]>>(() => {
    const next: Record<FleetLane, OpenChat[]> = { attention: [], active: [], finished: [] };
    for (const lane of [`attention`, `active`, `finished`] as const) {
        const source = lane === `finished` && windowed.value ? finishedWindow.value.shown : lanes.value[lane];
        next[lane] = source.filter(tabMatches);
    }
    return next;
});
// A lane's visible chats after the message filter and (for Finished) the browsing window.
const cardsIn = (lane: FleetLane): OpenChat[] => laneCards.value[lane];

// Matches outside this window: fleet agents, then archived agents, then agent-less conversations
// (sessionMatches); each opens the conversation. Archive loads lazily on first query, not at mount.
const openIds = computed(() => new Set(conversations.value.map((conversation) => conversation.conversationId)));
const notOpen = computed<FleetAgent[]>(() => {
    if (!filtering.value) {
        return [];
    }
    return [...fleet.value.filter((agent) => agentMatches(agent)), ...archivedMatches.value].filter((agent) => !openIds.value.has(agent.id));
});
const notOpenCount = computed(() => notOpen.value.length + sessionMatches.value.length);

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
// Also probes the archive when a search starts, since the query reaches into it (`archivedMatches`) too.
watch(filtering, (on) => {
    if (on) {
        void loadArchived();
    }
});

// Scrolls the active card into view (`nearest`) on activeId or tabReveal changes, and immediately at mount for
// the docked sheet.
const scroller = ref<HTMLElement | null>(null);
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

// ChatPersonaRail raises the same selection, told the same way so the board stays in step regardless of which
// list was used.
const onPersonaSelect = (id: string): void => {
    actions.focus(id);
};
</script>

<template>
    <div ref="root" class="flex min-h-0 flex-col gap-1.5">
        <!-- Reading order top to bottom: narrow with the filter, pick a lane, and when the query reaches past what's open, the "Not open" group at the foot. -->
        <!-- The `Aa` case toggle mirrors the board's: a mode only one of the two search boxes could see or undo would be confusing. -->
        <!-- Tabs, not a pill track: this switch decides what the column IS, so it reads as the column's own header — and a bordered track here stacked a second box directly above the filter field's, which made the header two grey boxes rather than a heading over a control. -->
        <!-- Centred over the column: with no track to give them an edge to sit on, flush left read as the first row of the list rather than its title. -->
        <SegmentedControl
            :model-value="grouping"
            :options="GROUPINGS"
            size="xs"
            variant="underline"
            class="shrink-0 justify-center"
            @update:model-value="(next: ChatGrouping) => setGrouping(next)"
        />
        <!-- Shown only for the chats grouping: the filter searches messages, which personas don't have. -->
        <SearchBar
            v-if="grouping === `lane`"
            v-model="filterQuery"
            v-model:match-case="matchCase"
            variant="field"
            clearable
            :busy="searching"
            :aria-label="t(`chat.chatTabList.filterChatsByMessages`)"
            :placeholder="t(`agents.words.filterByMessages`)"
            class="shrink-0"
        />
        <!-- A different list, not this one regrouped — its own component (see ChatPersonaRail). -->
        <ChatPersonaRail v-if="grouping === `persona`" @select="onPersonaSelect" />
        <!-- LANE BREAKS OUTRANK CARD BREAKS, and at 12px against 10px they barely did: the eye groups by proximity. -->
        <div v-else ref="scroller" class="flex min-h-0 flex-1 flex-col items-stretch gap-4 overflow-y-auto">
            <!-- An empty lane isn't drawn at all (see occupiedLanes); one emptied only by the filter keeps its header. -->
            <RailLane v-for="lane in occupiedLanes" :key="lane.key" :label="lane.label" :dot="lane.dot">
                <!-- Closing a chat is lossless in every lane. -->
                <template #actions>
                    <Button
                        v-if="clearing[lane.key].size > 0 && !filtering"
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="shrink-0"
                        :aria-label="clearLabel(lane)"
                        v-tooltip.bottom="t(`chat.chatTabList.closeAll`, { size: clearing[lane.key].size, keeps: lane.keeps })"
                        @click="emit('close', clearing[lane.key])"
                    >
                        {{ t(`ui.action.clear`) }}
                    </Button>
                </template>
                <!-- Dashed like the board's run card: a run is the container for the rows below it, not one of them. -->
                <div v-if="runsIn(lane.key).length > 0" class="flex min-w-0 flex-col gap-2.5">
                    <RailCard
                        v-for="run in runsIn(lane.key)"
                        :key="run.runId"
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
                <p v-if="cardsIn(lane.key).length === 0 && runsIn(lane.key).length === 0" class="px-1 text-2xs text-subtle">
                    {{ t(`chat.chatTabList.noMatches`) }}
                </p>
                <ChatRowList
                    v-else-if="cardsIn(lane.key).length > 0"
                    :entries="cardsIn(lane.key)"
                    :needle="needle"
                    :match-case="matchCase"
                    :snippet-of="snippetOf"
                />
                <!-- Not a pager — the count itself is the point ("12 more open"), one press away rather than gone. -->
                <button
                    v-if="lane.key === 'finished' && !filtering && hiddenFinished > 0"
                    type="button"
                    :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                    @click="showAllFinished = !showAllFinished"
                >
                    <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ showAllFinished ? t(`ui.action.showFewer`) : t(`ui.action.showEarlier`, { count: hiddenFinished }) }}
                </button>
            </RailLane>

            <!-- Query hits outside this window's open chats (fleet, archive, agent-less conversations); a row opens the conversation, same as History. -->
            <RailLane v-if="filtering && notOpenCount > 0" :label="t(`chat.chatTabList.notOpen`)" icon="search">
                <div class="flex min-w-0 flex-col gap-2.5">
                    <!-- Same identity tile as the lanes above; the category tint still signals what kind of work this is. -->
                    <!-- The only place this list reads composer words, and it is inside `filtering`: a lane the reader
                         opened by typing here already redraws per character. Open chats name themselves in ChatTabRow. -->
                    <RailCard
                        v-for="agent in notOpen"
                        :key="agent.id"
                        :title="agentDisplayTitle(agent, previewOf(agent.id))"
                        :title-action="agent.titleAction"
                        :needle="needle"
                        :match-case="matchCase"
                        :provider="agent.provider"
                        quiet
                        :snippet="snippetOf(agent)"
                        @click="emit('open', agent.id)"
                    >
                        <template #meta>
                            <!-- Archived, not gone: the branch, diff and transcript all survive, so this is a real destination. -->
                            <Icon v-if="agent.archivedAt !== undefined" name="box" class="shrink-0 text-2xs" :aria-label="t(`shared.archived`)" />
                            <span v-if="agent.updatedAt > 0" class="ml-auto shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
                        </template>
                    </RailCard>
                    <!-- Conversations no agent owns; only the title and matched line are known, so no provider mark or status. -->
                    <RailCard
                        v-for="session in sessionMatches"
                        :key="session.id"
                        :title="session.title"
                        :needle="needle"
                        :match-case="matchCase"
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
