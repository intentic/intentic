<!-- A grant need's own answer: what a role withholds is access, which no card lifts, so the card offers the roles
     whose access has it, and a pick puts the conversation on that role from its next turn. -->
<script setup lang="ts">
import type { GrantNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
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
const switchTo = async (role: string): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: role, failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `grant`, role } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <!-- A site is the person's own browser's to allow: the card only says what is being waited on. -->
        <span v-if="subject.subject === `site`" class="text-xs text-content/85">{{ t(`needs.grant.site`, { site: subject.what }) }}</span>
        <template v-else>
            <span class="text-xs text-content/85">{{
                subject.role === undefined ? t(`needs.grant.withheld`, { label: subject.label }) : t(`needs.grant.withheldBy`, { label: subject.label, role: subject.role })
            }}</span>
            <!-- A need raised before roles were switched offers none: it can only be declined. -->
            <span v-if="(subject.roles ?? []).length > 0" class="text-2xs text-subtle">{{ t(`needs.grant.switchNextTurn`) }}</span>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton
                    v-for="(role, at) in subject.roles ?? []"
                    :key="role.id"
                    :tone="at === 0 ? `primary` : `secondary`"
                    icon="user"
                    :disabled="busy"
                    @click="switchTo(role.id)"
                    >{{ t(`needs.grant.switchTo`, { role: role.label }) }}</ChatDecisionButton
                >
                <slot name="decline" />
            </div>
        </template>
        <!-- A site's no is its browser's; the card can still be put away. -->
        <div v-if="subject.subject === `site`"><slot name="decline" /></div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
