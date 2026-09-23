<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { helpStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.browserHelp!);
</script>

<template>
    <!-- The agent's browser needs a person; the primary action navigates to /browsers, where the live stage and hand-back live. -->
    <ChatCard
        icon="desktop"
        icon-class="text-warning"
        :title="t(`chat.chatMessageView.agentsBrowserNeeds`, { account: card.account })"
        :status="helpStatus(card)"
    >
        <div class="chat-card-body text-xs text-content/85">{{ card.message }}</div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="desktop" :to="`/browsers/${card.session}`">{{
                t(`chat.chatMessageView.openBrowser`)
            }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: 'browser_help', helped: false })">{{
                t(`shared.cantHelpNow`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
