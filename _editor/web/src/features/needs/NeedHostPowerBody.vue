<!-- A host-power need's own answer: what the computer this sandbox runs on would do to the work booked on it, one
     setting to a line with what approving makes it, and the notes nothing here can change. The daemon raises it, never
     an agent, so there is no case to read above it: the lines are the case. -->
<script setup lang="ts">
import type { HostPowerNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { Code, Notice } from "@intentic/ui";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { powerLine, powerNote, worstFirst } from "../../models/sandbox/devices/hostPower";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: HostPowerNeed }>();

const needs = useNeeds();
const device = computed(() => props.subject.device);
// The booked moment on the reader's own clock, said the way a scheduled send is: a weekday inside the week, a date past it.
const lead = computed(() =>
    props.subject.dueAt === undefined
        ? t(`needs.hostPower.leadUndated`, { device: device.value })
        : t(`needs.hostPower.lead`, { device: device.value, when: formatWhen(props.subject.dueAt) }),
);
// What approving changes, worst first; then what it leaves as it is, each with what the reader can do about it.
const changes = computed(() => worstFirst(props.subject.findings.filter((finding) => finding.fixable)).map((finding, index) => powerLine(finding, index)));
const notes = computed(() => props.subject.findings.filter((finding) => !finding.fixable).map((finding, index) => powerNote(finding, device.value, index)));

// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const approve = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `approve` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p class="text-xs text-content/85">{{ lead }}</p>

        <!-- Each as it reads now, then as it reads after the yes, the way a setting change is drawn (NeedChangeFacts). -->
        <ul v-if="changes.length > 0" class="flex flex-col gap-1 text-xs">
            <li v-for="line in changes" :key="line.key" class="flex min-w-0 flex-wrap items-center gap-x-1.5" data-power-change>
                <span class="text-content/85">{{ line.now }}</span>
                <template v-if="line.becomes">
                    <Icon name="arrow-right" class="text-2xs text-subtle" aria-hidden="true" />
                    <span class="font-medium text-content">{{ line.becomes }}</span>
                </template>
            </li>
        </ul>

        <template v-for="note in notes" :key="note.key">
            <p class="text-2xs text-subtle" data-power-note>{{ note.text }}</p>
            <!-- Run by hand on that computer: shown whole and copyable, since nothing here runs it. -->
            <Code v-if="note.command" :code="note.command" lang="bash" wrap />
        </template>

        <!-- A card of notes alone has nothing to approve, only to put away. -->
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton v-if="changes.length > 0" tone="primary" icon="check" :disabled="busy" @click="approve">{{
                t(`needs.hostPower.approve`, { device })
            }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
