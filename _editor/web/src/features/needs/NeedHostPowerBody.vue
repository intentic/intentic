<!-- A host-power need's own answer: what the computer this sandbox runs on would do to the work booked on it, one
     setting to a line with what approving makes it, and the notes nothing here can change. The daemon raises it, never
     an agent, so there is no case to read above it: the lines are the case. (2026-11-27) A Windows Update restart is no
     longer a note to put away: the card offers what answers it (restartRemedies), the computer starting its sandboxes
     before anyone signs in and Windows Update paused past the work, each a yes that also makes the changes above. -->
<script setup lang="ts">
import type { HostPowerNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { Code, Notice } from "@intentic/ui";
import { formatWhen } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { powerLine, powerNote, type RestartRemedy, restartPendingNote, restartRemedies, worstFirst } from "../../models/sandbox/devices/hostPower";
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

// What answers a Windows Update restart, the lasting answer first, and the warning a pause may not hold.
const remedies = computed(() => restartRemedies(props.subject, Date.now()));
const pending = computed(() => restartPendingNote(props.subject, device.value));
// Each answer's button: it also makes the changes listed above, and says so where there are any.
const remedyLabel = (remedy: RestartRemedy): string => {
    const also = changes.value.length > 0;
    if (remedy.remedy === `before-sign-in`) {
        return also ? t(`needs.hostPower.approveWithBoot`, { device: device.value }) : t(`needs.hostPower.approveBoot`, { device: device.value });
    }
    const until = remedy.until === undefined ? `` : formatWhen(remedy.until);
    return also ? t(`needs.hostPower.approveWithPause`, { until }) : t(`needs.hostPower.approvePause`, { until });
};

// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);
const approve = async (remedy?: RestartRemedy[`remedy`]): Promise<void> => {
    const id = props.need.id;
    const reply = remedy === undefined ? ({ kind: `approve` } as const) : ({ kind: `approve`, remedy } as const);
    await answer({ failed: t(`needs.card.couldNotAnswer`), task: () => needs.answer.mutateAsync({ id, answer: reply }) });
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
        <p v-if="pending && remedies.length > 0" class="text-2xs text-subtle" data-power-pending>{{ pending }}</p>
        <!-- Windows asks for permission on the computer itself: said before the press, not discovered after it. -->
        <p v-if="need.status === `open` && remedies.some((entry) => entry.remedy === `before-sign-in`)" class="text-2xs text-subtle">
            {{ t(`needs.hostPower.bootHint`, { device }) }}
        </p>

        <!-- A card of notes alone has nothing to approve, only to put away. Where the restart has answers, each is a yes
             of its own (and makes the changes above too); otherwise the one yes is the changes. -->
        <div v-if="need.status === `open`" class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton
                v-for="(entry, index) in remedies"
                :key="entry.remedy"
                :tone="index === 0 ? `primary` : `secondary`"
                :icon="entry.remedy === `before-sign-in` ? `refresh` : `pause`"
                :disabled="busy"
                :data-power-remedy="entry.remedy"
                @click="approve(entry.remedy)"
                >{{ remedyLabel(entry) }}</ChatDecisionButton
            >
            <ChatDecisionButton v-if="remedies.length === 0 && changes.length > 0" tone="primary" icon="check" :disabled="busy" @click="approve()">{{
                t(`needs.hostPower.approve`, { device })
            }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
