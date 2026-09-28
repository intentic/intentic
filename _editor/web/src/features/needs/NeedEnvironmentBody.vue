<!-- An environment need's own answer: this one tool's steps, approved alone, then the rebuild that brings it. -->
<script setup lang="ts">
import type { EnvironmentNeed, Need } from "@intentic/sandbox-contract";
import { Code, Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: EnvironmentNeed }>();

const needs = useNeeds();
const { busy, notice, run } = useAsyncAction();
const approve = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `approve` } });
    }, t(`needs.card.couldNotAnswer`));
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
