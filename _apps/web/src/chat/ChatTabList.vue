<script setup lang="ts">
import { ContextMenu, type IconName } from "@intentic/ui";
import type { MenuItem } from "primevue/menuitem";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createTitleEdit } from "../composables/agents/titleEdit";
import {
    activityIcon,
    activityLine,
    agentStatusMeta,
    attentionReason,
    type FleetLane,
    formatCost,
    formatElapsed,
    turnInFlight,
    unreadBadge,
} from "../composables/agents/agentStatus";
import { sessionCategory } from "../composables/sessionCategory";
import IdentityTile from "../components/IdentityTile.vue";
import { markSegments, useAgentFilter } from "../composables/agents/useAgentFilter";
import { type FleetAgent, useAgents, windowFinished } from "../composables/agents/useAgents";
import FilterField from "../components/FilterField.vue";
import HoverCard from "../components/HoverCard.vue";
import OriginMark from "../components/OriginMark.vue";
import WorkflowMark from "../components/WorkflowMark.vue";
import { relativeTime, statusIcon, statusLabel } from "../composables/chat/catalog";
import type { Conversation } from "../composables/chat/conversation";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { allTabs, finishedTabs, isArchived, laneOfTab, originOf, othersOf, tabLabel, toRightOf } from "../composables/chat/tabs";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { commandShortcut } from "../composables/commands/useCommands";
import { viewersOfSession } from "../composables/usePresence";
import PresenceAvatars from "../presence/PresenceAvatars.vue";
import { providerLabel } from "@intentic/sandbox-contract";

/* THE OPEN CHATS, as the fleet board's three lanes in miniature — the switcher for every conversation this
 * window holds. It has two hosts and is the same list in both: the sheet the docked panel's header drops
 * (ChatTabs), and the rail down the left edge of a popped-out window. It used to be rail-only, while the
 * docked panel wore a row of pill tabs that wrapped to a second line — a strictly worse switcher (a dot and
 * ~28 characters of a title, in rows that reflowed on every open and close) built out of a second set of
 * components. One list, two frames.
 *
 * IT IS THE BOARD'S CARD IN A COLUMN ONE CARD WIDE, and that is a design rule rather than a resemblance —
 * /agents and this list are read minutes apart by the same eye, so anything they draw differently reads as
 * two different products. What "in miniature" costs is only the facts that need width the rail lacks (the
 * branch, the token counters); it does not license a second visual grammar. The card's rows, top to bottom:
 *
 *   · the LEADING mark is the chat's IDENTITY TILE (IdentityTile) — the kind-of-work glyph on a tint of the
 *     chat's CATEGORY hue (sessionCategory: the title's action word read as a Conventional Commit type —
 *     audits a blue magnifier, redesigns purple arrows, new work a green plus, fixes a red wrench). Shape and
 *     colour carry the same fact twice, so the tile reads without a legend. A chat whose title reads as
 *     nothing wears the provider mark on neutral chrome instead — for a draft, "whose runtime" is the most a
 *     tile can truthfully say. Always present, so every title starts at one x.
 *   · the TRAILING glyph is the status, in a fixed slot at the end of the title row, with the × taking the
 *     slot beside it on hover (AgentCard's hover-action pattern).
 *   · the title is the card's one piece of CONTENT and takes the content tier (text-xs, semibold) over a
 *     card of text-2xs meta — the board's own hierarchy. A card set entirely in one size is a card with no
 *     first line to land on, which is what made a column of these read as a wall.
 *   · the META line carries the card's facts at the board's own picks: the attention/unread chip, provenance
 *     marks, the model, cost, the diff, the message count, and the age right-aligned.
 *   · a RUNNING card adds the board's live line — tool glyph, what it is doing, and the ticking elapsed — in
 *     link, so the sessions that are working are findable in a column of stopped ones.
 *
 * EACH LANE IS A SLAB (`.lane`), the board's kanban column at one card's width: a rounded surface the lane's
 * cards lie on, capped by its own header and separated from the next lane by a gap rather than by a colour
 * change. Cards are opaque and a step lighter than it. Both halves of that are load-bearing and both were
 * once wrong here — cards were a translucent wash of the canvas colour, which in the pop-out (a canvas body)
 * mixed to exactly the ground they were drawn on, and the header was a bg-canvas band, which on that same
 * ground was a black rectangle with a hard edge butting into the first card.
 *
 * Colour is spent the way the board spends it: the work's category in the tile, status in the glyph, the
 * reason in a chip, the live readout in link, diffs in success/danger — and everything else neutral, so an
 * accent on screen always means something.
 *
 * The list reads the stores and emits verbs rather than writing them: the panel that hosts it is what hands
 * each verb to useChat, exactly as the strip always did. */

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the right-click menu's Close Others / to the Right / All close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const { conversations, activeId, tabReveal } = useChat();
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

