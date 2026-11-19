<!-- An instruction need's own answer: the exact change to an AGENTS.md, written into the owner's tree only on Approve. -->
<script setup lang="ts">
import type { InstructionNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { Code, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: InstructionNeed }>();

const needs = useNeeds();
// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const approve = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `approve` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <Code :code="subject.diff" lang="diff" :scroll-lines="12" />
        <span class="text-2xs text-subtle">{{ subject.creates === true ? t(`needs.instruction.creates`, { file: subject.file }) : t(`needs.instruction.everyConversation`, { file: subject.file }) }}</span>
        <div class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="approve">{{ t(`needs.instruction.approve`, { file: subject.file }) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
