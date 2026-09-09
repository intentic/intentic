<script setup lang="ts">
import { Button, ui, ContextMenu, type IconName, SearchBar, SegmentedControl } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { createInlineRename } from "../../../lib/inlineRename";
import { type ChatGrouping, useChatGrouping } from "../transcript/chatGrouping";
import ChatPersonaRail from "../personas/ChatPersonaRail.vue";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    attentionReason,
    contextPct,
    type FleetLane,
    turnInFlight,
    unreadBadge,
} from "../../agents/fleet/agentStatus";
import { sessionCategory } from "../../../app/sessionCategory";
import { useAgentFilter } from "../../agents/board/useAgentFilter";
import { boxNameOf } from "../../agents/fleet/fleetScope";
import { useAgents } from "../../agents/fleet/useAgents";
import { FINISHED_WINDOW, type FleetAgent, windowFinished } from "../../agents/fleet/useAgents-fleet";
import HoverCard from "../../../components/HoverCard.vue";
import OriginMark from "../../../components/OriginMark.vue";
import RailCard from "../../../components/RailCard.vue";
import RailLane from "../../../components/RailLane.vue";
import UnsentMark from "../../../components/UnsentMark.vue";
import WorkflowMark from "../../../components/WorkflowMark.vue";
import { relativeTime, statusIcon, statusLabel } from "../models/catalog";
import type { Conversation } from "../session/conversation";
import { draftPreview } from "../drafts/draftPreview";
import { modelLabelFor } from "../accounts/providerCatalog";
import { allTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, tabsInLane, toRightOf } from "./tabs";
import ChatShareDialog from "../panel/ChatShareDialog.vue";
import { relaySummons } from "../run/summon";
import { useChat } from "../run/useChat";
import type { RevealVerb } from "../panel/useChat-reveal";
import { useChatFloating } from "../panel/chatFloating";
import { chatWide, toggleChatFloating } from "../panel/chatPanelLayout";
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
import { commandShortcut } from "../../../shell/commands/useCommands";
import { viewersOfSession } from "../../../shell/presence/usePresence";
import PresenceAvatars from "../../../shell/presence/PresenceAvatars.vue";
import { providerLabel, type WorkflowRun } from "@intentic/sandbox-contract";

// Switcher for every open conversation, hosted by both the docked ChatTabs sheet and the floating rail. Card and
// lane shell come from RailCard/RailLane; this file only decides which lanes exist, what goes in them, and what
// each card shows, and emits verbs rather than writing state directly.

const emit = defineEmits<{
    select: [id: string];
    // A set, not an id: a card's × closes one, the context menu's Close Others/Right/All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal, panes, openBeside, closePane, collapsePanes, setPanes, keepChat } = useChat();
const { agentById, fleet, loadArchived, rename } = useAgents();

const { floats } = useChatFloating();
const router = useRouter();
// Switches between open chats (lanes) and personas (ChatPersonaRail); swaps the whole list, not a regroup.
const { grouping, set: setGrouping } = useChatGrouping();
// Labelled "Agents", matching the fleet board's cards and how the product names them elsewhere.
const GROUPINGS: readonly { label: string; value: ChatGrouping; title: string }[] = [
    { label: `Agents`, value: `lane`, title: `Every conversation this window holds, by what needs you` },
    { label: `Personas`, value: `persona`, title: `The people this sandbox can be, pick one and talk to them` },
];

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

interface OpenChat {
    readonly conversation: Conversation;
    readonly agent: FleetAgent | undefined;
}
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
        entry.conversation.messages.value.some((message) => message.role !== `notice` && message.text.toLowerCase().includes(needle.value))
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
    // Finished sorts unsent-draft chats first, so a half-written message can't fall behind the window's fold.
    grouped.finished.sort((a, b) => Number(b.conversation.unsent.value) - Number(a.conversation.unsent.value) || lastActive(b) - lastActive(a));
    return grouped;
});
// Clear's own words for the lane: the adjective its label counts ("3 working chats"), and what becomes of
// those chats once they leave this window.
const LANES: readonly { key: FleetLane; label: string; dot: string; clears: string; keeps: string }[] = [
    { key: `attention`, label: `Attention`, dot: `bg-warning`, clears: `waiting`, keeps: `they keep waiting on the board` },
    { key: `active`, label: `Active`, dot: `bg-success`, clears: `working`, keeps: `their turns keep running` },
    { key: `finished`, label: `Finished`, dot: `bg-line-strong`, clears: `finished`, keeps: `they stay in Past chats` },
];
// What Clear closes per lane, counted off the very set the press sends, so the button can't name a number it
// doesn't close. Includes the chats a run's row folds away: they lane here too, and the lane is the target.
const clearing = computed<Record<FleetLane, ReadonlySet<string>>>(() => ({
    attention: tabsInLane(`attention`),
    active: tabsInLane(`active`),
    finished: tabsInLane(`finished`),
}));
// "1 working chat", never "1 working chats": a lane holding one is the common case here.
const clearLabel = (lane: (typeof LANES)[number]): string => {
    const count = clearing.value[lane.key].size;
    return `Close all ${count} ${lane.clears} ${count === 1 ? `chat` : `chats`}`;
};

