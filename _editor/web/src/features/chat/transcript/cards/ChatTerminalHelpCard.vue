<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useTerminalPanel } from "../../../../models/terminal/useTerminalPanel";
import { terminalTabFor } from "../../../../models/terminal/runnerTerminals";
import { runnerOf } from "../../../../models/placement/runnerPlacement";
import { useChatSurface } from "../../../../models/conversations/tools/chatToolSurface";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatCard from "../../../../components/ChatCard.vue";
import ChatDecisionButton from "../../../../components/ChatDecisionButton.vue";
import { helpStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.terminalHelp!);
const surface = useChatSurface();

// The target is a panel, not a route, focused on the agent's session: the runner's, for a conversation that runs on one.
const openTerminal = (): void =>
    useTerminalPanel().openFocused(terminalTabFor(surface.resultConversation?.(), card.value.session, runnerOf), { title: t(`chat.chatMessageView.agentNeedsAtTerminal`), detail: card.value.message });
</script>

<template>
    <!-- Terminal offers appear as cards that link to the terminal view. -->
    <ChatCard icon="terminal" icon-class="text-warning" :title="t(`chat.chatMessageView.agentsTerminalNeeds`)" :status="helpStatus(card)">
        <div class="chat-card-body text-xs text-content/85">{{ card.message }}</div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="terminal" @click="openTerminal">{{ t(`chat.chatMessageView.openTerminal`) }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: 'terminal_help', helped: false })">{{
                t(`chat.words.cantHelpNow`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
