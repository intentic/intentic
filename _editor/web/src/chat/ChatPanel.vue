<script setup lang="ts">
import { Icon, useDevice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import { chatRun, closeRun, modeForSessions, type RunSession, runOnFocus, runToFollow, showingRunGraph, showRun } from "../composables/chat/chatRun";
import type { Conversation } from "../composables/chat/conversation";
import { traceFocus } from "../composables/chat/focusTrace";
import { transcriptView } from "../composables/chat/transcriptClock";
import { openRunSessions } from "../composables/chat/openRun";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useWorkflowRuns } from "../composables/agents/useWorkflowRuns";
import { useLayout } from "../composables/useLayout";
import ChatPane from "./ChatPane.vue";
import ChatRunGraph from "./ChatRunGraph.vue";
import ChatTabs from "./ChatTabs.vue";
import ChatTabsMobile from "./ChatTabsMobile.vue";

/* The shared assistant — the FRAME around one or more chats. What is on screen (the transcript, its composer,
 * its pickers) is a ChatPane per conversation; this owns everything that belongs to the panel rather than to
 * any one chat: the switcher bar, the pop-out, the left-edge resize handle, and telling the transcript clock
 * which window it is painting in.
 *
 * All state lives in the useChat singleton, so a transcript persists as the user moves between workspace
 * areas. On mobile (the full-screen /chat tab) the bar becomes a taller touch header over a bottom sheet and
 * the resize handle disappears. Popped out the panel turns on its side: the strip becomes a left rail, and the
 * panes stand side by side in the room that leaves. */

const { active, activeId, conversations, panes, setActive, closePane, closeTabs, openConversation, tabReveal } = useChat();
const layout = useLayout();
const { poppedOut, fit } = useChatPopout();
const { mobile } = useDevice();

// The panel's own element, and the one question anything here asks of it: which window it is currently in.
// The panes are teleported with it, so this answers for all of them.
const root = ref<HTMLElement>();
const panelWindow = (): Window & typeof globalThis => root.value?.ownerDocument.defaultView ?? window;

// True while the user is dragging the left-edge handle to resize the panel.
const resizing = ref(false);

/* --- The panes ---------------------------------------------------------------------------------
 * How narrow a chat may be squeezed. A terminal at 40 columns is still a terminal; a chat at 300px with tool
 * cards in it is not — so panes share the room equally down to this and then the row scrolls, rather than
 * shrinking on forever. It is the docked column's own default width, which is the narrowest a chat has ever
 * been asked to be here.
 */
const MIN_PANE_PX = 352;
// The rail beside them (ChatTabs' `w-40` plus its padding) — the part of the window the panes never get.
const RAIL_PX = 176;

/* WHICH CHATS ARE ON SCREEN. The store holds the pane set; a DOCKED panel shows the focused one alone whatever
 * that set says, because the column is ~22rem and a second pane in it would be two unusable slivers. The set
 * is not cleared by docking — it is this window's layout, so popping back out returns to the split the user
 * left. Mobile is the same rule for the same reason, one form factor further down. */
const paneIds = computed(() => (poppedOut.value && !mobile.value ? panes.value : [activeId.value]));
const split = computed(() => paneIds.value.length > 1);
// The conversations behind those ids, in column order. The find always hits — setConversations reconciles the
// pane set with every list it writes — and `active` is the floor that keeps a slip a wrong chat rather than a
// crashed panel, the same bargain `active` itself makes.
const shown = computed<Conversation[]>(() =>
    paneIds.value.map((id) => conversations.value.find((conversation) => conversation.conversationId === id) ?? active.value),
);

