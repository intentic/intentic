<script setup lang="ts">
import { Button, Icon, useDevice, ui } from "@intentic/ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { CAPACITY_RAIL_PX, hasCapacity, railFitsBeside } from "../composables/chat/chatCapacity";
import { accountsLoaded } from "../composables/chat/providerAccounts";
import { chatRun, closeRun, modeForSessions, type RunSession, runOnFocus, runToFollow, showingRunGraph, showRun } from "../composables/chat/chatRun";
import type { Conversation } from "../composables/chat/conversation";
import { traceFocus } from "../composables/chat/focusTrace";
import { openRunSessions } from "../composables/chat/openRun";
import { DEFAULT_RAIL_WIDTH, railWidth } from "../composables/rail";
import { chatOnRail, chatWide } from "../composables/chat/chatSurface";
import { useChat } from "../composables/chat/useChat";
import { useChatFloating } from "../composables/chat/chatFloating";
import { useWorkflowRuns } from "../composables/agents/useWorkflowRuns";
import { MIN_PANE_PX, useLayout } from "../composables/useLayout";
import { toAppPx, uiLength } from "../composables/uiScale";
import ChatCapacityRail from "./ChatCapacityRail.vue";
import ChatPane from "./ChatPane.vue";
import ChatRunGraph from "./ChatRunGraph.vue";
import ChatTabs from "./ChatTabs.vue";
import ChatTabsMobile from "./ChatTabsMobile.vue";

/* The shared assistant: the FRAME around one or more chats. What is on screen (the transcript, its composer,
 * its pickers) is a ChatPane per conversation; this owns everything that belongs to the panel rather than to
 * any one chat: the switcher bar, the button that moves the panel into a window of its own, and the left-edge
 * resize handle.
 *
 * All state lives in the useChat singleton, so a transcript persists as the user moves between workspace
 * areas. On mobile the bar becomes a taller touch header over a bottom sheet and the resize handle disappears.
 * On a WIDE surface (a window of its own, or the /chat area filling the main one (chatSurface.ts)) the panel
 * turns on its side: the strip becomes a rail down the left edge, and the panes stand side by side in the room
 * that leaves. */

/* `tabs: false`, DRAW NO HEADER OF MY OWN, because the surface embedding me already has one.
 *
 * One caller passes it: the mobile agent route. That screen's own header names the agent, and this panel's
 * mobile header named the same conversation directly underneath it: two bars, 98px of a 844px phone, the same
 * string in both, and the string truncated in both. Everything the second bar uniquely offered is a tap away
 * on the same form factor: it switched between open chats and started a new agent, and on a phone the fleet
 * board (the Agents tab) is that switcher and carries that button.
 *
 * A prop rather than a `mobile` check inside this component, because "am I on a phone" is not the question: the
 * docked and floating panels are the ones that need their own strip, and they are the ones that keep it.
 * Defaults on, so nothing but the caller that asked is affected. */
const { tabs = true } = defineProps<{ tabs?: boolean }>();

const { active, activeId, conversations, panes, setActive, closePane, closeTabs, openConversation, tabReveal } = useChat();
const layout = useLayout();
const { here: floating, fit } = useChatFloating();
const { mobile } = useDevice();

// The panel's own element (the left-edge resize handle measures against it).
const root = ref<HTMLElement>();

// True while the user is dragging the left-edge handle to resize the panel.
const resizing = ref(false);

/* --- The panes ---------------------------------------------------------------------------------
 * How narrow a chat may be squeezed (useLayout's MIN_PANE_PX): imported rather than restated, because the
 * docked column's own floor is the same number and the two drifting apart is what put a horizontal scrollbar
 * under the panel. Written onto the row as a custom property so the stylesheet below measures in the same APP
 * pixels the column's width is stored in: `22rem` would be the same number only until someone changed their
 * browser's base font, and then the pane would outgrow a column that thought it was wide enough.
 */
const minPaneLength = uiLength(MIN_PANE_PX);
// The chat list's rail beside them: the part of the window the panes never get. Its own default (rail.ts)
// rather than a number copied here: a reader who has dragged it wider is asking the panes to scroll a little
// sooner, which is their trade to make, but the width a fresh window opens at must not be guessed at twice.
const RAIL_PX = DEFAULT_RAIL_WIDTH;