// A chat with no fleet entry (a plain conversation, or the roster briefly down) has no transcript the daemon
// can search under an agent id, so it is matched on what this browser holds: its title and its own messages.
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
        entry.conversation.messages.value.some((message) => message.role === `user` && message.text.toLowerCase().includes(needle.value))
    );
};

const lanes = computed<Record<FleetLane, OpenChat[]>>(() => {
    const grouped: Record<FleetLane, OpenChat[]> = { attention: [], active: [], finished: [] };
    for (const conversation of conversations.value) {
        const agent = agentById(conversation.conversationId);
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
    grouped.finished.sort((a, b) => lastActive(b) - lastActive(a));
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
const occupiedLanes = computed(() => LANES.filter((lane) => lanes.value[lane.key].length > 0));

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
 * having lost the conversation. */
const showAllFinished = ref(false);
const windowed = computed(() => !filtering.value && !showAllFinished.value);
const finishedWindow = computed(() =>
    windowFinished(lanes.value.finished, windowed.value ? activeId.value : undefined, (entry) => entry.conversation.conversationId),
);
const hiddenFinished = computed(() => finishedWindow.value.hidden);

// A lane's visible chats, and how many of its own it is showing. Same `n of m` the board's lane headers carry,
// for the same reason: a lane that silently shrinks is a lane that has stopped saying anything. The denominator
// is the LANE, not the window — the row beneath the cards is what accounts for the difference.
const cardsIn = (lane: FleetLane): OpenChat[] => {
    const source = lane === `finished` && windowed.value ? finishedWindow.value.shown : lanes.value[lane];
    return source.filter(tabMatches);
};
const countIn = (lane: FleetLane): string =>
    filtering.value ? `${cardsIn(lane).length} of ${lanes.value[lane].length}` : String(lanes.value[lane].length);

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

// One second ticks every running card's elapsed readout together (the board's `now` pattern) — armed while
// this list is on screen, which for the docked sheet means only while it is open.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    ticker = setInterval(() => {
        now.value = Date.now();
    }, 1000);
});
onBeforeUnmount(() => clearInterval(ticker));

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
        <FilterField
            v-model="filterQuery"
            :busy="searching"
            label="Filter chats by your messages"
            placeholder="Filter by your messages…"
            class="shrink-0"
        />
        <div ref="scroller" class="scrollbar-thin flex min-h-0 flex-1 flex-col items-stretch gap-3 overflow-y-auto">
            <!-- A lane with nothing in it is not drawn at all (occupiedLanes — and see the note there before
                 reaching for `v-show` here); a lane the FILTER emptied keeps its header and says so, so the
                 list doesn't reshuffle under the cursor mid-keystroke. -->
            <section v-for="lane in occupiedLanes" :key="lane.key" class="lane flex min-w-0 flex-col rounded-xl p-1">
                <!-- The board's lane header, at the board's weights — dot, label, and the count as a pill
                     rather than a loose number. It is the SLAB'S CAP (see .lane): full-bleed to the lane's
                     rounded top through the negative margins, painted in the lane's own fill so the two never
                     seam, and PINNED while its own lane scrolls (the stacked board's behaviour, and the same
                     argument: a column this tall is read a screen at a time, and a card only means "finished"
                     while the lane it belongs to is still on screen). It was a bg-canvas band before, which in
                     a pop-out — a canvas body — was a black rectangle with a hard edge against the first card.
                     Its text starts where a card's content does, so the lane reads down one left edge. -->
                <header class="lane-header sticky top-0 z-10 -mx-1 -mt-1 flex items-center gap-2 rounded-t-xl px-3.5 pb-2 pt-2.5">
                    <span class="h-2 w-2 shrink-0 rounded-full" :class="lane.dot"></span>
                    <span class="text-2xs font-semibold uppercase tracking-wide text-muted">{{ lane.label }}</span>
                    <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ countIn(lane.key) }}</span>
                    <span class="flex-1"></span>
                    <!-- "CLEAR", in the slot and the word the board's Finished lane uses — the same act on the
                         same lane, at the scale the lane is at: there it archives the agents, here it closes
                         their chats. Both are lossless and neither asks, which is what earns the one-press
                         treatment; the tooltip names where the chats go. It was reachable only through a card's
                         right-click menu before, which is a hunt for a target to perform an action that has no
                         target — the lane is the target, so the lane's header is where it belongs.
                         Gone while filtering, exactly as the board's is: this closes the WHOLE lane, and
                         offering it above a lane reading "1 of 12" is offering a bulk action whose scope is not
                         the one on screen. -->
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
                </header>
                <p v-if="cardsIn(lane.key).length === 0" class="px-2.5 pb-1.5 text-2xs text-subtle">No matches</p>
                <div v-else class="flex min-w-0 flex-col gap-1.5">
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
                        <button
                            v-else
                            type="button"
                            :data-chat-tab="c.conversationId"
                            class="chat-tab rail-card group flex w-full min-w-0 shrink-0 scroll-mt-8 flex-col gap-1.5 rounded-lg p-2.5 text-left text-2xs"
                            :class="{ 'chat-tab-on': activeId === c.conversationId, 'rail-card-attention': lane.key === 'attention' }"
                            @click="emit('select', c.conversationId)"
                            @dblclick.prevent.stop="beginRename(c.conversationId)"
                            @contextmenu.prevent.stop="openTabMenu(c.conversationId, $event)"
                            @mouseenter="showPreview($event, { conversation: c, agent })"
                            @mouseleave="hidePreview"
                        >
                            <span class="flex w-full min-w-0 items-start gap-2">
                                <!-- The IDENTITY TILE leads (see the header comment). Sized to the title's
                                     first line so a two-line title hangs off it, not around it. -->
                                <IdentityTile
                                    :title="tabLabel(c)"
                                    :provider="agent?.provider ?? c.provider.value"
                                    class="-mt-px h-[18px] w-[18px] text-2xs"
                                />
                                <!-- Two lines before the clamp — a card has the width for most titles whole.
                                     The content tier over a card of meta: this is the one line being READ.
                                     Neutral, always: the status colour lives in the glyph beside it, and a
                                     column of orange titles is one where nothing stands out. -->
                                <span class="line-clamp-2 min-w-0 flex-1 text-xs font-semibold leading-4 text-content">
                                    <span
                                        v-for="(run, at) in markSegments(tabLabel(c), needle)"
                                        :key="at"
                                        :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''"
                                        >{{ run.text }}</span
                                    >
                                </span>
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
                                <!-- Status closes the row, in the board's own slot for it. The REASON an agent
                                     is in Attention rides the line below instead of replacing this glyph (the
                                     board's chip does replace it): a chip is a hundred pixels of words, and
                                     spending them here would leave the title of the one card that most needs
                                     reading with sixty pixels to be read in. -->
                                <span class="flex h-4 shrink-0 items-center">
                                    <Icon v-bind="statusOf({ conversation: c, agent })" />
                                </span>
                            </span>
                            <!-- The crucial facts, one wrapping line at the board's own picks: why it needs
                                 you (or that it's unread), where it came from, the model, cost, diff, how
                                 long a conversation it has been — and the age, right-aligned. Drawn from the
                                 fleet entry where there is one and from the conversation where there isn't
                                 (see "What the card knows"), so an off-roster chat keeps a populated card.
                                 Quiet by default: these are reference numbers, not events, so the only colour
                                 on the line is the one that means something. -->
                            <span
                                v-if="hasMeta({ conversation: c, agent })"
                                class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted"
                            >
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
                            </span>
                            <!-- THE LIVE LINE, the board's own: what the turn is doing this second and how
                                 long it has been at it, in link — the one accent that makes a working card
                                 findable in a column of stopped ones. Held through a stop's UNWIND
                                 (turnInFlight, not `running`): the turn is still live there, the elapsed
                                 keeps its meaning, and the line freezes on what it was doing when the user
                                 stopped it — blinking it off a beat before the card settles is the same
                                 flicker the stopping state exists to remove. -->
                            <span
                                v-if="liveOf({ conversation: c, agent }) !== undefined"
                                class="flex w-full min-w-0 items-center gap-1.5 text-2xs font-medium text-link"
                            >
                                <Icon :name="liveOf({ conversation: c, agent })!.icon" class="shrink-0 text-2xs" />
                                <span class="min-w-0 flex-1 truncate">{{ liveOf({ conversation: c, agent })!.text }}</span>
                                <span v-if="liveOf({ conversation: c, agent })!.since !== undefined" class="shrink-0">{{
                                    formatElapsed(liveOf({ conversation: c, agent })!.since!, now)
                                }}</span>
                            </span>
                            <!-- WHY this chat survived the filter, when the reason isn't its title (that one
                                 is marked in place above). The board's cards carry the same line for the
                                 same reason: a result the user can't see the cause of is one they stop
                                 believing. -->
                            <span
                                v-if="agent !== undefined && snippetOf(agent) !== undefined"
                                class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted"
                            >
                                <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                                <span class="line-clamp-2 min-w-0 flex-1 italic leading-4">
                                    <span
                                        v-for="(run, at) in markSegments(snippetOf(agent) ?? '', needle)"
                                        :key="at"
                                        :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''"
                                        >{{ run.text }}</span
                                    >
                                </span>
                            </span>
                        </button>
                    </template>
                </div>
                <!-- The lane's tail, not a pager: the count is the point ("there are 12 more open"), and the
                     row is what keeps them one press away instead of gone. The board's own row, at the rail's
                     width. Gone while filtering — the window is lifted there, so there is nothing behind it. -->
                <button
                    v-if="lane.key === 'finished' && !filtering && hiddenFinished > 0"
                    type="button"
                    class="mt-1.5 inline-flex items-center justify-center gap-1 rounded-lg border border-dashed border-line py-1.5 text-2xs text-muted transition-colors hover:border-line-strong hover:text-content"
                    @click="showAllFinished = !showAllFinished"
                >
                    <Icon :name="showAllFinished ? 'chevron-up' : 'chevron-down'" class="text-2xs" />
                    {{ showAllFinished ? "Show fewer" : `${hiddenFinished} earlier` }}
                </button>
            </section>

            <!-- WHAT THE QUERY FOUND THAT ISN'T OPEN HERE. This list holds the chats of this window, which is
                 almost never the set the question "where did I say X" is about — so the filter reaches the
                 whole fleet (live agents, the archive) and the conversations no agent owns, and puts them here.
                 A row opens the conversation, which is exactly the act the History menu performs; the
                 difference is that this list was found rather than browsed.
                 A lane of the same shape as the three above it, down to the card skin: these are destinations,
                 not footnotes, and the board makes the same call with its own off-board hits (real cards, in a
                 group with a header). Only the ink is dropped a step — a muted title, no status glyph — since
                 nothing here is a session you are currently in. -->
            <section v-if="filtering && notOpenCount > 0" class="lane flex min-w-0 flex-col rounded-xl p-1">
                <header class="lane-header sticky top-0 z-10 -mx-1 -mt-1 flex items-center gap-2 rounded-t-xl px-3.5 pb-2 pt-2.5">
                    <Icon name="search" class="shrink-0 text-2xs text-subtle" />
                    <span class="text-2xs font-semibold uppercase tracking-wide text-muted">Not open</span>
                    <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ notOpenCount }}</span>
                </header>
                <div class="flex min-w-0 flex-col gap-1.5">
                    <button
                        v-for="agent in notOpen"
                        :key="agent.id"
                        type="button"
                        class="chat-tab rail-card flex w-full min-w-0 shrink-0 flex-col gap-1.5 rounded-lg p-2.5 text-left text-2xs"
                        @click="emit('open', agent.id)"
                    >
                        <span class="flex w-full min-w-0 items-start gap-2">
                            <!-- The same identity tile as the lanes above: a hit here is a destination, and
                                 the category tint says what kind of work it will turn out to be. Only the
                                 TEXT ink drops a step, since nothing here is a session you are currently in. -->
                            <IdentityTile :title="agent.title" :provider="agent.provider" class="-mt-px h-[18px] w-[18px] text-2xs" />
                            <span class="line-clamp-2 min-w-0 flex-1 text-xs font-medium leading-4 text-muted">
                                <span
                                    v-for="(run, at) in markSegments(agent.title ?? 'Untitled agent', needle)"
                                    :key="at"
                                    :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''"
                                    >{{ run.text }}</span
                                >
                            </span>
                        </span>
                        <span class="flex w-full min-w-0 items-center gap-x-2 text-2xs text-subtle">
                            <!-- Off the board but not gone: the branch, the diff and the transcript all survive an
                             archive, so a hit here is a real destination rather than a tombstone. -->
                            <Icon v-if="agent.archivedAt !== undefined" name="box" class="shrink-0 text-2xs" aria-label="Archived" />
                            <span v-if="agent.updatedAt > 0" class="ml-auto shrink-0">{{ relativeTime(agent.updatedAt) }}</span>
                        </span>
                        <span v-if="snippetOf(agent) !== undefined" class="flex w-full min-w-0 items-start gap-1 text-2xs text-muted">
                            <Icon name="search" class="mt-px shrink-0 text-2xs text-subtle" />
                            <span class="line-clamp-2 min-w-0 flex-1 italic leading-4">
                                <span
                                    v-for="(run, at) in markSegments(snippetOf(agent) ?? '', needle)"
                                    :key="at"
                                    :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''"
                                    >{{ run.text }}</span
                                >
                            </span>
                        </span>
                    </button>
                    <!-- Conversations no agent entry owns — a plain chat, or one whose entry is long gone. Nothing
                     to draw a provider mark or a status for; the title and the matched line are the whole of
                     what is known about them. -->
                    <button
                        v-for="session in sessionMatches"
                        :key="session.id"
                        type="button"
                        class="chat-tab rail-card flex w-full min-w-0 shrink-0 flex-col gap-1.5 rounded-lg p-2.5 text-left text-2xs"
                        @click="emit('open', session.id)"
                    >
                        <span class="flex w-full min-w-0 items-start gap-1.5">
                            <span class="flex h-4 shrink-0 items-center">
                                <Icon name="comments" class="text-xs text-subtle" />
                            </span>
                            <span class="line-clamp-2 min-w-0 flex-1 text-xs font-medium leading-4 text-muted">{{ session.title }}</span>
                            <span class="shrink-0 text-2xs text-subtle">{{ relativeTime(session.updatedAt) }}</span>
                        </span>
                        <span v-if="session.snippet !== undefined" class="line-clamp-2 pl-5 text-2xs italic leading-4 text-subtle">{{
                            session.snippet
                        }}</span>
                    </button>
                </div>
            </section>
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