// Lane visibility is filtered in JS, not `v-show`: `LANES` is compile-time so `v-for` yields a stable fragment,
// and `v-show` (set only on mount) would freeze stale in a long-lived floating window.
// A lane holding only a run still counts as occupied, or it's filtered into a section that's never drawn.
const occupiedLanes = computed(() => LANES.filter((lane) => lanes.value[lane.key].length > 0 || runsIn(lane.key).length > 0));

// Caps Finished at windowFinished (the board's own cap): a browsing limit, not a close, everything stays open
// and reachable. The active chat is always pinned in; a filter or the row's own expand lifts the cap.
const finishedWindow = computed(() =>
    windowFinished(lanes.value.finished, windowed.value ? activeId.value : undefined, (entry) => entry.conversation.conversationId),
);
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

// A lane's visible chats. The `n of m` denominator is the lane's total, not the windowed count; the row below
// the cards explains the difference.
const cardsIn = (lane: FleetLane): OpenChat[] => {
    const source = lane === `finished` && windowed.value ? finishedWindow.value.shown : lanes.value[lane];
    return source.filter(tabMatches);
};
// A run counts as its one row on both sides: `heldIn` and `cardsIn` must agree, or the lane header would
// contradict the row drawn beneath it.
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

// Status glyph for the trailing slot: agent status when fleet-carded, else the conversation's own status.
// Returned pre-bound as one object so the template computes it once, not per-field.
const statusOf = (entry: OpenChat): { name: IconName; spin?: boolean; class: string; "aria-label": string } => {
    if (entry.agent !== undefined) {
        const meta = agentStatusMeta(entry.agent.status);
        return { name: meta.icon, spin: meta.spin, class: `text-xs ${meta.class}`, "aria-label": meta.label };
    }
    const status = entry.conversation.status.value;
    const icon = statusIcon(status);
    return { name: icon.name, spin: icon.spin, class: `text-xs ${icon.class}`, "aria-label": statusLabel(status) };
};

// How much of the model's context window this chat has spent, for the mark's rim. Only the fleet agent knows it:
// a conversation this window holds but the roster has not filed has nothing measured, and its mark wears the empty
// rim rather than a guess.
const contextOf = (entry: OpenChat): number | undefined =>
    entry.agent === undefined ? undefined : contextPct(entry.agent.contextTokens, entry.agent.contextWindow);

// Prefers the fleet agent, falls back to the conversation: an unresolved agent (archived, unregistered) still
// has a conversation with real facts. Omits spend, diff and turn count on purpose; those belong to the board.

// Model label as the pickers show it; falls back to the provider name when no model is recorded yet.
// `activeModel` is what last ran; `model` is what the composer would send next.
const modelOf = (entry: OpenChat): string | undefined => {
    const { agent, conversation } = entry;
    const provider = agent?.provider ?? conversation.provider.value;
    const model = agent?.model ?? conversation.activeModel.value ?? conversation.model.value;
    if (model !== null && model !== ``) {
        return modelLabelFor(provider, model);
    }
    return sessionCategory(tabLabel(conversation)) === undefined ? undefined : providerLabel(provider);
};