/* WHICH CHATS ARE ON SCREEN. The store holds the pane set, and what a window can DRAW of it is a question about
 * room: every pane keeps its floor, so a set only stands side by side where the columns fit at that width.
 *
 * A DOCKED PANEL SHOWS THE SPLIT TOO, once it is wide enough, which it was not allowed to before, on the
 * argument that the column is ~22rem and two panes in it would be slivers. True of 22rem and false of the
 * column a reader has widened, and the rule that follows from the floor is right about both. It is also what a
 * run needs: two attempts running side by side is the picture, and the alternative was popping a window open
 * on the reader's behalf. The set is not cleared by docking: it is this window's layout, so popping back out
 * returns to the split the user left. Mobile shows one, always: there is no width to be had. */
const dockedRoom = (count: number): number => count * MIN_PANE_PX;
const paneIds = computed(() => {
    if (mobile.value) {
        return [activeId.value];
    }
    return chatWide.value || layout.chatWidth.value >= dockedRoom(panes.value.length) ? panes.value : [activeId.value];
});
/* The conversations behind those ids, in column order, and an id naming no open chat is DROPPED rather than
 * filled in with the focused one, which is what it used to do.
 *
 * The find does not always hit. setConversations reconciles the pane set with every list it writes, but
 * `openBeside` deliberately claims a column for an id that need not be a tab yet (the board's cards open
 * second), and nothing reconciles that claim until the next list write. Substituting `active` there did not
 * degrade gracefully: it drew the focused chat TWICE, in two columns keyed by the same conversation, which is
 * a duplicate key in a keyed list: from which Vue's diff has no defined way back, and the panel stops
 * answering to what is picked. A column with nothing in it is not a column; the floor is only reached when
 * NOTHING resolves, which is the case `active` was always for. */
const shown = computed<Conversation[]>(() => {
    const held = paneIds.value.flatMap((id) => {
        const conversation = conversations.value.find((candidate) => candidate.conversationId === id);
        return conversation === undefined ? [] : [conversation];
    });
    return held.length > 0 ? held : [active.value];
});
// A split is what is DRAWN, not what was asked for: a claimed column nobody filled must not make a
// single-pane panel offer its per-column ×.
const split = computed(() => shown.value.length > 1);

/* --- The headroom rail ---------------------------------------------------------------------------
 * WHICH SUBSCRIPTIONS STILL HAVE ROOM, down the right edge, in the width the panes cannot use. The rule and
 * the reasoning are chatCapacity's (railFitsBeside); what belongs here is the measurement it is fed and the
 * one place the rail is allowed to appear.
 *
 * THE PANEL'S OWN WINDOW, AND NOWHERE ELSE. Every other home this panel has sits inside the app's shell, where
 * the Usage tab is a click away on the icon rail and the composer's picker is a click away under the caret. A
 * popped-out chat is the one surface with neither: it is a window of its own, so "how much of my plan is left"
 * costs a trip back to another window, and the answer decides whether the next thing the reader types is worth
 * sending. The /chat area is deliberately excluded for that reason rather than for a layout one — it is the
 * same panel at the same width, but the shell around it already answers this.
 *
 * MEASURED, NOT ASSUMED. The window is resizable, the chat list beside it is draggable, and the pane count
 * moves on its own when a workflow run opens a band — so the only honest input is the panel's real width,
 * watched. Off the PANEL rather than the window: the measurement must not change when the rail appears, or the
 * rule would feed itself and the column would flicker at its own threshold. It doesn't: the panel is the whole
 * of the window's content either way, and the rail is drawn out of its slack.
 *
 * Zero until measured, so the rail cannot flash onto a window whose width has not been read yet. The
 * observer's first callback lands before the first paint, so nothing is ever seen at this value.
 */
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
        // A component-test DOM has no ResizeObserver, and a panel rendered there is not being looked at:
        // nothing measures, so the rail stays off, which is the layout every one of those tests is written for.
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

/* `tabs: false` is a caller that draws no list of its own (the mobile agent route), so there is no rail taking
 * width off the panes: asking for it back would be charging them for a column that isn't there.
 *
 * AND ONLY WITH SOMETHING IN IT (hasCapacity). The panel is what reserves the strip the rail stands in, so the
 * emptiness question is settled here, before any of it is laid out: a sandbox with no AI account connected
 * would otherwise hold 240px of padding open down the side of a transcript to make room for a column that
 * renders nothing. Mid-load is not empty — the rail draws the shape that is coming — so the reservation stands
 * until the connection read says otherwise, which is also what keeps the transcript from re-flowing under the
 * reader when it lands. */
