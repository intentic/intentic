<script setup lang="ts">
import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { navigateInApp } from "../../../../shell/window/mainWindow";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
import ChatCard from "./ChatCard.vue";
import ChatDecisionButton from "./ChatDecisionButton.vue";
import { capabilityStatus } from "./cardStatus";

const t = useT();

const props = defineProps<{ message: ChatMessage; settling: boolean; reply: (answer: CardAnswer) => Promise<void> }>();
const card = computed(() => props.message.capabilityOffer!);

const router = useRouter();
const setupAt = (entry: string): string => `/capabilities/${entry}`;
// Connect both un-parks the turn and opens the Capabilities page at this card; the press holds for the answer only.
const connect = async (): Promise<void> => {
    navigateInApp(router, setupAt(card.value.offer.entry));
    await props.reply({ kind: `capability_offer`, connect: true });
};

// The static catalog's description; absent for a contributed entry.
const description = computed(() => CAPABILITY_CATALOG.find((entry) => entry.id === card.value.offer.entry)?.description);
</script>

<template>
    <!-- Title and id come from the daemon-validated catalog, never the model. -->
    <ChatCard icon="bolt" :title="t(`chat.chatMessageView.isntConnectedYet`, { name: card.offer.name })" :status="capabilityStatus(card)">
        <div class="chat-card-body flex flex-col gap-1">
            <span v-if="description" class="text-xs text-content/85">{{ description }}</span>
            <span v-if="card.offer.why" class="text-2xs text-subtle">{{ t(`chat.chatMessageView.agentsCase`, { why: card.offer.why }) }}</span>
        </div>

        <!-- Shown while the agent waits on setup, with a way back to the form if it was closed mid-flow. -->
        <div v-if="card.status === 'connecting' && !card.outcome" class="chat-card-row flex items-center gap-2">
            <Icon name="spinner" class="text-2xs text-link" spin />
            <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ t(`chat.chatMessageView.waitingToFinishSetup`) }}</span>
            <ChatDecisionButton tone="secondary" icon="bolt" :to="setupAt(card.offer.entry)">{{
                t(`chat.chatMessageView.openSetup`)
            }}</ChatDecisionButton>
        </div>

        <!-- How the accepted ask resolved: what the agent did next. -->
        <div v-if="card.outcome" class="chat-card-row">
            <span v-if="card.outcome.outcome === 'connected'" class="text-2xs text-muted"
                >{{ t(`shared.connected`) }}<template v-if="card.outcome.id">{{ t(`chat.chatMessageView.as`, { id: card.outcome.id }) }}</template
                >{{ t(`chat.chatMessageView.agentContinuing`) }}</span
            >
            <span v-else class="text-2xs text-muted">{{ t(`chat.chatMessageView.setupDidntFinishWhile`) }}</span>
        </div>

        <template v-if="card.status === 'pending'" #actions>
            <ChatDecisionButton tone="primary" icon="check" :disabled="settling" @click="connect">{{
                t(`chat.chatMessageView.connect`, { name: card.offer.name })
            }}</ChatDecisionButton>
            <!-- Final for this conversation: the agent continues without it and won't ask again. -->
            <ChatDecisionButton tone="secondary" icon="times" :disabled="settling" @click="reply({ kind: 'capability_offer', connect: false })">{{
                t(`chat.chatMessageView.notNow`)
            }}</ChatDecisionButton>
        </template>
    </ChatCard>
</template>
