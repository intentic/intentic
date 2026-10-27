<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatAgentCase from "../../../../components/card/ChatAgentCase.vue";
import ChatCard from "../../../../components/ChatCard.vue";
import ChatCardFacts, { type CardFact } from "../../../../components/card/ChatCardFacts.vue";
import ChatCardOutcome from "../../../../components/card/ChatCardOutcome.vue";
import ChatDecisionButton from "../../../../components/ChatDecisionButton.vue";
import { offerStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.paymentOffer!);
const pending = computed(() => card.value.status === `pending`);
// The wallet that pays is the owner's, and the sandbox takes a payment's answer from the owner alone
// (wallet/payment-offer.ts), so anyone else is told whose click it waits for instead of offered one it refuses.
const { isOwner } = useRole();

// Where the money goes and how much of the day's cap is already spent, as facts in one column. The endpoint and the payee
// are shown whole: a truncated host is exactly how a lookalike endpoint gets paid.
const facts = computed<CardFact[]>(() => [
    { key: `url`, label: t(`chat.cardFacts.endpoint`), value: card.value.offer.url, mono: true },
    { key: `payTo`, label: t(`chat.cardFacts.paysTo`), value: card.value.offer.payTo, mono: true },
    {
        key: `today`,
        label: t(`chat.cardFacts.spentToday`),
        value: t(`chat.cardFacts.spentOf`, { spent: card.value.offer.spentTodayUsd, cap: card.value.offer.dailyCapUsd }),
    },
]);
</script>

<template>
    <!-- Payment figures come from the endpoint challenge and wallet ledger. -->
    <ChatCard
        icon="credit-card"
        :title="
            t(`chat.chatMessageView.pay`, {
                amountUsd: card.offer.amountUsd,
                assetName: card.offer.assetName,
            })
        "
        :status="offerStatus(card)"
    >
        <!-- Waiting: what it buys, the agent's case, then where the money goes. -->
        <div v-if="pending" class="chat-card-body flex flex-col gap-2">
            <span v-if="card.offer.description" class="text-xs text-content/85">{{ card.offer.description }}</span>
            <ChatAgentCase v-if="card.offer.why" :text="card.offer.why" />
            <ChatCardFacts :facts="facts" />
        </div>

        <!-- Over: the receipt, once the endpoint settled it, with the ask one press away. -->
        <ChatCardOutcome v-else :facts="card.receipt !== undefined" :more="t(`chat.cardOutcome.details`)">
            <template v-if="card.receipt?.outcome === `paid`">
                <span class="text-content/85">{{ t(`chat.chatMessageView.paid`, { amount: card.receipt.amountUsd }) }}</span>
                <span v-if="card.receipt.transaction" class="min-w-0 truncate font-mono" v-tooltip.top.overflow="card.receipt.transaction">{{
                    card.receipt.transaction
                }}</span>
            </template>
            <span v-else-if="card.receipt" class="inline-flex min-w-0 items-center gap-1.5 text-warning"
                ><Icon name="exclamation-triangle" class="shrink-0" />{{ t(`chat.chatMessageView.paymentDidntGoThrough`) }}</span
            >
            <template #folded>
                <span v-if="card.offer.description" class="text-xs text-content/85">{{ card.offer.description }}</span>
                <ChatAgentCase v-if="card.offer.why" :text="card.offer.why" />
                <ChatCardFacts :facts="facts" />
            </template>
        </ChatCardOutcome>

        <div v-if="pending && !isOwner" class="chat-card-row">
            <span class="text-2xs text-muted">{{ t(`chat.chatMessageView.paymentOwnerOnly`) }}</span>
        </div>

        <template v-if="pending && isOwner" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="reply({ kind: 'payment_offer', approve: true })">{{
                t(`chat.chatMessageView.pay2`, { amountUsd: card.offer.amountUsd })
            }}</ChatDecisionButton>
            <!-- Free and final: the agent is told to continue without it; nothing stops the turn. -->
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: 'payment_offer', approve: false })">{{
                t(`chat.chatMessageView.skipFree`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
