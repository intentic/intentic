<script setup lang="ts">
import { Button, Icon, ResizeSeam, useDevice, ui } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CAPACITY_RAIL_PX, hasCapacity, railFitsBeside } from "./chatCapacity";
import { accountsLoaded } from "../accounts/providerAccounts";
import { chatRun, closeRun, modeForSessions, type RunSession, runOnFocus, runToFollow, showingRunGraph, showRun } from "../run/chatRun";
import type { Conversation } from "../session/conversation";
import { traceFocus } from "../run/focusTrace";
import { openRunSessions } from "../run/openRun";
import { DEFAULT_RAIL_WIDTH, railWidth } from "../../agents/board/columnWidth";
import { chatOnRail, chatWide } from "./chatPanelLayout";
import { useChat } from "../run/useChat";
import { useChatFloating } from "./chatFloating";
import { useWorkflowRuns } from "../../agents/fleet/useWorkflowRuns";
import { defaultChatWidth, maxChatWidth, MIN_CHAT_WIDTH, MIN_PANE_PX, useLayout } from "../../../shell/window/useLayout";
import { toAppPx, toScreenPx, uiLength } from "../../../shell/window/uiScale";
import ChatCapacityRail from "./ChatCapacityRail.vue";
import ChatPane from "./ChatPane.vue";
import ChatRunGraph from "../transcript/ChatRunGraph.vue";
import ChatTabs from "../tabs/ChatTabs.vue";
import ChatTabsMobile from "../tabs/ChatTabsMobile.vue";

// The shared assistant: the frame around one or more chats (each conversation is a ChatPane). Owns what belongs
// to the panel, not any one chat: the switcher bar, the pop-out-window button, the resize handle. All state lives
// in the useChat singleton, so a transcript persists across workspace areas; on a wide surface the bar becomes a
// left rail and panes stand side by side.

// `tabs: false` draws no header of its own, for the one caller (mobile agent route) whose surface already has
// one — everything that bar offered is a tap away on the same form factor. A prop, not a `mobile` check, since
// docked/floating panels need their own strip regardless of device.
const { tabs = true } = defineProps<{ tabs?: boolean }>();

const { active, activeId, conversations, panes, setActive, closePane, closeTabs, openConversation, tabReveal } = useChat();
const layout = useLayout();
const { here: floating, fit } = useChatFloating();
const { mobile } = useDevice();

// The panel's own element; the left-edge resize handle measures against it.
const root = ref<HTMLElement>();

// How narrow a chat may shrink (useLayout's MIN_PANE_PX), imported rather than restated since the docked column
// shares the same floor. Written as a custom property in app pixels, not rem, so it can't drift from the column's
// own stored width.
const minPaneLength = uiLength(MIN_PANE_PX);
// The chat list's rail width beside the panes; its own default (rail.ts), not copied here.
const RAIL_PX = DEFAULT_RAIL_WIDTH;

// Which chats are on screen: the store holds the pane set, but a window only draws as many as fit at their floor.
// A docked panel now shows a split too, once wide enough — the set survives docking, so popping back out restores
// the split.
const dockedRoom = (count: number): number => count * MIN_PANE_PX;
const paneIds = computed(() => {
    if (mobile.value) {
        return [activeId.value];
    }
    return chatWide.value || layout.chatWidth.value >= dockedRoom(panes.value.length) ? panes.value : [activeId.value];
});
// Conversations behind the shown ids, in column order; an id naming no open chat is dropped, not backfilled with
// the focused chat (which drew it twice, in two columns keyed the same, corrupting Vue's diff). The floor
// (`active`) is reached only when nothing at all resolves.
const shown = computed<Conversation[]>(() => {
    const held = paneIds.value.flatMap((id) => {
        const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
        return conversation === undefined ? [] : [conversation];
    });
    return held.length > 0 ? held : [active.value];
});
// A split is what's drawn, not asked for: a claimed-but-unfilled column mustn't hide the single-pane close.
const split = computed(() => shown.value.length > 1);

// Which subscriptions still have room, in the width panes can't use (rule: chatCapacity's railFitsBeside). Shown
// only in the panel's own window — every other surface already has the Usage tab and the picker a click away.
// Measured off the panel's real width, watched; zero until measured so it can't flash on before the first read.
const panelWidth = ref(0);
let panelObserver: ResizeObserver | undefined;
const stopMeasuring = (): void => {
    panelObserver?.disconnect();
    panelObserver = undefined;
};
watch(
    root,
    (el) => {
        stopMeasuring();
        // A component-test DOM has no ResizeObserver, so nothing measures and the rail stays off, as those tests want.
        if (el === undefined || typeof ResizeObserver === `undefined`) {
            return;
        }
        panelObserver = new ResizeObserver(([entry]) => {
            panelWidth.value = toAppPx(entry?.contentRect.width ?? 0);
        });
        panelObserver.observe(el);
    },
    { immediate: true },
);
onBeforeUnmount(stopMeasuring);

