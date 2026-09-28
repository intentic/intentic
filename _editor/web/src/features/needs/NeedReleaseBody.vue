<!-- A release need's own answer: only the people the gate names may release it, or decline it. -->
<script setup lang="ts">
import type { Need, ReleaseNeed } from "@intentic/sandbox-contract";
import { Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useSandboxSession } from "../sandbox/session/sandboxSession";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: ReleaseNeed }>();

const needs = useNeeds();
// A courtesy only: the daemon checks the verified identity against the gate, yes or no.
const { presentedEmail } = useSandboxSession();
const mayAnswer = computed(() => {
    const me = presentedEmail.value?.toLowerCase();
    return me === undefined || props.subject.approvers.some((approver) => approver.toLowerCase() === me);
});
const onlyThem = computed(() => t(`needs.release.onlyThem`, { approvers: props.subject.approvers.join(`, `) }));
const { busy, notice, run } = useAsyncAction();
const release = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `release` } });
    }, t(`needs.card.couldNotAnswer`));
};
const decline = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `decline` } });
    }, t(`needs.card.couldNotAnswer`));
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <span class="text-xs text-content/85">{{ t(`needs.release.whole`) }}</span>
        <span class="truncate text-2xs text-subtle" v-tooltip.left.overflow="subject.approvers.join(`, `)">{{
            t(`needs.release.approvers`, { approvers: subject.approvers.join(`, `) })
        }}</span>
        <div class="flex flex-wrap items-center gap-2" v-tooltip.top="mayAnswer ? undefined : onlyThem">
            <ChatDecisionButton tone="primary" icon="unlock" :disabled="busy || !mayAnswer" @click="release">{{ t(`needs.release.release`) }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" icon="times" :disabled="busy || !mayAnswer" @click="decline">{{ t(`needs.card.notNow`) }}</ChatDecisionButton>
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