// Past the width floor the panes stop shrinking and the row scrolls, so the focused one has to be brought back
// into view — the same courtesy the rail does for the focused tab. `nearest` is a no-op on a pane already on
// screen, so this costs nothing in the ordinary case.
const paneRow = ref<HTMLElement>();
watch([() => activeId.value, paneIds], () => {
    void nextTick(() => {
        paneRow.value?.querySelector(`.chat-pane-on`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    });
});

/* --- The run this panel is showing ----------------------------------------------------------------
 * A workflow run opened from the fleet board takes over the pane area: its live sessions in the columns, and
 * one press back, the diagram they came from. Only while POPPED OUT and on a desktop, for the same reason the
 * split itself is: a run's whole point is several sessions at once, and a 22rem docked column can hold one.
 *
 * The run is looked up rather than held (see chatRun): the ledger is polled, so the graph a reader is looking
 * at keeps up with the run under it instead of freezing at the moment they clicked.
 */
const { runs } = useWorkflowRuns();
// The run chatRun names, wherever the panel is — the exit rule below runs on it. `shownRun` is the narrower
// question ("is the run's UI on screen"), and gating the exit on THAT was the bug: docked, it never held, so
// a run picked on the board stayed `chatRun` — and wore the card's ring — through every session opened after.
const trackedRun = computed(() => runs.value.find((run) => run.runId === chatRun.value?.runId));
const shownRun = computed(() => (poppedOut.value && !mobile.value ? trackedRun.value : undefined));
/* WHEN THE DIAGRAM IS WHAT IS ON SCREEN, and `live` is the mode that answers this two different ways over its
 * own lifetime. Asked for outright (`graph`) it is the diagram, full stop. Following the run, it is the diagram
 * only while there is nothing to follow — the seconds between a start and the first step opening its
 * conversation, and again once the run has ended — and it gives way to the panes the moment a session exists.
 * That is what makes `live` a single instruction rather than two states the caller has to choose between at a
 * moment when the answer is not knowable yet. */
const showingGraph = computed(() => showingRunGraph(shownRun.value, chatRun.value, paneIds.value));

/* THE WAY OUT of the diagram, and the reason it is a watch here rather than a rule inside `setActive`:
 * `useChat` owns tabs and panes, and which workflow a conversation came out of is not its business. The rule
 * itself is runOnFocus, which says at length why a focus change is an exit at all.
 *
 * It runs on every focus GESTURE, not merely on the id moving: `tabReveal` is the counter setActive bumps for
 * exactly the ask an id watch cannot see (the card of the chat you are already in, clicked again), and that
 * click is as much "show me this chat" as any other. And it runs on `trackedRun`, whatever the panel's form —
 * gated on the popped-out `shownRun` it was dead while docked, which left `chatRun` (and the board ring it
 * draws) latched to a run the user had long since clicked away from.
 */
watch([activeId, tabReveal], () => {
    const held = chatRun.value;
    if (trackedRun.value === undefined || held === undefined) {
        return;
    }
    const next = runOnFocus(trackedRun.value, activeId.value, held.mode);
    // Written only when it actually moved. runOnFocus answers with a FRESH object for "you are still inside this
    // run" just as much as for a real exit, and storing that back re-notified everything reading the run — the
    // panel's own derivations, the board's ring — on every click into a chat the run already held.
    if (next?.runId !== held.runId || next.mode !== held.mode) {
        chatRun.value = next;
    }
});

/* THE PANEL FOLLOWING THE RUN — the whole of `live`, and the only thing on this side that moves by itself.
 *
 * The ledger is polled, so this fires on every poll while a run is on screen and does nothing on almost all of
 * them (runToFollow returns `undefined` for a set already up). The two it acts on are the ones worth having:
 * the first poll after a start, which turns the diagram into the attempts, and the poll after a band settles,
 * which moves the panes to whatever the graph handed the baton to. Between them the reader never presses
 * anything, which is the point — "show me my workflow" was the whole of the instruction.
 *
 * Guarded on the MODE rather than on the run, because `graph` and `pinned` are exactly the states in which the
 * reader has said where they want to be and this must not overrule them.
 */
watch(
    [shownRun, () => chatRun.value?.mode],
    () => {
        const run = shownRun.value;
        if (run === undefined || chatRun.value?.mode !== `live`) {
            return;
        }
        const following = runToFollow(run, paneIds.value);
        if (following !== undefined) {
            openRunSessions(following);
        }
    },
    { immediate: true },
);

/* A column of the diagram, onto the columns of the panel — the one gesture the graph offers, and the reason
 * the two words are the same word. When nothing in the column opens, the diagram stays up: a back arrow that
 * landed on an empty split would read as the press having broken something.
 *
 * WHICH MODE IT LANDS IN IS READ OFF THE COLUMN (modeForSessions): pressing the band that is live is a request
 * to watch the run, so it keeps following; pressing a band that has finished is a request to stand still. */
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

// A pane the window has no room for is a pane the user cannot see, so adding one asks the window to widen
// (usePopout.fit only ever grows it, and only as far as the screen allows). Docked, there is no window of ours
// to resize — the panel is a column in the app's own.
watch(
    () => paneIds.value.length,
    (count, before) => {
        if (count > before) {
            fit(count * MIN_PANE_PX + RAIL_PX);
        }
    },
);

/* The transcript's CLOCK is told which window its frames belong to (transcriptClock's transcriptView): the
 * window these rows are in is the pop-out's whenever the panel has one. Post-flush, so the Teleport has
 * already moved them and `ownerDocument` answers about where they landed rather than where they left; the
 * root is in the dependencies because a mount is the other way this becomes true. */
watch([root, poppedOut], () => (transcriptView.value = panelWindow()), { flush: `post`, immediate: true });

/* THE OTHER END OF THE FOCUS TRACE (focusTrace.ts): what this panel actually put on screen, and in WHICH
 * window it put it. The store's own line says which chat it resolved to; this one says which chat the user is
 * looking at, out of which document — so a report of "the popped-out chat is showing a different session than
 * the board" is answerable without guessing at which of the two moved. Post-flush, so the id and the window
 * are read after the Teleport has settled them, and title-free: the id is what both ends have in common. */
watch(
    [() => active.value.conversationId, poppedOut, root],
    ([id, floating]) => {
        traceFocus(`render`, { id, window: floating ? `popout` : `docked`, document: panelWindow().document.title });
    },
    { flush: `post`, immediate: true },
);

// --- Resize ----------------------------------------------------------------------------------
// Left-edge resize: pointer capture routes move/up to the handle even past its bounds. The chat is the
// rightmost column flush to the viewport's right edge, so its width is the distance from the pointer to it.
const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};
const onResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    layout.setChatWidth(globalThis.innerWidth - event.clientX);
};
const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
</script>

