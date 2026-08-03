<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed, nextTick, ref, watch } from "vue";
import type { Conversation } from "../composables/chat/conversation";
import { traceFocus } from "../composables/chat/focusTrace";
import { transcriptView } from "../composables/chat/transcriptClock";
import { useChat } from "../composables/chat/useChat";
import { useChatPopout } from "../composables/chat/useChatPopout";
import { useLayout } from "../composables/useLayout";
import ChatPane from "./ChatPane.vue";
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

const { active, activeId, conversations, panes, setActive, closeTabs, openConversation } = useChat();
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

        <!-- The panes, sharing the room equally (the terminal panel's split cells, which this is the chat's
             half of) until the floor, past which the row scrolls sideways rather than crushing them. -->
        <div ref="paneRow" class="chat-panes flex min-h-0 min-w-0 flex-1 overflow-x-auto" :class="{ 'chat-panes-split': split }">
            <ChatPane
                v-for="(conversation, at) in shown"
                :key="conversation.conversationId"
                :conversation="conversation"
                :focused="paneIds[at] === activeId"
                @focus="setActive(conversation.conversationId)"
            />
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