// Live-line text prefers the registry's activity frames (richer); falls back to the conversation's own
// streaming state so a working card stays findable even when the fleet join is cold.
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

// Whether the second line has anything to show; a fresh draft has no numbers, marks or model, so it's asked per
// card rather than assumed.
const hasMeta = (entry: OpenChat): boolean =>
    (entry.agent !== undefined &&
        (attentionReason(entry.agent) !== undefined || unreadBadge(entry.agent) !== undefined || entry.agent.updatedAt > 0)) ||
    entry.conversation.unsent.value ||
    originOf(entry.conversation) !== undefined ||
    isArchived(entry.conversation) ||
    modelOf(entry) !== undefined;

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

// Shared clock for every running card's elapsed readout; ticks only while this list is mounted.
const now = useNow();

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

// Single rename state for the list, via the same createInlineRename the fleet cards use (renames the registry
// entry). Reached by double-click or the row menu; F2 is the panel header's own.
const renamingId = ref<string | undefined>(undefined);
const renaming = computed(() => conversations.value.find((conversation) => conversation.conversationId === renamingId.value));
const edit = createInlineRename(
    () => renaming.value?.title.value ?? undefined,
    (name) => rename(renaming.value?.conversationId ?? ``, name),
    `Couldn't rename the agent.`,
);
const beginRename = (id: string): void => {
    renamingId.value = id;
    edit.begin();
};
// Whether the lanes still draw the row being renamed: a chat that was closed, filtered out, capped behind the
// Finished fold or swallowed by a run is gone from the list, whatever the edit still holds.
const renamingDrawn = computed(
    () =>
        renamingId.value !== undefined &&
        LANES.some((lane) => cardsIn(lane.key).some((entry) => entry.conversation.conversationId === renamingId.value)),
);
// A rename cannot outlive the row it sits on: with no drawn row there is no input left to blur it shut, and
// the edit would redraw that row as an empty field in place of its card the next time the chat appeared.
watch([() => edit.editing, renamingDrawn], ([editing, drawn]) => {
    if (editing && !drawn) {
        edit.cancel();
        renamingId.value = undefined;
    }
});
// F2 in a floating window has no header, so the host forwards it here; docked, the header renames itself.
defineExpose({ beginRename });

// Hover shows the full title plus the first prompt (what the chat was for) and the last one if different (what
// it's about now); images ride along since a prompt is often a screenshot.
const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showPreview = (event: MouseEvent, entry: OpenChat): void => {
    const prompts = entry.conversation.messages.value.filter((message) => message.role === `user`);
    const first = prompts[0];
    const last = prompts.at(-1);
    hoverCard.value?.show(event, {
        title: entry.conversation.title.value ?? undefined,
        // Labelled "Latest" only when two prompts differ; a fresh draft with neither shows no preview.
        messages: [
            ...(first === undefined ? [] : [{ text: first.text, attachments: first.attachments }]),
            ...(last === undefined || last === first ? [] : [{ label: `Latest`, text: last.text, attachments: last.attachments }]),
        ],
    });
};
const hidePreview = (): void => {
    hoverCard.value?.hide();
};

// Plain click switches to just that row; Ctrl/Cmd+click toggles a column beside it; Shift+click ranges from the
// anchor — the same gestures and verbs as the terminal strip's onSegmentClick.
// Rows on screen mirror the pane set at one ring weight (RailCard.selected); the focused chat is always included.
const showing = (id: string): boolean => panes.value.includes(id);
// Whether a pane can be given back: the last one is the panel itself, so Close Pane needs at least two.
const split = computed(() => panes.value.length > 1);
// Panes exist only on wide surfaces; the docked column is too narrow for a second chat (see ChatPanel).
const paneable = computed(() => chatWide.value);

// Reading order across the drawn lanes (status, then recency), used to resolve what a Shift+range selects.
const rowOrder = computed<string[]>(() => occupiedLanes.value.flatMap((lane) => cardsIn(lane.key).map((entry) => entry.conversation.conversationId)));
const anchor = ref<string>();

