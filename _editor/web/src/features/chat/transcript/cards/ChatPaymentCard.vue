<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { offerStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.paymentOffer!);
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
        <div class="chat-card-body flex flex-col gap-1">
            <span v-if="card.offer.description" class="text-xs text-content/85">{{ card.offer.description }}</span>
            <!-- Full URL on hover, since a truncated host is exactly how a lookalike endpoint gets paid. -->
            <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="card.offer.url">{{ card.offer.url }}</span>
            <span class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="card.offer.payTo">{{
                t(`chat.chatMessageView.to`, { payTo: card.offer.payTo })
            }}</span>
            <span v-if="card.offer.why" class="text-2xs text-subtle">{{ t(`chat.chatMessageView.agentsCase`, { why: card.offer.why }) }}</span>
            <span class="pt-1 font-mono text-xs text-content">{{
                t(`chat.chatMessageView.spentToday`, {
                    amountUsd: card.offer.amountUsd,
                    spentTodayUsd: card.offer.spentTodayUsd,
                    dailyCapUsd: card.offer.dailyCapUsd,
                })
            }}</span>
        </div>

        <!-- A receipt is shown only after the endpoint settles the payment. -->
        <div v-if="card.receipt" class="chat-card-row">
            <span v-if="card.receipt.outcome === 'paid'" class="truncate text-2xs text-muted"
                >{{ t(`chat.chatMessageView.paid`, { amount: card.receipt.amountUsd })
                }}<template v-if="card.receipt.transaction"
                    ><span class="font-mono"> · {{ card.receipt.transaction }}</span></template
                ></span
            >
            <span v-else class="text-2xs text-muted">{{ t(`chat.chatMessageView.paymentDidntGoThrough`) }}</span>
        </div>

        <template v-if="card.status === 'pending'" #actions>
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