<style scoped>
/* The card's surface — AgentCard's skin (visible border, OPAQUE fill) over .chat-tab's behaviour. A
 * transparent pill blends into a column of pills; a bordered card is what makes each session a countable
 * thing. Scoped selectors outweigh chat.css's single-class rules, so these win without !important.
 *
 * `--color-card` on the LANE's fill, exactly as the board's cards sit on their lanes: a card has to be
 * LIGHTER than what it lies on to read as an object rather than as an outline, and `.lane` is mixed to land
 * between canvas and card in both schemes precisely so this holds. The fill this replaced was a 45% wash of
 * the canvas colour, which in the pop-out — whose body IS canvas — composited to the ground it was drawn on,
 * leaving nothing but the 1px border. */
.rail-card {
    border-color: var(--color-line);
    background: var(--color-card);
    /* Two independent marks on one box-shadow: the attention bar (inset, left edge) and the active ring
       (outset, all round). Held as variables because a second box-shadow rule would REPLACE the first, which
       is what forced the old either/or below. */
    --rail-accent: 0 0 #0000;
    --rail-ring: 0 0 #0000;
    box-shadow: var(--rail-accent), var(--rail-ring);
}
/* AgentCard's hover, to the letter: the surface lifts a step and the edge sharpens. .chat-tab's own hover is
 * a wash of the CONTENT colour, which over an opaque card reads as the text bleeding rather than as the box
 * responding — so the card overrides both halves of it. */
.rail-card:hover {
    border-color: var(--color-line-strong);
    background: var(--color-overlay);
}
/* THE SAME TWO CHANNELS THE BOARD USES (see AgentCard): the card the transcript beside it is showing gets a
 * ring and a lifted fill, an agent that needs the user gets a bar down its left edge. Drawn in different
 * places, so the list no longer has to choose between them — the old rule dropped the warning the moment you
 * opened the card, on the theory that "you are here" outranks "this needs you", which quietly cost the one
 * card most likely to be read the only mark saying why it was in that lane. An inset shadow rather than a
 * wider left border: no layout shift, so a stacked lane's cards keep their text on one axis. */
.rail-card.chat-tab-on {
    border-color: var(--color-primary-500);
    background: var(--color-overlay);
    --rail-ring: 0 0 0 2px color-mix(in srgb, var(--color-primary-500) 50%, transparent);
}
.rail-card-attention {
    --rail-accent: inset 3px 0 0 0 var(--color-warning);
}
</style>
