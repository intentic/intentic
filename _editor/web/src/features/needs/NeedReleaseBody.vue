<!-- A release need's own answer: only the people the gate names may release it, or decline it. -->
<script setup lang="ts">
import type { Need, ReleaseNeed } from "@intentic/sandbox-contract/schemas/needs";
import { Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useSandboxSession } from "../../client/session/sandboxSession";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: ReleaseNeed }>();

const needs = useNeeds();
// A courtesy only: the daemon checks the verified identity against the gate, yes or no.
const { presentedEmail } = useSandboxSession();
const mayAnswer = computed(() => {
    const me = presentedEmail.value?.toLowerCase();
    return me === undefined || props.subject.approvers.some((approver) => approver.toLowerCase() === me);
});
// The names are on the line above, so the hover only says why the buttons are off.
const onlyThem = computed(() => t(`needs.release.approversOnly`));
// The need's answer, wherever it is drawn (needAnswer.ts). Its no is its approvers' alone, so it is this card's too.
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const release = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: `release`, failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `release` } }) });
};
const decline = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: `decline`, failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `decline` } }) });
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