const showsCapacity = computed(
    () =>
        floating.value &&
        !mobile.value &&
        (!accountsLoaded.value || hasCapacity()) &&
        railFitsBeside(panelWidth.value, tabs ? railWidth.value : 0, shown.value.length),
);

// Past the width floor the panes stop shrinking and the row scrolls, so the focused one has to be brought back
// into view: the same courtesy the rail does for the focused tab. `nearest` is a no-op on a pane already on
// screen, so this costs nothing in the ordinary case.
const paneRow = ref<HTMLElement>();
watch([() => activeId.value, shown], () => {
    void nextTick(() => {
        paneRow.value?.querySelector(`.chat-pane-on`)?.scrollIntoView({ block: `nearest`, inline: `nearest` });
    });
});

/* --- The run this panel is showing ----------------------------------------------------------------
 * A workflow run opened from the fleet board takes over the pane area: its live sessions in the columns, and
 * one press back, the diagram they came from. Only on a WIDE surface and on a desktop, for the same reason the
 * split itself is: a run's whole point is several sessions at once, and a 22rem docked column can hold one.
 *
 * The run is looked up rather than held (see chatRun): the ledger is polled, so the graph a reader is looking
 * at keeps up with the run under it instead of freezing at the moment they clicked.
 */
const { runs } = useWorkflowRuns();
// The run chatRun names, wherever the panel is: the exit rule below runs on it. `shownRun` is the narrower
// question ("is the run's UI on screen"), and gating the exit on THAT was the bug: docked, it never held, so
// a run picked on the board stayed `chatRun`, and wore the card's ring: through every session opened after.
const trackedRun = computed(() => runs.value.find((run) => run.runId === chatRun.value?.runId));
// Where the DIAGRAM can be drawn: it takes the whole pane area, and that is a trade only a window has the room
// to make.
const shownRun = computed(() => (chatWide.value && !mobile.value ? trackedRun.value : undefined));
/* THE BAR IS DRAWN WHEREVER THE RUN IS DRIVING, which is not the same question and used to be answered as if
 * it were. Following a run moves the panes on its own, and docked, where the diagram cannot be shown: the
 * bar went with the diagram: the reader got a panel that reseated itself every few seconds, with nothing on
 * screen naming the cause and no × to press, because the one control that ends it lived in a bar only the wide
 * forms ever drew. A thing that moves the panes by itself has to say so wherever it does it. */
const barRun = computed(() => trackedRun.value);
/* WHEN THE DIAGRAM IS WHAT IS ON SCREEN, and `live` is the mode that answers this two different ways over its
 * own lifetime. Asked for outright (`graph`) it is the diagram, full stop. Following the run, it is the diagram
 * only while there is nothing to follow: the seconds between a start and the first step opening its
 * conversation, and again once the run has ended, and it gives way to the panes the moment a session exists.
 * That is what makes `live` a single instruction rather than two states the caller has to choose between at a
 * moment when the answer is not knowable yet. */
const showingGraph = computed(() => showingRunGraph(shownRun.value, chatRun.value, paneIds.value));

/* THE WAY OUT of the diagram, and the reason it is a watch here rather than a rule inside `setActive`:
 * `useChat` owns tabs and panes, and which workflow a conversation came out of is not its business. The rule
 * itself is runOnFocus, which says at length why a focus change is an exit at all.
 *
 * It runs on every focus GESTURE, not merely on the id moving: `tabReveal` is the counter setActive bumps for
 * exactly the ask an id watch cannot see (the card of the chat you are already in, clicked again), and that
 * click is as much "show me this chat" as any other. And it runs on `trackedRun`, whatever the panel's form:
 * gated on `shownRun`, which only the wide forms have, it was dead while docked, which left `chatRun` (and the
 * board ring it draws) latched to a run the user had long since clicked away from.
 *
 * It also runs when the ledger has NO reading for the run, which is the second half of the same lesson: a
 * missing run is handed to runOnFocus rather than being a reason to skip it, and comes back as a release. See
 * runOnFocus for why an unconfirmable run must let go of the panes.
 */
watch([activeId, tabReveal], () => {
    const held = chatRun.value;
    if (held === undefined) {
        return;
    }
    const next = runOnFocus(trackedRun.value, activeId.value, held.mode);
    // Written only when it actually moved. runOnFocus answers with a FRESH object for "you are still inside this
    // run" just as much as for a real exit, and storing that back re-notified everything reading the run: the
    // panel's own derivations, the board's ring: on every click into a chat the run already held.
    if (next?.runId !== held.runId || next.mode !== held.mode) {
        chatRun.value = next;
    }
});

