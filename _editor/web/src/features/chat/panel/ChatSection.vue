<!-- Full-screen /chat route, desktop only: publishes the dock slot the chat panel teleports into (shell/panelSlots.ts). -->
<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { nextTick, useTemplateRef } from "vue";
import { useChatFloating } from "../../../models/conversations/panel/chatFloating";
import { useLayout } from "../../../workbench/window/useLayout";
import { chatFullSlot, publishSlot } from "../../../workbench/window/panelSlots";
import { useT } from "@intentic/ui/i18n";
import { useChatFocusLink } from "./chatFocusLink";
import { useShellChatLink } from "./shellChatLink";
import { draftConversation } from "../../../models/conversations/panel/useChat-reveal";
import { summonChat } from "../../../models/conversations/run/summon";
import { focusComposer } from "../../../models/conversations/tabs/useChat-tabs";

const t = useT();

const { floats, dock } = useChatFloating();

/* STANDING HERE IS CHOOSING THE RAIL AS THE CHAT'S HOME. */
useLayout().setChatHome(`rail`);

/* A LINK NAMING A CONVERSATION (a notification's press) OPENS IT HERE. */
useChatFocusLink();
useShellChatLink(() => {
    if (floats.value) {
        dock();
    }
    const chat = draftConversation();
    summonChat({ kind: `reveal`, verb: `show`, entries: [chat], focus: chat.conversationId, caret: true });
    // The cold route mounts its pane after this component; ask for the caret once that message box exists.
    void nextTick(focusComposer);
});

const slot = useTemplateRef(`slot`);
publishSlot(chatFullSlot, () => slot.value);
</script>

<template>
    <div class="relative h-full w-full">
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this slot the instant the window goes. -->
        <div class="grid h-full w-full" style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr">
            <div ref="slot" class="contents"></div>
        </div>
        <EmptyState
            v-if="floats"
            icon="external-link"
            :title="t(`chat.chatArea.chatInOwnWindow`)"
            :line="t(`chat.chatArea.bringBackToFill`)"
            size="page"
            class="absolute inset-0 p-6"
        >
            <template #actions>
                <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`chat.chatArea.bringBackHere`) }} </Button>
            </template>
        </EmptyState>
    </div>
</template>
