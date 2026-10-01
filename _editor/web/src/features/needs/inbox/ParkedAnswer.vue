<!-- A turn parked in its chat on a person: what it is waiting for, a permission's first answers right here, and the way
     into the chat, where the card that asked says what every other answer would do. -->
<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import CardPermissionAsk from "../../agents/board/cards/CardPermissionAsk.vue";
import { answerableAsk } from "../../agents/fleet/boardAnswer";
import { useAgents } from "../../agents/fleet/useAgents";
import ChatDecisionButton from "../../chat/transcript/cards/ChatDecisionButton.vue";
import type { ParkedAgent } from "./inboxItems";

const t = useT();

const props = defineProps<{ agent: ParkedAgent }>();

const { agentById } = useAgents();
// The live card, for the answer the board itself offers; the item only carries what the list needed.
const card = computed(() => agentById(props.agent.id));
const permission = computed(() => (card.value === undefined ? undefined : answerableAsk(card.value)));

// What it waits for, in the rank the board's chip reads (agentStatus.ts ATTENTION_RANK).
const waitingFor = computed<string>(() => {
    const { attention } = props.agent;
    if (attention.plan) {
        return t(`needs.inbox.parkPlan`);
    }
    if (attention.capability) {
        return t(`needs.inbox.parkCapability`);
    }
    if (attention.credential) {
        return t(`needs.inbox.parkCredential`);
    }
    if (attention.question) {
        return t(`needs.inbox.parkQuestion`);
    }
    if (attention.permission) {
        return t(`needs.inbox.parkPermission`);
    }
    return t(`needs.inbox.parkHandoff`);
});

const chat = computed(() => ({ path: `/`, query: { conversation: props.agent.id } }));
</script>

<template>
    <div class="flex flex-col gap-4">
        <p class="text-sm text-content/85">{{ waitingFor }}</p>
        <!-- A permission's "allow once" and "skip" are the board card's own, answered without the chat. -->
        <div v-if="card && permission" class="flex flex-col gap-2 rounded-lg bg-card shadow-sm p-3">
            <CardPermissionAsk :agent="card" />
            <span class="text-2xs text-subtle">{{ t(`needs.inbox.permissionMore`) }}</span>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton :tone="permission ? `secondary` : `primary`" icon="comments" :to="chat">{{ t(`needs.inbox.answerInChat`) }}</ChatDecisionButton>
        </div>
    </div>
</template>