/* ROOM FOR THE BAND THAT JUST OPENED. A run's first move is usually two sessions at once, and a panel that
 * held the width it had would answer that by showing one of them, so the column asks for the width its own
 * floor says those panes need, exactly as a floating window asks itself to widen (`fit`). Clamped by the
 * layout to a sliver short of the viewport, and left there for the reader to drag back: a width the app chose
 * is still a width, and the seam is where it is undone.
 *
 * ONLY WHILE THE PANEL IS ACTUALLY IN THAT COLUMN. `chatWide` answers for the two forms that are on screen
 * without one (a window of its own, the /chat area), but the chat homed on the rail has a third state neither
 * of them covers: parked behind its tile while the reader is somewhere else entirely. A run starting there
 * fired this against a column nobody was looking at, and the width it set was still sitting on the panel days
 * later, so docking back to the side produced a column half the screen wide that the reader never dragged.
 * The width of a column the panel does not live in is not the panel's to set. */
const makeRoomFor = (count: number): void => {
    if (chatWide.value || chatOnRail.value || mobile.value || layout.chatWidth.value >= dockedRoom(count)) {
        return;
    }
    layout.setChatWidth(dockedRoom(count));
};

/* THE PANEL FOLLOWING THE RUN: the whole of `live`, and the only thing on this side that moves by itself.
 *
 * It acts the instant the run exists: the start writes the run into the ledger cache before this fires, and
 * every step's conversation is named in that first record, so the sessions of the first band open on the
 * press, not on a poll. After that the poll is what moves it: when a band settles, the next one takes the
 * panes. Between them the reader never presses anything, which is the point: "show me my workflow" was the
 * whole of the instruction.
 *
 * IT RUNS DOCKED AS WELL AS FLOATING, and on the stored PANE SET rather than on what this window has room to
 * draw. Gated on the panel having a window of its own, a run started from a docked panel opened nothing at all,
 * which is what the automatic pop-out was really for. A run's sessions are sessions: they open as tabs in a narrow
 * panel and stand side by side in a wide one, exactly as two chats the reader opened by hand do.
 *
 * Guarded on the MODE rather than on the run, because `graph` and `pinned` are exactly the states in which the
 * reader has said where they want to be and this must not overrule them.
 */
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

/* A column of the diagram, onto the columns of the panel: the one gesture the graph offers, and the reason
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
// (floating.fit only ever grows it, and only as far as the screen allows). Docked, there is no window of ours
// to resize: the panel is a column in the app's own.
watch(
    () => shown.value.length,
    (count, before) => {
        if (count > before) {
            fit(count * MIN_PANE_PX + RAIL_PX);
        }
    },
);

/* THE OTHER END OF THE FOCUS TRACE (focusTrace.ts): what this panel actually put on screen, and in which kind
 * of window it put it. The store's own line says which chat it resolved to; this one says which chat the user
 * is looking at, so a report of "the floating chat is showing a different session than the board" is answerable
 * without guessing at which of the two moved. Post-flush, so the id is read after the render has settled. */
