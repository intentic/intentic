<!-- An open need's own way of being answered, wherever it is drawn: inside its chat card, or in the Needs you inbox's
     detail. The kind's yes, and "Not now" beside it with an optional word back to the agent. -->
<script setup lang="ts">
import type { Need, NeedAnswer } from "@intentic/sandbox-contract";
import { Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import NeedAutomationBody from "./NeedAutomationBody.vue";
import NeedCapabilityBody from "./NeedCapabilityBody.vue";
import NeedDecline from "./NeedDecline.vue";
import NeedEnvironmentBody from "./NeedEnvironmentBody.vue";
import NeedGrantBody from "./NeedGrantBody.vue";
import NeedReleaseBody from "./NeedReleaseBody.vue";
import NeedSecretBody from "./NeedSecretBody.vue";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need }>();

const needs = useNeeds();

// A decline, with an optional word for the agent; the note goes back with it. The decline is the need's, beside its yes
// (needAnswer.ts): held while either runs, and its refusal kept for whichever card draws the need next.
const declining = ref(false);
const note = ref(``);
const { busy, declineNotice: notice, decline: send } = useNeedAnswer(() => props.need);
const decline = async (): Promise<void> => {
    const said = note.value.trim();
    const answer: NeedAnswer = said === `` ? { kind: `decline` } : { kind: `decline`, note: said };
    const id = props.need.id;
    const ended = await send({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer }) });
    if (ended?.state === `done`) {
        declining.value = false;
    }
};
</script>

<template>
    <!-- "Not now" rides in the same row as the kind's yes. -->
    <NeedCapabilityBody v-if="need.subject.kind === `capability`" :need="need" :subject="need.subject">
        <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
    </NeedCapabilityBody>
    <NeedSecretBody v-else-if="need.subject.kind === `secret`" :need="need" :subject="need.subject">
        <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
    </NeedSecretBody>
    <NeedGrantBody v-else-if="need.subject.kind === `grant`" :need="need" :subject="need.subject">
        <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
    </NeedGrantBody>
    <!-- A release's no is its approvers' alone, so it keeps its own. -->
    <NeedReleaseBody v-else-if="need.subject.kind === `release`" :need="need" :subject="need.subject" />
    <NeedAutomationBody v-else-if="need.subject.kind === `automation`" :need="need" :subject="need.subject">
        <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
    </NeedAutomationBody>
    <NeedEnvironmentBody v-else :need="need" :subject="need.subject">
        <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
    </NeedEnvironmentBody>

    <div v-if="declining || notice" class="chat-card-row flex flex-col gap-2">
        <input v-if="declining" v-model="note" :placeholder="t(`needs.card.declineNote`)" :class="ui.input('w-full')" @keydown.enter.prevent="decline" />
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