<template>
    <!-- Docked, the panel is a column: the switcher bar on top, then the pane. Undocked, that bar becomes a
         rail of chat cards down the window's left edge, so the panel's own axis flips and the panes stand in
         the room beside it. -->
    <div
        ref="root"
        class="chat-panel relative flex h-full min-h-0 overflow-hidden bg-card"
        :class="[poppedOut ? 'flex-row' : 'flex-col', { 'is-resizing': resizing }]"
    >
        <div
            v-if="!poppedOut && !mobile"
            class="resize-handle"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="layout.resetChatWidth()"
            title="Drag to resize · double-click to reset"
        ></div>

        <ChatTabsMobile v-if="mobile" @select="setActive" @close="closeTabs" @open="openConversation" />
        <ChatTabs v-else @select="setActive" @close="closeTabs" @open="openConversation" />

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- THE RUN BAR, and the back arrow is the whole of it. Sessions ⇄ diagram is a there-and-back,
                 not a place in a history, so it is one arrow that points at the map and is absent once you
                 are on it — the folder/file relationship, drawn the way every file manager draws it. Above
                 the panes rather than inside one: the run owns all of the columns, not the focused one. -->
            <div v-if="shownRun" class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
                <button
                    v-if="!showingGraph"
                    type="button"
                    class="flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded px-1.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.bottom="`Back to the diagram — every step of this run`"
                    aria-label="Back to the run's diagram"
                    @click="showRun(shownRun.runId, `graph`)"
                >
                    <Icon name="arrow-left" class="text-2xs" />
                </button>
                <Icon v-else name="sitemap" class="shrink-0 text-2xs text-link" />
                <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ shownRun.workflow.name }}</span>
                <span class="shrink-0 text-2xs text-subtle"
                    >{{ shownRun.steps.filter((step) => step.state === `done`).length }}/{{ shownRun.steps.length }}</span
                >
                <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-overlay hover:text-content"
                    v-tooltip.bottom="`Leave the run — the chats stay open`"
                    aria-label="Leave the run"
                    @click="closeRun()"
                >
                    <Icon name="times" class="text-2xs" />
                </button>
            </div>

            <!-- The diagram takes the pane area whole: it is the map OF those columns, so showing it beside
                 them would be asking the reader to hold two answers to one question. -->
            <ChatRunGraph v-if="showingGraph && shownRun" :run="shownRun" class="min-h-0 flex-1" @open="openRunColumn" />

            <!-- The panes, sharing the room equally (the terminal panel's split cells, which this is the chat's
                 half of) until the floor, past which the row scrolls sideways rather than crushing them. -->
            <div v-else ref="paneRow" class="chat-panes flex min-h-0 min-w-0 flex-1 overflow-x-auto" :class="{ 'chat-panes-split': split }">
                <!-- A pane may be closed from its own corner only in a SPLIT: with one column the × would be
                     a control that closes the panel it lives in, which is the pop-out's job and the strip's.
                     The panel answers the press, the way it answers `focus` — which chats are on screen is
                     the frame's state, not any one pane's. -->
                <ChatPane
                    v-for="(conversation, at) in shown"
                    :key="conversation.conversationId"
                    :conversation="conversation"
                    :focused="paneIds[at] === activeId"
                    :closable="split"
                    @focus="setActive(conversation.conversationId)"
                    @close="closePane(conversation.conversationId)"
                />
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Equal columns with a hairline between, and a top accent on the focused pane so keystroke routing is visible
   in a split — the terminal panel's `.term-cell` rules, which this is the chat's half of. The accent is only
   drawn while there is more than one pane: in a single-pane panel every keystroke goes to the one chat on
   screen, and a permanent marker saying so would be chrome that never changes. */
.chat-panes :deep(.chat-pane) {
    flex: 1 1 0;
    min-width: 22rem;
}
.chat-panes :deep(.chat-pane + .chat-pane) {
    border-left: 1px solid var(--color-line);
}
.chat-panes-split :deep(.chat-pane-on) {
    box-shadow: inset 0 2px 0 0 color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}
</style>