// Broadcasts the same reveal to other windows (relaySummons) so their fleet boards ring the conversation this
// rail is showing. Conversations fold to their wire form, so a window that never opened one can rebuild the tab.
const relayRows = (verb: RevealVerb, ids: readonly string[], focus: string): void => {
    const entries = ids.flatMap((id) => conversations.value.filter((conversation) => conversation.conversationId === id));
    relaySummons({ kind: `reveal`, verb, entries, focus, caret: false });
};

// ChatPersonaRail raises the same selection, told the same way so the board stays in step regardless of which
// list was used.
const onPersonaSelect = (id: string): void => {
    emit(`select`, id);
    relayRows(`focus`, [id], id);
};

const onRowClick = (event: MouseEvent, id: string): void => {
    if (!paneable.value) {
        anchor.value = id;
        emit(`select`, id);
        // `focus`, not `show`: this surface has no panes, so no split of its own to collapse.
        relayRows(`focus`, [id], id);
        return;
    }
    if (event.shiftKey) {
        const order = rowOrder.value;
        const from = order.indexOf(anchor.value ?? activeId.value);
        const to = order.indexOf(id);
        if (to !== -1) {
            const run = from === -1 ? [id] : order.slice(Math.min(from, to), Math.max(from, to) + 1);
            setPanes(run);
            relayRows(`panes`, run, id);
        }
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        anchor.value = id;
        // Toggle: a chat with a column gives it back; one without takes a new column beside the focus.
        if (showing(id) && split.value) {
            closePane(id);
            relayRows(`unpane`, [id], id);
            return;
        }
        openBeside(id);
        relayRows(`beside`, [id], id);
        return;
    }
    anchor.value = id;
    emit(`select`, id);
    // Resets any split to just this row; matters only where panes are drawn (docked keeps but hides the split).
    collapsePanes();
    // `show` bundles select + collapse into the one verb other windows apply.
    relayRows(`show`, [id], id);
};

// Target for the share dialog: the right-clicked chat may no longer be on screen by the time it's answered.
const shareTarget = ref<{ id: string; title: string }>();
const openShare = (id: string): void => {
    const conversation = conversations.value.find((entry) => entry.conversationId === id);
    if (conversation !== undefined) {
        shareTarget.value = { id, title: tabLabel(conversation) };
    }
};

// Same close actions as the workspace's file tabs, plus rename and the pop-out toggle. Acts on the right-clicked
// card (menuTabId), never the active one — its keyboard commands live with the panel header instead.
const tabMenu = ref<{ show: (event: Event) => void } | undefined>();
const menuTabId = ref<string>();

