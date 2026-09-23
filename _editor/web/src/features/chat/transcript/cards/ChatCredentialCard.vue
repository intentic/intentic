<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandboxSession } from "../../../sandbox/session/sandboxSession";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { credentialLane, offerStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.credentialOffer!);

// Whether the viewer is a named approver, case-insensitively; a courtesy only, since the daemon verifies identity.
const { presentedEmail } = useSandboxSession();
const mayRelease = computed(() => {
    const me = presentedEmail.value?.toLowerCase();
    return me === undefined || card.value.offer.approvers.some((approver) => approver.toLowerCase() === me);
});
</script>

<template>
    <!-- The only card addressed to named approvers, not whoever's reading: the daemon verifies identity against that list (secrets/credential-gate.ts). -->
    <ChatCard icon="key" :title="t(`chat.chatMessageView.releaseToAgent`, { subject: card.offer.subject })" :status="offerStatus(card)">
        <div class="chat-card-body flex flex-col gap-1">
            <!-- What's about to happen, phrased for the reader, not the daemon's internal terms. -->
            <span class="text-xs text-content/85">{{ credentialLane(card.offer) }}</span>
            <!-- Reference-form, not yet substituted with the real value, which is what makes it safe to show. -->
            <span v-if="card.offer.detail" class="truncate font-mono text-2xs text-subtle" v-tooltip.left.overflow="card.offer.detail">{{
                card.offer.detail
            }}</span>
            <span v-if="card.offer.why" class="text-2xs text-subtle">{{ t(`chat.chatMessageView.agentsCase`, { why: card.offer.why }) }}</span>
            <span class="truncate text-2xs text-subtle" v-tooltip.left.overflow="card.offer.approvers.join(`, `)">{{
                t(`chat.chatMessageView.approvers`, { approvers: card.offer.approvers.join(`, `) })
            }}</span>
            <!-- Scope comes from policy, not the click, so the label never overstates what one yes covers. -->
            <span class="pt-1 text-xs text-content">{{
                card.offer.scope === `conversation`
                    ? t(`chat.chatMessageView.releasingCoversRestConversation`)
                    : t(`chat.chatMessageView.releasingCoversOneUse`)
            }}</span>
        </div>

        <!-- Nothing shown for an unanswered card; the header chip already says so. -->
        <div v-if="card.receipt" class="chat-card-row">
            <span v-if="card.receipt.outcome === 'released'" class="truncate text-2xs text-muted">{{
                t(`chat.chatMessageView.releasedBy`, { approvedBy: card.receipt.approvedBy })
            }}</span>
            <span v-else class="text-2xs text-muted"
                >{{ t(`chat.chatMessageView.refused`)
                }}<template v-if="card.receipt.approvedBy">{{ t(`chat.chatMessageView.by`, { approvedBy: card.receipt.approvedBy }) }}</template
                >{{ t(`chat.chatMessageView.agentToldToCarry`) }}</span
            >
        </div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton
                tone="primary"
                icon="check"
                :disabled="settling || !mayRelease"
                v-tooltip="mayRelease ? undefined : t(`chat.chatMessageView.onlyCanRelease`, { approvers: card.offer.approvers.join(`, `) })"
                @click="reply({ kind: 'credential_offer', approve: true })"
                >{{ t(`chat.chatMessageView.release`) }}</ChatDecisionButton
            >
            <!-- Declining is approver-only too, or anyone with a session could stop someone else's turn. -->
            <ChatDecisionButton
                tone="secondary"
                icon="times"
                :disabled="settling || !mayRelease"
                v-tooltip="mayRelease ? undefined : t(`chat.chatMessageView.onlyCanAnswer`, { approvers: card.offer.approvers.join(`, `) })"
                @click="reply({ kind: 'credential_offer', approve: false })"
                >{{ t(`shared.skip`) }}</ChatDecisionButton
            >
        </template>
    </ChatCard>
</template>
