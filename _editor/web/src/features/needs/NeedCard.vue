<!-- One need, answered where it is drawn: in the chat that raised it, pinned under the conversation, or in Needs you. -->
<script setup lang="ts">
import { isOpenNeed, type Need } from "@intentic/sandbox-contract";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { Notice, ui } from "@intentic/ui";
import { computed, ref } from "vue";
import ChatCard from "../chat/transcript/cards/ChatCard.vue";
import NeedCapabilityBody from "./NeedCapabilityBody.vue";
import NeedDecline from "./NeedDecline.vue";
import NeedEnvironmentBody from "./NeedEnvironmentBody.vue";
import NeedGrantBody from "./NeedGrantBody.vue";
import NeedReleaseBody from "./NeedReleaseBody.vue";
import NeedSecretBody from "./NeedSecretBody.vue";
import { NEED_ICONS, needStatus, toldLine, workingLine } from "./needStatus";
import { useNeeds } from "./useNeeds";

const t = useT();

// `snapshot` is the need as its transcript row recorded it when raised: what a card shows when the store no longer
// holds it (pruned, or a transcript opened on another sandbox). Live state always wins.
const props = defineProps<{ needId: string; snapshot?: Need | undefined }>();

const needs = useNeeds();
const need = computed<Need | undefined>(() => needs.byId(props.needId) ?? props.snapshot);
const open = computed(() => need.value !== undefined && isOpenNeed(need.value));

// A decline, with an optional word for the agent; the note goes back with it.
const declining = ref(false);
const note = ref(``);
const { busy, notice, run } = useAsyncAction();
const decline = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.needId, answer: { kind: `decline`, ...(note.value.trim() === `` ? {} : { note: note.value.trim() }) } });
        declining.value = false;
    }, t(`needs.card.couldNotAnswer`));
};
</script>

<template>
    <ChatCard v-if="need" :icon="NEED_ICONS[need.subject.kind]" :title="need.title" :status="needStatus(need)" prose>
        <div class="chat-card-body flex flex-col gap-1">
            <span v-if="need.why" class="text-2xs text-subtle">{{ t(`needs.card.agentsCase`, { why: need.why }) }}</span>
            <span v-if="need.unattended && open" class="text-2xs text-subtle">{{ t(`needs.card.unattended`) }}</span>
            <span v-if="workingLine(need)" class="flex items-center gap-1.5 text-2xs text-muted">
                <Icon name="spinner" spin class="text-link" />{{ workingLine(need) }}
            </span>
            <span v-if="!open && need.outcome" class="text-xs text-content/85">{{ need.outcome }}</span>
            <span v-if="toldLine(need)" class="text-2xs text-muted">{{ toldLine(need) }}</span>
            <span v-if="!open && need.answeredBy" class="text-2xs text-subtle">{{ t(`needs.card.answeredBy`, { who: need.answeredBy }) }}</span>
        </div>

        <!-- The kind's own way of saying yes, only while it waits; "Not now" rides in the same row as its yes. -->
        <template v-if="open">
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
            <NeedEnvironmentBody v-else :need="need" :subject="need.subject">
                <template #decline><NeedDecline :busy="busy" :declining="declining" @open="declining = true" @send="decline" @cancel="declining = false" /></template>
            </NeedEnvironmentBody>
        </template>

        <div v-if="open && declining" class="chat-card-row flex flex-col gap-2">
            <input v-model="note" :placeholder="t(`needs.card.declineNote`)" :class="ui.input('w-full')" @keydown.enter.prevent="decline" />
            <Notice v-if="notice" :of="notice" />
        </div>
    </ChatCard>
</template>
