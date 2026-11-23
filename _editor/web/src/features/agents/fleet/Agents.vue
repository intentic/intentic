<script setup lang="ts">
import { useDevice } from "@intentic/ui";
import { computed, nextTick } from "vue";
import { useWallpaper } from "../../../skins/useWallpaper";
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
   folded into its strip or in a window of its own, it stands in the board's bottom-right corner instead (AgentsView's
   `corner` slot), the same one column the chat draws, on a card's ground, and the Finished lane above it gives up the
   cards it has no room for, so it never makes the board scroll (cornerFit.ts). Until 2026-11-23 it was a strip under the
   whole board with the providers laid side by side, which read as a table of bars no one could follow. A phone's board is
   a screen of its own, with no room for it. */
const { mobile } = useDevice();
const usageHere = computed(() => !mobile.value && !chatRailOnScreen.value);
// The focused chat's account, marked in Usage left as the one the reader typing beside it is spending (ChatSideRail's rule).
const chat = useChat();
const mine = computed((): CapacityMine => {
    const { selection } = chat.active.value;
    return { provider: selection.provider.value, account: selection.account.value };
});

/* WITHOUT A WALLPAPER THE BOARD LIES ON THE CHAT'S OWN SURFACE, not the darker canvas: beside the docked chat the two read as
   one page. On that card ground a card steps toward the overlay (by day toward the paper's cream) rather than resting at
   the colour it lies on (styles.css `.ground-card`), the way the chat's own rows do, so it keeps its edge. A wallpaper
   draws its picture on the board instead (skins/wallpapers.css). */
const { wallpaper } = useWallpaper();
const plain = computed(() => wallpaper.value === `none`);

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
    <div class="flex h-full min-h-0 flex-col" :class="{ 'ground-card bg-card': plain }">
        <AgentsView class="min-h-0 flex-1" :with-corner="usageHere">
            <template v-if="usageHere" #corner>
                <!-- A reveal column of its own, so the board's opening plays its rows from its top, as its own reveal does, rather than
                     as more of Finished's cards. -->
                <ChatCapacityRail :mine="mine" data-reveal-column class="rounded-2xl border border-line bg-card" />
            </template>
        </AgentsView>
    </div>
</template>
