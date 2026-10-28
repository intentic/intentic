<script setup lang="ts">
import { Button, ui, ContextMenu } from "@intentic/ui";
import { computed, nextTick, provide, ref, watch } from "vue";
import type { FleetLane } from "../../../models/agent-status/agentStatus-lanes";
import { useAgents } from "../../../models/fleet/useAgents";
import HoverCard from "./HoverCard.vue";
import RailCard from "./RailCard.vue";
import RailLane from "../../../components/RailLane.vue";
import type { OpenChat } from "./cardView";
import { useChatTrays } from "./chatTrays";
import { CHILD_ROWS } from "../../../models/fleet/board/childRows";
import { closeSubagent, subagentOnScreen } from "../../../models/conversations/panel/subagentView";
import { dismissRows, rowsUnder, settleDismissed, useFoldFlip, useRowReveal } from "@intentic/ui/motion";
import ChatRowList from "./ChatRowList.vue";
import { laneOrdered, steadyLanes } from "./laneOrder";
import { chatDoneWith, type FinishedFold, foldFinished, runDoneWith } from "./doneFold";
import { windowRole } from "../../../lib/windows/windowRole";
import { tabsInLane } from "./tabs";
import { createChatRowActions, provideChatRowActions } from "./useChatRowActions";
import ChatShareDialog from "../panel/ChatShareDialog.vue";
import { useChat } from "../../../models/conversations/run/useChat";
import { chatRun, showingRunGraph } from "../../../models/conversations/run/chatRun";
import { openRunInChat } from "../../../models/fleet/openRun";
import { insideRun, runIdsInLedger, runsInLane, runningTitles, runsNeedingYou, useWorkflowRuns } from "../../../models/fleet/useWorkflowRuns";
import type { WorkflowRun } from "@intentic/sandbox-contract/schemas/workflows";
import { useT } from "@intentic/ui/i18n";

// Switcher for every open conversation, hosted by both the docked ChatTabs sheet and the floating rail. Card and
// lane shell come from RailCard/RailLane; this file only decides which lanes exist, what goes in them, and what
// each card shows, and emits verbs rather than writing state directly. Every open chat is listed, whatever persona it
// wears: a persona is a posture a chat takes on, picked in its composer (or by routing), not someone the list is sorted
// by. Removed (2026-10-13) the grid of persona tiles above the lanes, which scoped them to one persona.

const t = useT();

