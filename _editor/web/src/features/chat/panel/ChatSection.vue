<!-- Full-screen /chat route, desktop only: publishes the dock slot the chat panel teleports into (shell/panelSlots.ts). -->
<script setup lang="ts">
import { Button } from "@intentic/ui";
import { onMounted, onUnmounted, useTemplateRef } from "vue";
import { useChatFloating } from "./chatFloating";
import { useLayout } from "../../../shell/window/useLayout";
import { chatFullSlot } from "../../../shell/window/panelSlots";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { floats, dock } = useChatFloating();

/* STANDING HERE IS CHOOSING THE RAIL AS THE CHAT'S HOME. */
useLayout().setChatHome(`rail`);

const slot = useTemplateRef(`slot`);
onMounted(() => {
    chatFullSlot.value = slot.value;
});
onUnmounted(() => {
    chatFullSlot.value = null;
});
</script>

<template>
    <div class="relative h-full w-full">
        <!-- Published even while another window holds the panel, so "Bring it back here" lands it in this slot the instant the window goes. -->
        <div class="grid h-full w-full" style="grid-template-areas: &quot;chat&quot;; grid-template-columns: 1fr; grid-template-rows: 1fr">
            <div ref="slot" class="contents"></div>
        </div>
        <div v-if="floats" class="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
            <Icon name="external-link" class="text-3xl text-subtle" />
            <div>
                <p class="text-sm font-medium text-content">{{ t(`chat.chatArea.chatInOwnWindow`) }}</p>
                <p class="mt-1 text-xs text-muted">{{ t(`chat.chatArea.bringBackToFill`) }}</p>
            </div>
            <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`chat.chatArea.bringBackHere`) }} </Button>
        </div>
    </div>
</template>