const tabMenuItems = computed<MenuItem[]>(() => {
    const id = menuTabId.value;
    if (id === undefined || !conversations.value.some((conversation) => conversation.conversationId === id)) {
        return []; // no card named, or the right-clicked one closed under the open menu
    }
    const others = othersOf(id);
    const toRight = toRightOf(id);
    const finished = tabsInLane(`finished`);
    const peeked = conversations.value.find((conversation) => conversation.conversationId === id)?.peek.value === true;
    return [
        // Keep Open leads the menu, shown only on a preview tab: same convention and wording as WorkspaceDesktop.
        ...(peeked ? [{ label: `Keep Open`, icon: `pin` as IconName, command: () => keepChat(id) }, { separator: true }] : []),
        { label: `Rename`, icon: `pencil`, shortcut: commandShortcut(`chat.rename`), command: () => beginRename(id) },
        // Share opens a dialog rather than acting directly; it renders a frozen snapshot, the conversation is
        // unchanged.
        { label: `Share…`, icon: `globe`, command: () => openShare(id) },
        { separator: true },
        // Open Beside/Close Pane mirror Ctrl+click; unlike Close, they give back the column without ending the chat.
        ...(paneable.value
            ? [
                  // No glyph, like the terminal's Split row; not the ×, which would suggest this ends the chat.
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
            label: floats.value ? `Dock chat back` : `Move chat into new window`,
            shortcut: commandShortcut(`chat.toggleFloating`),
            command: (): void => toggleChatFloating(),
        },
    ];
});

const openTabMenu = (id: string, event: Event): void => {
    // Pointer stays on the card, so the hover preview would otherwise never leave on its own.
    hidePreview();
    menuTabId.value = id;
    tabMenu.value?.show(event);
};

// The × sits inside the card's click target; stop propagation or it also selects the row.
const closeTab = (event: Event, id: string): void => {
    event.stopPropagation();
    emit(`close`, new Set([id]));
};

// Keeps a peeked chat open (Conversation.peek); local only, since other windows read the peek mark off the
// published strip.
const keepTab = (event: Event, id: string): void => {
    event.stopPropagation();
    keepChat(id);
};
</script>

<template>
    <div class="flex min-h-0 flex-col gap-1.5">
        <!--
            Reading order top to bottom: narrow with the filter, pick a lane, and when the query reaches past what's
            open, the "Not open" group at the foot.
        -->
        <!--
            The `Aa` case toggle mirrors the board's: a mode only one of the two search boxes could see or undo would
            be confusing.
        -->
        <!--
            Full-width because this switch decides what the column IS, not a filter on it — it reads as the column's own
            header. `stretch` keeps a pointer-sized track at `xs` (SegmentedControl honours the density prop).
        -->
        <SegmentedControl
            :model-value="grouping"
            :options="GROUPINGS"
            size="xs"
            stretch
            class="shrink-0"
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
            aria-label="Filter chats by your messages"
            placeholder="Filter by your messages…"
            class="shrink-0"
        />
        <!--
            A different list, not this one regrouped — its own component (see ChatPersonaRail). Emits the same `select`
            this file does, so the host focuses a chat the same way from either list.
        -->
        <ChatPersonaRail v-if="grouping === `persona`" @select="onPersonaSelect" />
        <!--
            LANE BREAKS OUTRANK CARD BREAKS, and at 12px against 10px they barely did: the eye groups by proximity,
            so two gaps that close together read as one flat list with headings dropped into it rather than as three
            groups. 16px against 10px is the smallest ratio that separates them.
        -->
        <div v-else ref="scroller" class="scrollbar-thin flex min-h-0 flex-1 flex-col items-stretch gap-4 overflow-y-auto">
            <!--
                An empty lane isn't drawn at all (see occupiedLanes); one emptied only by the filter keeps its header, so the
                list doesn't reshuffle under the cursor mid-keystroke.
            -->
            <RailLane v-for="lane in occupiedLanes" :key="lane.key" :label="lane.label" :dot="lane.dot" :count="countIn(lane.key)">
                <!--
                    Same act and wording as the board's Finished lane (there it archives, here it closes the chats); on every
                    lane, since a close is lossless whatever the lane — the turn detaches and keeps running, unsent words are
                    set aside, and the chat is still on the board. Shown only where it would close something, and hidden while
                    filtering, since it would close more than the query matched.
                -->
                <template #actions>
                    <Button
                        v-if="clearing[lane.key].size > 0 && !filtering"
                        size="small"
                        severity="secondary"
                        :text="true"
                        class="shrink-0"
                        :aria-label="clearLabel(lane)"
                        v-tooltip.bottom="`Close all ${clearing[lane.key].size}: ${lane.keeps}`"
                        @click="emit('close', clearing[lane.key])"
                    >
                        Clear
                    </Button>
                </template>
                <!--
                    Dashed like the board's run card: a run is the container for the rows below it, not one of them. Click opens
                    it the same way the board does (openRunInChat) — live sessions into the panes, or the diagram when nothing
                    is live.
                -->
                <div v-if="runsIn(lane.key).length > 0" class="flex min-w-0 flex-col gap-2.5">
                    <RailCard
                        v-for="run in runsIn(lane.key)"
                        :key="run.runId"
                        :title="run.workflow.name"
                        icon="sitemap"
                        dashed
                        :selected="runOnScreen(run)"
                        :aria-label="`Open the workflow run ${run.workflow.name}`"
                        @click="openRunInChat(run)"
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
                <p v-if="cardsIn(lane.key).length === 0 && runsIn(lane.key).length === 0" class="px-1 text-2xs text-subtle">No matches</p>
                <div v-else-if="cardsIn(lane.key).length > 0" class="flex min-w-0 flex-col gap-2.5">
                    <template v-for="{ conversation: c, agent } in cardsIn(lane.key)" :key="c.conversationId">
                        <!--
                            Replaces the card rather than nesting a field in it (a button can't host a usable input). Enter/blur commit,
                            Esc cancels, an empty or unchanged name silently cancels — the WorkspaceTree convention (createInlineRename).
                        -->
                        <input
                            v-if="edit.editing && renamingId === c.conversationId"
                            v-model="edit.draft"
                            type="text"
                            maxlength="80"
                            aria-label="Chat title"
                            :placeholder="c.isolated.value ? 'New agent' : 'New chat'"
                            class="ui-field-box ui-field-inline w-full shrink-0 select-text rounded-lg px-2.5 py-2 text-xs font-semibold placeholder:font-normal"
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
                            :match-case="matchCase"
                            :provider="agent?.provider ?? c.provider.value"
                            :status="statusOf({ conversation: c, agent })"
                            :context="contextOf({ conversation: c, agent })"
                            :unfinished="agent?.unfinished"
                            :live="liveOf({ conversation: c, agent })"
                            :now="now"
                            tight
                            :selected="activeId === c.conversationId || showing(c.conversationId)"
                            :peek="c.peek.value"
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
                                <!--
                                    The × is a hit target around an 11px glyph; a miss lands on the card and re-selects it. Sits beside the
                                    status glyph on hover (AgentCard's pattern), so nothing shifts as the pointer crosses.
                                -->
                                <!--
                                    A peeked card offers the pin in the same slot every other card offers its ×, so nothing shifts on hover. It's
                                    the only visible cue for peek besides the italic title.
                                -->
                                <span
                                    v-if="c.peek.value"
                                    role="button"
                                    aria-label="Keep this chat open"
                                    v-tooltip.top="'Keep open, otherwise this chat closes when you open another'"
                                    class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                                    @click="keepTab($event, c.conversationId)"
                                >
                                    <Icon name="pin" class="text-2xs" />
                                </span>
                                <span
                                    v-else-if="conversations.length > 1"
                                    role="button"
                                    aria-label="Close chat"
                                    class="-my-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted opacity-0 transition hover:bg-overlay hover:text-content focus-visible:opacity-100 group-hover:opacity-100"
                                    @click="closeTab($event, c.conversationId)"
                                >
                                    <Icon name="times" class="text-2xs" />
                                </span>
                            </template>
                            <!--
                                One line: why it needs attention or is unread, where it came from, the model, and (settled only) its age,
                                right-aligned. Reads from the fleet entry when there is one, else the conversation.
                            -->
                            <template v-if="hasMeta({ conversation: c, agent })" #meta>
                                <span
                                    v-if="agent !== undefined && attentionReason(agent) !== undefined"
                                    class="shrink-0 rounded-full bg-warning/15 px-1.5 py-px font-semibold text-warning"
                                    >{{ attentionReason(agent) }}</span
                                >
                                <!-- Same slot as the attention chip: never both at once, "needs you" outranks "unread". -->
                                <span
                                    v-else-if="agent !== undefined && unreadBadge(agent) !== undefined"
                                    v-tooltip.top="
                                        unreadBadge(agent)!.seenAt === undefined
                                            ? undefined
                                            : `Worked since you last opened it, ${relativeTime(unreadBadge(agent)!.seenAt!)}`
                                    "
                                    class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-px font-semibold text-link"
                                    >{{ unreadBadge(agent)!.label }}</span
                                >
                                <!--
                                    Grouped with the attention/unread chips: same question, answered by the reader's own unfinished draft. Read
                                    from the conversation, not the fleet entry — this rail only renders in the window holding that composer.
                                -->
                                <UnsentMark v-if="c.unsent.value" :preview="draftPreview(c.draft.value)" :at="c.draftAt.value" :now="now" />
                                <!-- Provenance marks (external origin, workflow), same as the board's OriginMark in the card body. -->
                                <OriginMark :origin="originOf(c)" compact />
                                <WorkflowMark :workflow="agent?.workflow" compact />
                                <!--
                                    Which sandbox the chat runs in, when not this one (Conversation.box): two identical-looking rows can be on
                                    different machines. Named in the tooltip, since the glyph alone can only say "somewhere else".
                                -->
                                <span
                                    v-if="c.box.value !== undefined"
                                    v-tooltip.top="`Runs in “${boxNameOf.get(c.box.value!) ?? `another sandbox`}”`"
                                    class="flex shrink-0 items-center"
                                    :aria-label="`Runs in ${boxNameOf.get(c.box.value!) ?? `another sandbox`}`"
                                >
                                    <Icon name="boxes" class="text-2xs text-subtle" />
                                </span>
                                <span v-if="isArchived(c)" class="flex shrink-0 items-center" aria-label="Archived">
                                    <Icon name="box" class="text-2xs text-subtle" />
                                </span>
                                <!-- Spend, diff and turn count are deliberately absent here; they live on the board and Usage tab. -->
                                <span v-if="modelOf({ conversation: c, agent }) !== undefined" class="max-w-24 truncate">{{
                                    modelOf({ conversation: c, agent })
                                }}</span>
                                <!-- Age is shown only when settled; a running card's clock is the live line's elapsed readout instead. -->
                                <span v-if="agent !== undefined && !turnInFlight(agent) && agent.updatedAt > 0" class="ml-auto shrink-0">{{
                                    relativeTime(agent.updatedAt)
                                }}</span>
                            </template>
                        </RailCard>
                    </template>
                </div>
                <!--
                    Not a pager — the count itself is the point ("12 more open"), one press away rather than gone. Same row as
                    the board's, at rail width; hidden while filtering since the window is lifted then.
                -->
                <button
                    v-if="lane.key === 'finished' && !filtering && hiddenFinished > 0"
                    type="button"
                    :class="ui.addTile(`gap-1 rounded-lg py-1.5 text-2xs`)"
                    @click="showAllFinished = !showAllFinished"
                >
                    <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                </button>
            </RailLane>

            <!--
                Query hits outside this window's open chats (fleet, archive, agent-less conversations); a row opens the
                conversation, same as History. Same card shape as the lanes above, just muted.
            -->
            <RailLane v-if="filtering && notOpenCount > 0" label="Not open" icon="search" :count="notOpenCount">
                <div class="flex min-w-0 flex-col gap-2.5">
                    <!-- Same identity tile as the lanes above; the category tint still signals what kind of work this is. -->
                    <RailCard
                        v-for="agent in notOpen"
                        :key="agent.id"
                        :title="agent.title ?? 'Untitled agent'"
                        :needle="needle"
                        :match-case="matchCase"
                        :provider="agent.provider"
                        quiet
                        :snippet="snippetOf(agent)"
                        @click="emit('open', agent.id)"
                    >
                        <template #meta>
                            <!-- Archived, not gone: the branch, diff and transcript all survive, so this is a real destination. -->
                            <Icon v-if="agent.archivedAt !== undefined" name="box" class="shrink-0 text-2xs" aria-label="Archived" />
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
        <!-- A failed rename already reverted the title; this explains why, cleared by the next rename. -->
        <span v-if="edit.error !== undefined" class="shrink-0 truncate px-1 text-2xs text-danger" v-tooltip.bottom.overflow="edit.error">{{
            edit.error
        }}</span>

        <!--
            Both teleport out (hover card to the overlay target, menu to `append-to`); kept here only so the component
            stays single-rooted, since a fragment root would drop the sizing classes its hosts pass in.
        -->
        <HoverCard ref="hoverCard" />
        <ContextMenu ref="tabMenu" :model="tabMenuItems" :min-width="13" />
        <ChatShareDialog
            v-if="shareTarget"
            visible
            :conversation-id="shareTarget.id"
            :title="shareTarget.title"
            @update:visible="!$event && (shareTarget = undefined)"
        />
    </div>
</template>
