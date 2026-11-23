<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed, nextTick } from "vue";
import ChatCapacityRail from "../../chat/panel/capacity/ChatCapacityRail.vue";
import type { CapacityMine } from "../../chat/panel/capacity/chatCapacity";
import { useShellChatLink } from "../../chat/panel/shellChatLink";
import { chatRailOnScreen, showChat } from "../../../models/conversations/panel/chatPanelLayout";
import { draftConversation } from "../../../models/conversations/panel/useChat-reveal";
import { summonChat } from "../../../models/conversations/run/summon";
import { useChat } from "../../../models/conversations/run/useChat";
import { focusComposer } from "../../../models/conversations/tabs/useChat-tabs";
import AgentsView from "../board/AgentsView.vue";

/* The Agents area (/agents): every registered conversation in one lifecycle, with workspace and isolated placement shown
   on the same board, the chat standing on its right (shell/side). Also what a desktop's /chat lands on, and what a
   popped-out chat's window draws beside it (shell/window/FloatingSection.vue). */

/* USAGE LEFT STANDS ONCE, WHERE THERE IS ROOM FOR IT. The chat beside the board draws it in its own side rail, under its
   checklist, once the chat is wide enough for that rail (ChatPanel.vue `showsRail`). Until then, and while the chat is
   folded into its strip or in a window of its own, it stands under the board instead, the same rows laid across. A phone's
   board is a screen of its own, with no room under it. */
const { mobile } = useDevice();
const usageHere = computed(() => !mobile.value && !chatRailOnScreen.value);
// The focused chat's account, marked in Usage left as the one the reader typing beside it is spending (ChatSideRail's rule).
const chat = useChat();
const mine = computed((): CapacityMine => {
    const { selection } = chat.active.value;
    return { provider: selection.provider.value, account: selection.account.value };
});

/* THE DESKTOP APP'S SUPER+SPACE (`?shellChat=`, through /chat) opens a blank draft in the chat beside the board. No message
   is sent and no agent starts until the person presses Send. */
useShellChatLink(() => {
    const draft = draftConversation();
    showChat();
    summonChat({ kind: `reveal`, verb: `show`, entries: [draft], focus: draft.conversationId, caret: true });
    // A cold route mounts the pane after this component; ask for the caret once that message box exists.
    void nextTick(focusComposer);
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <!-- `flex-1` outranks the board's own `h-full` (a flex basis wins over a height), so the strip below keeps its rows. -->
        <AgentsView class="min-h-0 flex-1" />
        <!-- At most a part of the column, scrolling past that. -->
        <ChatCapacityRail v-if="usageHere" :mine="mine" across class="max-h-[40%] shrink-0 border-t border-line" />
    </div>
</template>
