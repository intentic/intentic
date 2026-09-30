<!-- One need, answered where it is drawn: in the chat that raised it, pinned under the conversation, or in Needs you. -->
<script setup lang="ts">
import { isOpenNeed, type Need } from "@intentic/sandbox-contract";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatCard from "../chat/transcript/cards/ChatCard.vue";
import NeedAnswer from "./NeedAnswer.vue";
import { NEED_ICONS, needStatus, toldLine, workingLine } from "./needStatus";
import { useNeeds } from "./useNeeds";

const t = useT();

// `snapshot` is the need as its transcript row recorded it when raised: what a card shows when the store no longer
// holds it (pruned, or a transcript opened on another sandbox). Live state always wins.
const props = defineProps<{ needId: string; snapshot?: Need | undefined }>();

const needs = useNeeds();
const need = computed<Need | undefined>(() => needs.byId(props.needId) ?? props.snapshot);
const open = computed(() => need.value !== undefined && isOpenNeed(need.value));
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

        <!-- The kind's own way of saying yes, only while it waits. -->
        <NeedAnswer v-if="open" :need="need" />
    </ChatCard>
</template>
