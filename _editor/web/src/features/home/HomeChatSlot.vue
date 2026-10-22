<!-- The master view's chat area (desktop): lends the shell's own chat panel this page, as the /chat section and a
     popped-out window do (ChatSection.vue, FloatingSection.vue), so the home conversation is drawn by the very panel every
     other chat is, on its own surface, with its usage rail. PoppablePanels.vue mounts it here without its tab row. -->
<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { useTemplateRef } from "vue";
import { useT } from "@intentic/ui/i18n";
import { useChatFloating } from "../../models/conversations/panel/chatFloating";
import { chatFullSlot, publishSlot } from "../../workbench/window/panelSlots";

const t = useT();
const { floats, dock } = useChatFloating();
const slot = useTemplateRef(`slot`);
publishSlot(chatFullSlot, () => slot.value);
</script>

<template>
    <div class="relative min-h-0 flex-1">
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
