<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useTerminalPanel } from "../../../terminal/useTerminalPanel";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { helpStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.terminalHelp!);

// The target is a panel, not a route, focused on the agent's session.
const openTerminal = (): void =>
    useTerminalPanel().openFocused(card.value.session, { title: t(`chat.chatMessageView.agentNeedsAtTerminal`), detail: card.value.message });
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
