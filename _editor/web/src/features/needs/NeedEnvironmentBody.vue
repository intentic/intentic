<!-- An environment need's own answer: this one tool's steps, approved alone, then the rebuild that brings it. -->
<script setup lang="ts">
import type { EnvironmentNeed, Need } from "@intentic/sandbox-contract";
import { Code, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: EnvironmentNeed }>();

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
        <Code :code="subject.steps" lang="docker" :scroll-lines="12" />
        <template v-if="need.status === `open`">
            <span class="text-2xs text-subtle">{{ t(`needs.environment.approveOne`, { tool: subject.tool }) }}</span>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="approve">{{ t(`needs.environment.approve`) }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </template>
        <!-- Approved, not yet built: the rebuild is where the sandbox is run, so the Environment card is where it is started. -->
        <div v-else class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-content/85">{{ t(`needs.environment.rebuildToFinish`, { tool: subject.tool }) }}</span>
            <ChatDecisionButton tone="primary" icon="refresh" to="/sandbox/environment">{{ t(`needs.environment.openRebuild`) }}</ChatDecisionButton>
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