const emit = defineEmits<{
    select: [id: string];
    // A set, not an id: a card's × closes one, the context menu's Close Others/Right/All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal, panes } = useChat();
const { agentById, fleet, loadArchived } = useAgents();

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

// Runs are grouped by lane as long as the ledger holds them; chatRun marks only which row is selected.
const { runs: workflowRuns } = useWorkflowRuns();
// The Finished lane's "N done" fold (doneFold.ts), open or shut: this window's own, kept across a reload of it. Keyed by
// the window's kind, since a popped-out chat's window starts with a copy of its opener's session storage.
const DONE_OPEN_KEY = `intentic.chatList.doneOpen.${windowRole}`;
const doneOpen = ref(globalThis.sessionStorage?.getItem(DONE_OPEN_KEY) === `1`);
watch(doneOpen, (open) => globalThis.sessionStorage?.setItem(DONE_OPEN_KEY, open ? `1` : `0`));
// An archived run is excluded entirely.
const listedRuns = computed(() => workflowRuns.value.filter((run) => run.archivedAt === undefined));
// Same lane rule as the board, including a step's question putting the run in Attention. Every run of the lane: Finished
// folds what is done with (doneFold.ts) rather than capping by count.
const runsInAll = (lane: FleetLane): WorkflowRun[] => runsInLane(listedRuns.value, lane, Number.POSITIVE_INFINITY, runsNeedingYou(fleet.value));
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
        const agent = agentById(conversation.conversationId);
        // A run's step rides in the run's row, and a child's own chat in its parent's tray while the parent is listed.
        if ((agent !== undefined && insideRun(agent, ledger)) || trays.ridesUnder(agent, (id) => openIds.value.has(id))) {
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
    // row stays.
    const rows = section === null ? [] : (rowsUnder(section)[0] ?? []);
    const leaving = rows.filter((row) => ids.has(row.getAttribute(`data-chat-row`) ?? ``));
    // Emptied means nothing of the lane is left to draw, a run the Finished window hides included.
    const emptied = section !== null && leaving.length === rows.length && (lane !== `finished` || doneOpen.value || runFold.value.folded.length === 0);
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
// A lane holding only a run still counts as occupied, and so does a Finished lane whose every chat is folded: its fold
// row is where those chats are.
const occupiedLanes = computed(() => LANES.value.filter((lane) => lanes.value[lane.key].length > 0 || runsInAll(lane.key).length > 0));

// FINISHED SHOWS WHAT IS STILL OWED; THE REST FOLDS (doneFold.ts). While the pointer is over the list each chat keeps
// its side of the fold (as the lanes' order holds there), so a chat the reader just left folds once they leave the list,
// sliding the column up (useFoldFlip below) rather than vanishing under the next press.
const heldIds = <T>(drawn: FinishedFold<T> | undefined, idOf: (entry: T) => string): FinishedFold<string> | undefined =>
    pointerOver.value && drawn !== undefined ? { shown: drawn.shown.map(idOf), folded: drawn.folded.map(idOf) } : undefined;
const chatId = (entry: OpenChat): string => entry.conversation.conversationId;
const chatFold = computed<FinishedFold<OpenChat>>((drawn) =>
    foldFinished(lanes.value.finished, (entry) => chatDoneWith(entry, actions.isSelected), chatId, heldIds(drawn, chatId)),
);
const runFold = computed<FinishedFold<WorkflowRun>>((drawn) =>
    foldFinished(runsInAll(`finished`), (run) => runDoneWith(run, fleet.value, runOnScreen(run)), (run) => run.runId, heldIds(drawn, (run) => run.runId)),
);
const doneCount = computed(() => chatFold.value.folded.length + runFold.value.folded.length);

// What a lane draws, top to bottom: every run and chat of Attention and Active; of Finished, what is still owed, the
// fold's row, and what is done with once the fold is open, under its row.
type LanePart = { readonly key: `cards` | `done`; readonly runs: readonly WorkflowRun[]; readonly chats: readonly OpenChat[] } | { readonly key: `fold` };
const partsOf = (lane: FleetLane): readonly LanePart[] => {
    if (lane !== `finished`) {
        return [{ key: `cards`, runs: runsInAll(lane), chats: lanes.value[lane] }];
    }
    const owed: LanePart = { key: `cards`, runs: runFold.value.shown, chats: chatFold.value.shown };
    if (doneCount.value === 0) {
        return [owed];
    }
    const fold: LanePart = { key: `fold` };
    return doneOpen.value ? [owed, fold, { key: `done`, runs: runFold.value.folded, chats: chatFold.value.folded }] : [owed, fold];
};

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
// the docked sheet.
const scroller = ref<HTMLElement | null>(null);
// What opens and shuts the trays under the cards (ChildRows' `shown`): the chats selected here and a subagent shown in
// one's column, a lane's Clear (`sweeps`), and a chat or run going under Finished's fold or the fold opening. A render that moves it makes room below a tray, or closes up over what a
// Clear took, by sliding what stands there (the `data-fold-unit`s).
useFoldFlip(
    scroller,
    () =>
        `${conversations.value
            .filter((conversation) => actions.isSelected(conversation.conversationId))
            .map((conversation) => conversation.conversationId)
            .join(`,`)}|${subagentOnScreen.value?.id}|${sweeps.value}|${chatFold.value.folded.map(chatId).join(`,`)}|${runFold.value.folded.length}|${doneOpen.value}`,
);
// THE LANES OPEN ROW BY ROW, as the board's do (@intentic/ui/motion, reveal.ts): the lane labels are there at once and
// the cards arrive top to bottom. This rail is one column, so the order is simply down it. Unlike the board, whose
// cards have an entrance of their own, a card that turns up later plays in the same way (`arrivals`): a chat starting,
// one moving to Finished, each seen arriving where it now stands.
useRowReveal(scroller, {
    key: () =>
        occupiedLanes.value
            .map((lane) =>
                partsOf(lane.key)
                    .map((part) => (part.key === `fold` ? `fold` : [...part.runs.map((run) => run.runId), ...part.chats.map(chatId)].join(`,`)))
                    .join(`/`),
            )
            .join(`|`),
    arrivals: true,
});
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
        <!-- LANE BREAKS OUTRANK CARD BREAKS, and at 20px against 14px they barely did: the eye groups by proximity. -->
        <div ref="scroller" class="flex min-h-0 flex-1 flex-col items-stretch gap-5 overflow-y-auto">
            <!-- An empty lane isn't drawn at all (see occupiedLanes). -->
            <RailLane v-for="lane in occupiedLanes" :key="lane.key" :label="lane.label" :data-rail-lane="lane.key" data-fold-unit>
                <!-- Closing a chat is lossless in every lane. -->
                <template #actions>
                    <Button
                        v-if="clearing[lane.key].size > 0"
                        size="small"
                        tier="quiet"
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
                <template v-for="part in partsOf(lane.key)" :key="part.key">
                    <!-- THE FOLD'S ROW: how many done-with chats it holds, one press from opening them under it. Quiet text,
                         not a tile: it divides the lane rather than standing in it as a card. -->
                    <button
                        v-if="part.key === 'fold'"
                        type="button"
                        :class="[ui.textButton({ tone: `subtle`, size: `xs` }), `px-2.5`]"
                        :aria-expanded="doneOpen"
                        v-tooltip.bottom="{ title: t(`chat.chatTabList.doneTitle`), note: t(`chat.chatTabList.doneNote`) }"
                        data-fold-unit
                        @click="doneOpen = !doneOpen"
                    >
                        <Icon :name="doneOpen ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                        {{ t(`chat.chatTabList.done`, { count: doneCount }) }}
                    </button>
                    <template v-else>
                        <!-- Dashed like the board's run card: a run is the container for the rows below it, not one of them. -->
                        <div v-if="part.runs.length > 0" class="flex min-w-0 flex-col gap-3.5">
                            <RailCard
                                v-for="run in part.runs"
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
                                        {{
                                            t(`chat.chatTabList.stepsDone`, {
                                                done: run.steps.filter((step) => step.state === `done`).length,
                                                total: run.steps.length,
                                            })
                                        }}<template v-if="runningTitles(run).length > 0"> · {{ runningTitles(run).join(` · `) }}</template>
                                    </span>
                                </template>
                            </RailCard>
                        </div>
                        <ChatRowList v-if="part.chats.length > 0" :entries="part.chats" />
                    </template>
                </template>
            </RailLane>
            <!-- What a host adds below the open chats, in the same scroll: the docked sheet's Past chats (ChatTabs.vue). -->
            <slot name="after" />
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
