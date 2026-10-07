<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "../cards/ChatCard.vue";
import ChatDecisionButton from "../cards/ChatDecisionButton.vue";
import { pageAskStatus } from "../cards/cardStatus";
import ChatPageFrame from "./ChatPageFrame.vue";
import { usePageActions } from "./usePageActions";

// A page the agent asked to be answered on (`ask_page`): the page itself is the card's body, and what it sends back
// (`intentic.submit`) is the answer, through the chat's one reply like every card's. The page keeps working after it is
// answered, so a reader can look back at what they chose; it just cannot answer twice.

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.pageAsk!);
const actions = usePageActions(() => card.value.page);

// The page's answer, or why it was not taken; a card no longer waiting tells the page so rather than staying silent.
const submit = async (value: string): Promise<string | undefined> => {
    if (card.value.status !== `pending`) {
        return t(`chat.chatPages.alreadyAnswered`);
    }
    if (props.settling) {
        return t(`chat.chatPages.answering`);
    }
    await props.reply({ kind: `page_ask`, value });
    return props.message.pageAsk?.status === `pending` ? t(`chat.cardReplies.answersNotSubmitted`) : undefined;
};

// What was sent, on one line: the reader's own answer, as the agent read it.
const sent = computed(() => {
    const value = card.value.value;
    if (value === undefined) {
        return undefined;
    }
    return value.length > 160 ? `${value.slice(0, 159)}…` : value;
});
</script>

<template>
    <ChatCard icon="globe" icon-class="text-primary-500" :title="card.page.title" :status="pageAskStatus(card)">
        <p v-if="card.status === `pending`" class="chat-card-body text-xs text-muted">{{ t(`chat.chatPages.askHint`) }}</p>
        <div class="chat-card-body">
            <ChatPageFrame :page="card.page" :submit="submit" :message="actions.message" />
        </div>
        <p v-if="sent" class="chat-card-body flex min-w-0 items-center gap-1.5 text-2xs text-subtle">
            <span class="shrink-0">{{ t(`chat.chatPages.sent`) }}</span>
            <code class="min-w-0 truncate" v-tooltip.top.overflow="card.value">{{ sent }}</code>
        </p>

        <template v-if="card.status === `pending`" #actions>
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: `page_ask`, cancelled: true })">{{
                t(`chat.chatPages.dismiss`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