watch(
    [() => active.value.conversationId, floating],
    ([id, inOwnWindow]) => {
        traceFocus(`render`, { id, window: inOwnWindow ? `floating` : `docked` });
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
    layout.setChatWidth(toAppPx(globalThis.innerWidth - event.clientX));
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
    <!-- Docked, the panel is a column: the switcher bar on top, then the pane. On a wide surface (its own
         window, or the /chat area) that bar becomes a rail of chat cards down the LEFT edge, so the panel's
         own axis flips and the panes stand in the room beside it.
         THE LEFT, IN BOTH WIDE FORMS. It was briefly the right, on the argument that in the /chat area the
         window's left edge is already the icon rail's and two rails side by side read as one muddled column:
         which the whole of this product category answers: an icon rail then a list is the two-tier navigation
         Slack, Discord and VSCode all draw, and it reads as tiers precisely because the narrow one comes
         first. What the flip cost is the transcript's SCROLLBAR: it is the surface a reader moves all day, and
         out on the right it owned the window's edge: the one target a pointer can throw itself at without
         aiming. Behind a list it becomes a strip floating mid-window, with the edge given to the bar of the
         column you touch least. Navigation before content, and the scroll you use against the frame. -->
    <!-- `--capacity-rail` is the width the headroom rail stands in, published here because the rail no longer
         occupies it: the column is lifted out of the row (see the note on it below) so the transcript's own
         scroller can reach the window edge, and this is what the scroller pads itself by instead. Zero when
         the rail is not drawn, which is what makes the two states one rule rather than a conditional class. -->
    <div
        ref="root"
        class="chat-panel lane-ground-card relative flex h-full min-h-0 overflow-hidden bg-card"
        :class="[chatWide ? 'flex-row' : 'flex-col', { 'is-resizing': resizing }]"
        :style="{ '--capacity-rail': showsCapacity ? uiLength(CAPACITY_RAIL_PX) : `0px` }"
    >
        <div
            v-if="!chatWide && !mobile"
            class="resize-handle"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="layout.resetChatWidth()"
            title="Drag to resize · double-click to reset"
        ></div>

        <template v-if="tabs">
            <ChatTabsMobile v-if="mobile" @select="setActive" @close="closeTabs" @open="openConversation" />
            <ChatTabs v-else @select="setActive" @close="closeTabs" @open="openConversation" />
        </template>

        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- THE RUN BAR: drawn wherever a run is driving the panes (barRun), not only where its diagram
                 can be. The back arrow is the whole of it where the diagram exists: sessions ⇄ diagram is a
                 there-and-back, not a place in a history, so it is one arrow that points at the map and is
                 absent once you are on it: the folder/file relationship, drawn the way every file manager
                 draws it. Docked there is no map to point at, so the run wears its glyph and the bar is what
                 it always had to be: the panel saying what is moving it, and the × that ends it. Above the
                 panes rather than inside one: the run owns all of the columns, not the focused one. -->
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

            <!-- The diagram takes the pane area whole: it is the map OF those columns, so showing it beside
                 them would be asking the reader to hold two answers to one question. -->
            <ChatRunGraph v-if="showingGraph && shownRun" :run="shownRun" class="min-h-0 flex-1" @open="openRunColumn" />

            <!-- The panes, sharing the room equally (the terminal panel's split cells, which this is the chat's
                 half of) until the floor, past which the row scrolls sideways rather than crushing them. -->
            <div v-else ref="paneRow" class="chat-panes flex min-h-0 min-w-0 flex-1 overflow-x-auto" :style="{ '--min-pane': minPaneLength }">
                <!-- A pane may be closed from its own corner only in a SPLIT: with one column the × would be
                     a control that closes the panel it lives in, which is the floating window's job and the strip's.
                     The panel answers the press, the way it answers `focus`, which chats are on screen is
                     the frame's state, not any one pane's. -->
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

        <!-- WHAT THE READER CAN RUN NEXT, in the room the panes have no use for. Outside the pane column on
             purpose: it belongs to the WINDOW, not to any one chat, exactly as the chat list on the other edge
             does. It yields to the panes rather than competing with them — adding a column takes its width back
             without asking (see showsCapacity), which is why the pane-fit above does not count it.

             OUT OF THE FLOW rather than last in the row: it is drawn over the margin the transcript was already
             leaving empty, and the width it needs is reserved inside the scroller instead (--capacity-rail, in
             the style block). That is what lets the transcript's scrollbar keep the window's edge, which the
             note at the top of this template spends a paragraph explaining the value of. -->
        <ChatCapacityRail v-if="showsCapacity" />
    </div>
</template>

<style scoped>
/* Equal columns with a hairline between them, and NOTHING that ranks one above the other.
 *
 * The focused pane used to wear a top accent, on the argument that keystroke routing should be visible. It
 * isn't a rank the reader has to see: every pane carries its own composer, so where the typing goes is already
 * said by the caret sitting in one of them, and the accent only ever answered a question the panel had stopped
 * asking. What it DID do was make two chats a reader had put side by side to compare read as a main one and a
 * spare: a stripe across the top of one column, which is the loudest thing the panel draws. Panes are equals;
 * the panel says so by drawing them the same. */
.chat-panes :deep(.chat-pane) {
    flex: 1 1 0;
    min-width: var(--min-pane);
}
.chat-panes :deep(.chat-pane + .chat-pane) {
    border-left: 1px solid var(--color-line);
}
/* What the headroom rail's width is taken out of is NOT this row — the rail is drawn over the margin instead,
 * and the pane that borders it pads itself by --capacity-rail. Those two rules live in chat.css beside the
 * scroller gutter they are about, and they qualify themselves with .chat-panel to outrank the basis above. */
</style>
