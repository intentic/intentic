<!-- THE BOARD BESIDE THE CHAT, in /chat's left column (features/chat/panel/board/chatBoard.ts): the Agents board as
     /agents draws it, with its search, owner filter, geek metrics, night and New agent, then Usage left under it, laid
     across, and the seam that sets how much of the route the two take. The chat stands to the right (ChatWithBoard.vue). -->
<script setup lang="ts">
import { ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import AgentsView from "../../features/agents/board/AgentsView.vue";
import ChatCapacityRail from "../../features/chat/panel/capacity/ChatCapacityRail.vue";
import type { CapacityMine } from "../../features/chat/panel/capacity/chatCapacity";
import {
    chatBoardShare,
    DEFAULT_BOARD_SHARE,
    MAX_BOARD_SHARE,
    MIN_BOARD_SHARE,
    setChatBoardShare,
    toggleChatBoard,
} from "../../features/chat/panel/board/chatBoard";
import { useChat } from "../../models/conversations/run/useChat";
import { uiLength } from "../../workbench/window/uiScale";

const t = useT();

// The route's width in screen pixels (ChatWithBoard measures it): the seam speaks in the pointer's pixels, the share is
// thousandths of this.
const { room } = defineProps<{ room: number }>();

// The narrowest the board is drawn whatever its share, in app pixels: its lanes stacked, a card's title on two lines.
const MIN_BOARD_PX = 360;

const toPx = (share: number): number => Math.round((share / 1000) * room);
const seam = computed<number>({
    get: () => toPx(chatBoardShare.value),
    set: (px) => {
        if (room > 0) {
            setChatBoardShare((px / room) * 1000);
        }
    },
});

// The width the pointer asks for while the seam is dragged (ResizeSeam's `preview`): only this column moves until the
// release, which stores the share once. Written every frame, the share re-laid out the board and the chat around it and
// told every other window, a third of a second a frame.
const dragged = ref<number | undefined>(undefined);
const width = computed(() => (dragged.value === undefined ? `${chatBoardShare.value / 10}%` : `${dragged.value}px`));

// The focused chat's account, marked in Usage left as the one the reader typing beside it is spending (ChatSideRail's rule).
const chat = useChat();
const mine = computed((): CapacityMine => {
    const { selection } = chat.active.value;
    return { provider: selection.provider.value, account: selection.account.value };
});
</script>

<template>
    <aside class="relative flex h-full min-h-0 shrink-0" :style="{ width, minWidth: uiLength(MIN_BOARD_PX) }">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- `flex-1` outranks the board's own `h-full` (a flex basis wins over a height), so the strip below keeps its rows. -->
            <AgentsView class="min-h-0 flex-1">
                <template #lead>
                    <!-- Pressed: the board is what this column shows; one press gives it back to the list of chats. -->
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `md`, on: true })"
                        aria-pressed="true"
                        :aria-label="t(`chat.chatBoard.showList`)"
                        v-tooltip.bottom="{ title: t(`chat.chatBoard.list`), note: t(`chat.chatBoard.listNote`) }"
                        @click="toggleChatBoard()"
                    >
                        <Icon name="robot" class="text-sm" />
                    </button>
                </template>
            </AgentsView>
            <!-- The panel's side rail gives way while the board stands here (features/chat/panel/ChatPanel.vue), so its usage moves under the
                 board, the same rows in the same style, side by side; at most a part of the column, scrolling past that. -->
            <ChatCapacityRail :mine="mine" across class="max-h-[40%] shrink-0 border-t border-line" />
        </div>
        <ResizeSeam
            v-model="seam"
            :min="toPx(MIN_BOARD_SHARE)"
            :max="toPx(MAX_BOARD_SHARE)"
            :reset="toPx(DEFAULT_BOARD_SHARE)"
            :preview="(px) => (dragged = px)"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />
    </aside>
</template>
