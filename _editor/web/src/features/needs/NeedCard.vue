<!-- One need, answered where it is drawn: in the chat that raised it, pinned under the conversation, or in Needs you. -->
<script setup lang="ts">
import { isOpenNeed, type Need } from "@intentic/sandbox-contract/schemas/needs";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatAgentCase from "../../components/card/ChatAgentCase.vue";
import ChatCard from "../../components/ChatCard.vue";
import NeedAnswer from "./NeedAnswer.vue";
import NeedOutcome from "./NeedOutcome.vue";
import { NEED_ICONS, needStatus, workingLine } from "../../models/needs/needStatus";
import { useNeeds } from "../../models/needs/useNeeds";
import { useNeedReach } from "./needReach";

const t = useT();

// `snapshot` is the need as its transcript row recorded it when raised: what a card shows when the store no longer
// holds it (pruned, or a transcript opened on another sandbox). Live state always wins.
const props = defineProps<{ needId: string; snapshot?: Need | undefined }>();

const needs = useNeeds();
const need = computed<Need | undefined>(() => needs.byId(props.needId) ?? props.snapshot);
const open = computed(() => need.value !== undefined && isOpenNeed(need.value));
// A reader who may not answer reads the need and who it waits on, with no answers drawn. A release keeps its own card,
// which names its approvers and answers only for them (NeedReleaseBody).
const { mayAnswer, waiter } = useNeedReach();
const release = computed(() => need.value?.subject.kind === `release`);
const answerable = computed(() => need.value !== undefined && (release.value || mayAnswer(need.value)));
const working = computed(() => (need.value === undefined ? undefined : workingLine(need.value)));
const unattended = computed(() => need.value?.unattended === true && answerable.value);
// Anything to say above the kind's own answer: the agent's case first, since the decision rests on it.
const lead = computed(() => Boolean(need.value?.why) || unattended.value || !answerable.value || working.value !== undefined);
</script>

<template>
    <ChatCard v-if="need" :icon="NEED_ICONS[need.subject.kind]" :title="need.title" :status="needStatus(need)" prose>
        <!-- Waiting: the case for it, then the kind's own way of saying yes. -->
        <template v-if="open">
            <div v-if="lead" class="chat-card-body flex flex-col gap-1.5">
                <ChatAgentCase v-if="need.why" :text="need.why" />
                <span v-if="unattended" class="text-2xs text-subtle">{{ t(`needs.card.unattended`) }}</span>
                <span v-if="!answerable" class="flex items-center gap-1.5 text-2xs text-muted">
                    <Icon name="lock" aria-hidden="true" class="shrink-0" />{{ t(`needs.card.waitsOn.${waiter}`) }}
                </span>
                <span v-if="working" class="flex items-center gap-1.5 text-2xs text-muted">
                    <Icon name="spinner" spin class="text-link" />{{ working }}
                </span>
            </div>
            <NeedAnswer v-if="answerable" :need="need" />
        </template>

        <!-- Over: one line of what it ended as, with the case one press away. -->
        <NeedOutcome v-else :need="need" />
    </ChatCard>
</template>
