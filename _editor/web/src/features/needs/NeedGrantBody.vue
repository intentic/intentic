<!-- A grant need's own answer: allow it for this conversation, or on the persona for every conversation wearing it. -->
<script setup lang="ts">
import type { GrantNeed, GrantScope, Need } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: GrantNeed }>();

const needs = useNeeds();
// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const grant = async (scope: GrantScope): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: scope, failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `grant`, scope } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <!-- A site is the person's own browser's to allow: the card only says what is being waited on. -->
        <span v-if="subject.subject === `site`" class="text-xs text-content/85">{{ t(`needs.grant.site`, { site: subject.what }) }}</span>
        <template v-else>
            <span class="text-xs text-content/85">{{
                subject.persona === undefined ? t(`needs.grant.withheld`, { label: subject.label }) : t(`needs.grant.withheldBy`, { label: subject.label, persona: subject.persona })
            }}</span>
            <span class="text-2xs text-subtle">{{ t(`needs.grant.nextTurn`) }}</span>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="grant(`conversation`)">{{ t(`needs.grant.forConversation`) }}</ChatDecisionButton>
                <ChatDecisionButton v-if="subject.persona" tone="secondary" icon="shield" :disabled="busy" @click="grant(`persona`)">{{
                    t(`needs.grant.onPersona`, { persona: subject.persona })
                }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </template>
        <!-- A site's no is its browser's; the card can still be put away. -->
        <div v-if="subject.subject === `site`"><slot name="decline" /></div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