// `tabs: false` means no rail is taking width off the panes, so nothing is reserved. Only reserved with something
// in it (hasCapacity), or the panel would hold 240px of padding for a rail rendering nothing; mid-load counts as
// non-empty so the transcript doesn't reflow when it lands.
const showsCapacity = computed(
    () =>
        floating.value &&
        !mobile.value &&
        (!accountsLoaded.value || hasCapacity()) &&
        railFitsBeside(panelWidth.value, tabs ? railWidth.value : 0, shown.value.length),
);

// Past the floor the row scrolls, so the focused pane scrolls back into view (a no-op if already visible).
const paneRow = ref<HTMLElement>();
watch([() => activeId.value, shown], () => {
    void nextTick(() => {
        paneRow.value?.querySelector(`.chat-pane-on`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    });
});

// A workflow run opened from the fleet board takes over the pane area (its sessions in the columns, one press
// back to the diagram); only on a wide, desktop surface, since a run's point is several sessions at once and a
// docked column holds one. The run is looked up, not held, so the graph tracks the polled ledger.
const { runs } = useWorkflowRuns();
// The run `chatRun` names; gating the exit on `shownRun` (docked has none) latched it forever.
const trackedRun = computed(() => runs.value.find((run) => run.runId === chatRun.value?.runId));
// Where the diagram can be drawn — the whole pane area, a trade only a window has room for.
const shownRun = computed(() => (chatWide.value && !mobile.value ? trackedRun.value : undefined));
// The bar is drawn wherever the run is driving the panes, not only where the diagram can show: docked, following
// a run moved the panes silently, with no name for the cause and no way to stop it.
const barRun = computed(() => trackedRun.value);
// When the diagram is on screen: asked for outright (`graph`) it always is; following a run, it is only while
// there's nothing to follow yet (before the first session, or after the run ends), stepping aside the moment a
// session exists.
const showingGraph = computed(() => showingRunGraph(shownRun.value, chatRun.value, paneIds.value));

// The way out of the diagram; a watch here, not a rule in `setActive`, since useChat owns tabs/panes but not
// which workflow a chat came from (rule: runOnFocus). Runs on every focus gesture, including reclicking the same
// chat (tabReveal), and on `trackedRun`, including when the ledger has no reading for it.
watch([activeId, tabReveal], () => {
    const held = chatRun.value;
    if (held === undefined) {
        return;
    }
    const next = runOnFocus(trackedRun.value, activeId.value, held.mode);
    // Written only when it moved: runOnFocus returns a fresh object even for "still inside", not only on exit.
    if (next?.runId !== held.runId || next.mode !== held.mode) {
        chatRun.value = next;
    }
});

// Room for the band that just opened: a docked column asks for the width its own floor needs (mirroring a
// floating window's `fit`), clamped short of the viewport and left for the reader to drag. Only while the panel
// is actually in that column — not parked on the rail out of view.
const makeRoomFor = (count: number): void => {
    if (chatWide.value || chatOnRail.value || mobile.value || layout.chatWidth.value >= dockedRoom(count)) {
        return;
    }
    layout.setChatWidth(dockedRoom(count));
};

// The panel following the run: fires the instant it exists (the ledger has the first band's sessions before this
// runs) and again each time a band settles. Runs docked as well as floating, off the stored pane set; gated on
// `live` mode, since `graph`/`pinned` mean the reader has chosen where to be.
watch(
    [trackedRun, () => chatRun.value?.mode],
    () => {
        const run = trackedRun.value;
        if (run === undefined || chatRun.value?.mode !== `live`) {
            return;
        }
        const following = runToFollow(run, panes.value);
        if (following !== undefined) {
            openRunSessions(following);
            makeRoomFor(following.length);
        }
    },
    { immediate: true },
);

// A column of the diagram, onto a column of the panel — the graph's one gesture. Stays on the diagram when
// nothing opens. The landing mode is read off the column (modeForSessions): a live band means keep following, a
// finished one means stand still.
const openRunColumn = (sessions: readonly RunSession[]): void => {
    const run = shownRun.value;
    if (run !== undefined && openRunSessions(sessions)) {
        showRun(
            run.runId,
            modeForSessions(
                run,
                sessions.map((session) => session.conversationId),
            ),
        );
    }
};

// A pane with no room is invisible, so adding one widens the window; docked, there's no window to resize.
watch(
    () => shown.value.length,
    (count, before) => {
        if (count > before) {
            fit(count * MIN_PANE_PX + RAIL_PX);
        }
    },
);

// The other end of the focus trace (focusTrace.ts): which chat this panel actually put on screen, and in which
// kind of window — so a mismatch between the board and a floating chat is answerable without guessing which moved.
watch(
    [() => active.value.conversationId, floating],
    ([id, inOwnWindow]) => {
        traceFocus(`render`, { id, window: inOwnWindow ? `floating` : `docked` });
    },
    { flush: `post`, immediate: true },
);

// The seam speaks pointer coordinates; the stored width is app pixels (uiScale). Reports a size, not a position,
// since a position read from the pointer-to-edge distance is only correct while the chat is flush to the window's
// right edge.
const seamWidth = computed<number>({
    get: () => toScreenPx(layout.chatWidth.value),
    set: (px) => layout.setChatWidth(toAppPx(px)),
});
</script>

<template>
    <!--
        Docked, the panel is a column (bar on top, pane below); on a wide surface the bar becomes a rail on the left.
        Left, in both wide forms, so navigation stays before content and the transcript's scrollbar keeps the window's
        own right edge — the target a pointer can hit without aiming.
    -->
    <!--
        `--capacity-rail` is the width the rail stands in, published here since the rail is lifted out of the row (so
        the transcript's scroller can reach the window edge); zero when not drawn, so both states are one rule.
    -->
    <div
        ref="root"
        class="chat-panel lane-ground-card relative flex h-full min-h-0 overflow-hidden bg-card"
        :class="chatWide ? 'flex-row' : 'flex-col'"
        :style="{ '--capacity-rail': showsCapacity ? uiLength(CAPACITY_RAIL_PX) : `0px` }"
    >
        <!--
            An overlay seam (`place="edge"`), not in-flow, since docked the panel's own axis is the bar-then-panes column,
            not this border. `pane="after"`: the chat is right of the seam, so dragging left widens it.
        -->
        <ResizeSeam
            v-if="!chatWide && !mobile"
            v-model="seamWidth"
            place="edge"
            pane="after"
            :min="toScreenPx(MIN_CHAT_WIDTH)"
            :max="toScreenPx(maxChatWidth())"
            :reset="toScreenPx(defaultChatWidth())"
            title="Drag to resize · double-click to reset"
        />

        <template v-if="tabs">
            <ChatTabsMobile v-if="mobile" @select="setActive" @close="closeTabs" @open="openConversation" />
            <ChatTabs v-else @select="setActive" @close="closeTabs" @open="openConversation" />
        </template>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <!--
                The run bar: drawn wherever a run drives the panes (barRun), not only where its diagram can show. The back
                arrow is the whole control where the diagram exists; docked, there's no diagram to point at, so the bar carries
                the run's own glyph and the × that ends it. Above the panes, since the run owns every column, not just the
                focused one.
            -->
            <div v-if="barRun" class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
                <Button
                    v-if="shownRun && !showingGraph"
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="shrink-0"
                    v-tooltip.bottom="`Back to the diagram: every step of this run`"
                    aria-label="Back to the run's diagram"
                    @click="showRun(shownRun.runId, `graph`)"
                >
                    <Icon name="arrow-left" class="text-2xs" />
                </Button>
                <Icon v-else name="sitemap" class="shrink-0 text-2xs text-link" />
                <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ barRun.workflow.name }}</span>
                <span class="shrink-0 text-2xs text-subtle"
                    >{{ barRun.steps.filter((step) => step.state === `done`).length }}/{{ barRun.steps.length }}</span
                >
                <button
                    type="button"
                    :class="ui.iconButton(`rounded`)"
                    v-tooltip.bottom="`Leave the run: the chats stay open`"
                    aria-label="Leave the run"
                    @click="closeRun()"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>

            <!--
                The diagram takes the whole pane area — it's the map of those columns, so showing both answers one question
                twice.
            -->
            <ChatRunGraph v-if="showingGraph && shownRun" :run="shownRun" class="min-h-0 flex-1" @open="openRunColumn" />

            <!--
                The panes share the room equally (mirroring the terminal panel's split cells) until the floor, then scroll
                sideways instead of crushing.
            -->
            <div v-else ref="paneRow" class="chat-panes flex min-h-0 min-w-0 flex-1 overflow-x-auto" :style="{ '--min-pane': minPaneLength }">
                <!--
                    A pane's own × only appears in a split: with one column, closing it is the panel's job, not a control living
                    inside the pane. The panel answers the press, same as `focus` — which chats are on screen is the frame's state.
                -->
                <ChatPane
                    v-for="conversation in shown"
                    :key="conversation.conversationId"
                    :conversation="conversation"
                    :focused="conversation.conversationId === activeId"
                    :closable="split"
                    @focus="setActive(conversation.conversationId)"
                    @close="closePane(conversation.conversationId)"
                />
            </div>
        </div>

        <!--
            What the reader can run next, in room the panes have no use for; belongs to the window, not any one chat (like
            the chat list on the other edge). Yields to the panes rather than competing. Out of flow, drawn over the
            transcript's own margin, so the scrollbar keeps the window's edge.
        -->
        <ChatCapacityRail v-if="showsCapacity" />
    </div>
</template>

<style scoped>
/*
 * Equal columns, hairline between, nothing ranking one above another: a focused-pane accent used to imply
 * keystroke routing that the caret already shows, and it made a side-by-side comparison read as a main pane and a
 * spare. Panes are equals; the panel draws them that way.
 */
.chat-panes :deep(.chat-pane) {
    flex: 1 1 0;
    min-width: var(--min-pane);
}
.chat-panes :deep(.chat-pane + .chat-pane) {
    border-left: 1px solid var(--color-line);
}
/*
 * The headroom rail's width isn't taken from this row — it's drawn over the margin, and the bordering pane pads
 * by `--capacity-rail` (rules live in chat.css, qualified with `.chat-panel` to outrank the basis above).
 */
</style>
