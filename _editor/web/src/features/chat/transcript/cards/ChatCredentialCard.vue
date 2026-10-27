<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSession } from "../../../../client/session/sandboxSession";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatAgentCase from "../../../../components/card/ChatAgentCase.vue";
import ChatCard from "../../../../components/ChatCard.vue";
import ChatCardFacts, { type CardFact } from "../../../../components/card/ChatCardFacts.vue";
import ChatCardOutcome from "../../../../components/card/ChatCardOutcome.vue";
import ChatCardPerson from "../../../../components/card/ChatCardPerson.vue";
import { useSomeoneElse } from "../../../../components/card/cardPerson";
import ChatDecisionButton from "../../../../components/ChatDecisionButton.vue";
import { credentialLane, offerStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.credentialOffer!);
const pending = computed(() => card.value.status === `pending`);

// Whether the viewer is a named approver, case-insensitively; a courtesy only, since the daemon verifies identity.
const { presentedEmail } = useSandboxSession();
const mayRelease = computed(() => {
    const me = presentedEmail.value?.toLowerCase();
    return me === undefined || card.value.offer.approvers.some((approver) => approver.toLowerCase() === me);
});

// Who may say yes and how far one yes goes. Scope comes from policy, not the click, so it never overstates what one yes
// covers.
const facts = computed<CardFact[]>(() => [
    { key: `approvers`, label: t(`chat.cardFacts.approvers`), value: card.value.offer.approvers.join(`, `) },
    {
        key: `covers`,
        label: t(`chat.cardFacts.covers`),
        value: card.value.offer.scope === `conversation` ? t(`chat.cardFacts.coversConversation`) : t(`chat.cardFacts.coversOneUse`),
    },
]);

// Settled, the receipt says who answered; the chip already says which way, and the agent carrying on is what any
// answer means.
const someoneElse = useSomeoneElse();
</script>

<template>
    <!-- The only card addressed to named approvers, not whoever's reading: the daemon verifies identity against that list (secrets/credential-gate.ts). -->
    <ChatCard icon="key" :title="t(`chat.chatMessageView.releaseToAgent`, { subject: card.offer.subject })" :status="offerStatus(card)">
        <!-- Waiting: what is about to happen, phrased for the reader, then the agent's case and the terms of a yes. -->
        <div v-if="pending" class="chat-card-body flex flex-col gap-2">
            <span class="text-xs text-content/85">{{ credentialLane(card.offer) }}</span>
            <!-- Reference-form, not yet substituted with the real value, which is what makes it safe to show. -->
            <span v-if="card.offer.detail" class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="card.offer.detail">{{
                card.offer.detail
            }}</span>
            <ChatAgentCase v-if="card.offer.why" :text="card.offer.why" />
            <ChatCardFacts :facts="facts" />
        </div>

        <!-- Over: who answered when it was not the reader, with the ask one press away. -->
        <ChatCardOutcome v-else :facts="someoneElse(card.receipt?.approvedBy)" :more="t(`chat.cardOutcome.details`)">
            <ChatCardPerson :who="card.receipt?.approvedBy" />
            <template #folded>
                <span class="text-xs text-content/85">{{ credentialLane(card.offer) }}</span>
                <span v-if="card.offer.detail" class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="card.offer.detail">{{
                    card.offer.detail
                }}</span>
                <ChatAgentCase v-if="card.offer.why" :text="card.offer.why" />
                <ChatCardFacts :facts="facts" />
            </template>
        </ChatCardOutcome>

        <template v-if="pending" #actions>
            <ChatDecisionButton
                tone="primary"
                icon="check"
                :disabled="settling || !mayRelease"
                v-tooltip="mayRelease ? undefined : t(`chat.chatMessageView.approversOnly`)"
                @click="reply({ kind: 'credential_offer', approve: true })"
                >{{ t(`chat.chatMessageView.release`) }}</ChatDecisionButton
            >
            <!-- Declining is approver-only too, or anyone with a session could stop someone else's turn. -->
            <ChatDecisionButton
                tone="secondary"
                icon="times"
                :disabled="settling || !mayRelease"
                v-tooltip="mayRelease ? undefined : t(`chat.chatMessageView.approversOnly`)"
                @click="reply({ kind: 'credential_offer', approve: false })"
                >{{ t(`ui.action.skip`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
