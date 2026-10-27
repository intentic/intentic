<script setup lang="ts">
import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { navigateInApp } from "../../../../workbench/window/mainWindow";
import { entryDescription } from "../../../../models/capabilities/catalogCopy";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatAgentCase from "../../../../components/card/ChatAgentCase.vue";
import ChatCard from "../../../../components/ChatCard.vue";
import ChatCardOutcome from "../../../../components/card/ChatCardOutcome.vue";
import ChatDecisionButton from "../../../../components/ChatDecisionButton.vue";
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

// The static catalog's description, in the reader's language; absent for a contributed entry.
const description = computed(() => {
    const entry = CAPABILITY_CATALOG.find((candidate) => candidate.id === card.value.offer.entry);
    return entry === undefined ? undefined : entryDescription(entry);
});

// Still the reader's to act on: waiting for an answer, or for the setup that answer opened.
const live = computed(() => card.value.status === `pending` || (card.value.status === `connecting` && !card.value.outcome));
// The name setup saved the connection under, the one fact a settled card has that its "Connected" chip does not.
const savedAs = computed(() => (card.value.outcome?.outcome === `connected` && card.value.outcome.id ? card.value.outcome.id : undefined));
</script>

<template>
    <!-- Title and id come from the daemon-validated catalog, never the model. -->
    <ChatCard icon="bolt" :title="t(`chat.chatMessageView.isntConnectedYet`, { name: card.offer.name })" :status="capabilityStatus(card)">
        <template v-if="live">
            <div v-if="description || card.offer.why" class="chat-card-body flex flex-col gap-2">
                <span v-if="description" class="text-xs text-content/85">{{ description }}</span>
                <ChatAgentCase v-if="card.offer.why" :text="card.offer.why" />
            </div>

            <!-- Shown while the agent waits on setup, with a way back to the form if it was closed mid-flow. -->
            <div v-if="card.status === 'connecting'" class="chat-card-row flex items-center gap-2">
                <Icon name="spinner" class="text-2xs text-link" spin />
                <span class="min-w-0 flex-1 truncate text-2xs text-muted">{{ t(`chat.chatMessageView.waitingToFinishSetup`) }}</span>
                <ChatDecisionButton tone="secondary" icon="bolt" :to="setupAt(card.offer.entry)">{{
                    t(`chat.chatMessageView.openSetup`)
                }}</ChatDecisionButton>
            </div>
        </template>

        <!-- Over: the name it was saved under, with the case one press away; the chip says how it ended. -->
        <ChatCardOutcome v-else :facts="savedAs !== undefined" :more="card.offer.why ? t(`chat.cardOutcome.why`) : undefined">
            <span v-if="savedAs" class="inline-flex min-w-0 items-center gap-1.5" data-capability-saved-as>
                {{ t(`chat.cardFacts.savedAs`) }}<span class="truncate font-mono text-content/85">{{ savedAs }}</span>
            </span>
            <template #folded><ChatAgentCase v-if="card.offer.why" :text="card.offer.why" /></template>
        </ChatCardOutcome>

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
