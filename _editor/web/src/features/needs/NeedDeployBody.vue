<!-- A deploy need's own answer: a managed stack (the Deployments extension's) let receive the secrets an agent asked for
     it (`secrets grant-stack`). Names only, the ones it has not been granted yet marked, on the computer named by its
     device card; a yes grants exactly these there and nothing else, which the daemon holds to the owner or Full access,
     signed in (needs/kinds/deploy-need.ts). -->
<script setup lang="ts">
import type { DeployNeed } from "@intentic/sandbox-contract/schemas/stack-grants";
import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: DeployNeed }>();

// The computer as the card names it: its device card, and what it calls itself when its agent has said.
const device = computed(() => (props.subject.deviceName === undefined ? props.subject.device : `${props.subject.device} (${props.subject.deviceName})`));

const needs = useNeeds();
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const approve = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `approve` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ t(`needs.deploy.lead`, { stack: subject.stack, repo: subject.repo, device }) }}</p>
        <ul class="flex flex-wrap gap-1.5 text-xs">
            <li v-for="name in subject.secrets" :key="name" class="flex items-center gap-1 font-mono" data-deploy-secret>
                <span class="text-content">{{ name }}</span>
                <span v-if="subject.ungranted.includes(name)" class="text-2xs text-subtle">{{ t(`needs.deploy.new`) }}</span>
            </li>
        </ul>
        <p class="text-2xs text-subtle">{{ t(`needs.deploy.note`, { device }) }}</p>
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="approve">{{ t(`needs.deploy.approve`, { stack: subject.stack }) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
