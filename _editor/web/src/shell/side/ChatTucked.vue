<script setup lang="ts">
import { toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useTemplateRef } from "vue";
import { laneOfTab } from "../../features/chat/tabs/tabs";
import { turnInFlight } from "../../models/agent-status/agentStatus-standing";
import { useChat } from "../../models/conversations/run/useChat";
import { useAgents } from "../../models/fleet/useAgents";
import { commandShortcut } from "../../workbench/commands/useCommands";

// THE CHAT, TUCKED AWAY: the strip it folds into at the window's edge (models/conversations/panel/chatPanelLayout.ts
// `chatTucked`), as what was opened beside folds into SideTucked. The chat stays mounted behind the edge, so a press here
// brings it back as it was left. The whole strip is the press; what it shows is what would make the reader open it:
// chats waiting on them, and chats at work, the two marks the chat's own header carries.

const emit = defineEmits<{ reveal: [] }>();

const t = useT();
const { conversations } = useChat();
const { agentById } = useAgents();

const attentionCount = computed(
    () => conversations.value.filter((conversation) => laneOfTab(conversation, agentById(conversation.conversationId)) === `attention`).length,
);
const runningCount = computed(
    () =>
        conversations.value.filter((conversation) => {
            const agent = agentById(conversation.conversationId);
            return agent !== undefined ? turnInFlight(agent) : conversation.turn.streaming.value;
        }).length,
);

const press = useTemplateRef<HTMLButtonElement>(`press`);
// The panel hands the keyboard here when it tucks the chat away from a press inside it.
const focus = (): void => press.value?.focus();
defineExpose({ focus });
</script>

<template>
    <button
        ref="press"
        type="button"
        class="side-chat-tucked touch-target flex w-8 shrink-0 flex-col items-center gap-2 bg-card py-2 text-muted hover:bg-overlay hover:text-content"
        :aria-label="t(`shell.sidePanel.showChat`)"
        v-tooltip.left="{ title: t(`shell.sidePanel.showChat`), keys: commandShortcut(`chat.toggleTucked`) }"
        @click="emit('reveal')"
    >
        <Icon name="chevrons-left" class="text-xs" />
        <Icon name="comments" class="text-sm" />
        <span v-if="attentionCount > 0" class="ui-status-pill font-semibold" :class="toneWash(`warning`)" :aria-label="t(`chat.chatTabs.need`, { attentionCount })">
            {{ attentionCount }}
        </span>
        <span v-if="runningCount > 0" class="flex flex-col items-center gap-0.5 text-2xs text-subtle" :aria-label="t(`chat.chatTabs.running`, { runningCount })">
            <Icon name="spinner" spin class="text-2xs" />{{ runningCount }}
        </span>
    </button>
</template>
