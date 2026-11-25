<!-- A claim need's own answer: the project an agent asks to claim for this sandbox, so the owner's other sandboxes report
     its problems here (docs/architecture/account-routing.md). Only the owner's own platform sign-in writes a claim, so
     the press asks the platform from this browser first, then answers the need, which the daemon meets once the platform
     lists the project for this sandbox. Anyone else reads whom it waits on. -->
<script setup lang="ts">
import type { ClaimNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../../components/ChatDecisionButton.vue";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { apiClient } from "../../../lib/useApi";
import { useNeedAnswer } from "../needAnswer";
import { useNeeds } from "../../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: ClaimNeed }>();

const needs = useNeeds();
const { active } = useSandbox();
// The platform takes a claim from the sandbox's owner alone; the daemon's answer checks the same.
const owner = computed(() => active.value?.tier === `owner`);

const { busy, notice, answer } = useNeedAnswer(() => props.need);
const claim = async (): Promise<void> => {
    const sandboxId = active.value?.id;
    if (sandboxId === undefined) {
        return;
    }
    const id = props.need.id;
    const project = props.subject.project;
    await answer({
        failed: t(`needs.card.couldNotAnswer`),
        task: async () => {
            await apiClient.projects.claim({ sandboxId, project });
            await needs.answer.mutateAsync({ id, answer: { kind: `approve` } });
        },
    });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ t(`needs.claim.lead`, { project: subject.project }) }}</p>
        <span v-if="subject.heldBy" class="text-2xs text-subtle" data-claim-moves>{{ t(`needs.claim.moves`, { sandbox: subject.heldBy }) }}</span>
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton v-if="owner" tone="primary" icon="check" :disabled="busy" @click="claim">{{ t(`needs.claim.approve`) }}</ChatDecisionButton>
            <span v-else class="text-2xs text-subtle" data-claim-waits>{{ t(`needs.claim.ownerOnly`) }}</span>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
