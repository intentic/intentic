<script setup lang="ts">
import type { TipRow, TooltipValue } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import { computed, inject, useTemplateRef } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { useToolCalls } from "../../../../models/conversations/tools/useToolCalls";
import { summarizeRun, type RunKind } from "../../tools/toolRun";
import ChatSpineNode from "../asides/ChatSpineNode.vue";
import { jobPhase } from "../jobPhase";
import { TRANSCRIPT_HOLD } from "../useStickToBottom";
import type { StepGroup } from "./stepGroups";

// A run of steps as ONE band in the seam (stepGroups.ts): the background jobs and the rows of calls between them, and the
// leading calls of the reply they led to. Pressed, the members open in place under one mark in the gutter, and the
// tail's calls open above its words (ChatTurnAsides' `merged`). Whether it is open lives with the pane, since the tail
// is a row of its own.

const props = defineProps<{
    group: StepGroup;
    live?: readonly AgentJob[];
    // Whether the group stands as its band (stepsFold); otherwise each member draws as it would alone.
    folds: boolean;
    open: boolean;
}>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();

const t = useT();
const { maker } = useAudience();
const { showToolCalls } = useToolCalls();

const jobs = computed(() => props.group.members.flatMap((member) => (member.backgroundJob === undefined ? [] : [member.backgroundJob])));
// Every row whose run the band stands for, the tail's included.
const runs = computed(() => [...props.group.members, ...(props.group.tail === undefined ? [] : [props.group.tail])].filter((row) => row.role === `assistant`));
const tools = computed((): readonly TranscriptTool[] => runs.value.flatMap((row) => row.tools ?? []));
const thoughts = computed(() => runs.value.filter((row) => (row.thinking ?? ``) !== ``).length);
const run = computed(() => summarizeRun(tools.value));
const jobFailures = computed(
    () => jobs.value.filter((job) => jobPhase(props.live?.find((entry) => entry.id === job.id)).kind === `failed`).length,
);
const failures = computed(() => jobFailures.value + (run.value?.failed ?? 0));
// Only jobs: said as jobs, as a lone job's band is. Anything else: counted as steps, as a run's band is.
const jobsOnly = computed(() => runs.value.length === 0);
const steps = computed(() => jobs.value.length + (run.value?.count ?? 0) + thoughts.value);

const spine = useTemplateRef<HTMLElement>(`spine`);
const hold = inject(TRANSCRIPT_HOLD, (_element, change) => change());
const toggle = (): void => hold(spine.value, () => emit(`update:open`, !props.open));
// A command the reader opened while its job ran stays on screen when the last job ends, and a find-in-page match opens
// the group it landed in. The rows stay mounted either way.
const reveal = (): void => {
    if (!props.open) {
        emit(`update:open`, true);
    }
};
const setShowToolCalls = (): void => hold(spine.value, () => {
    showToolCalls.value = true;
    emit(`update:open`, false);
});

const KIND_LABELS = {
    subagents: () => (maker.value ? t(`chat.chatTurnAsides.kindSubagentsMaker`) : t(`chat.chatTurnAsides.kindSubagents`)),
    edits: () => t(`chat.chatTurnAsides.kindEdits`),
    commands: () => t(`chat.chatTurnAsides.kindCommands`),
    web: () => t(`chat.chatTurnAsides.kindWeb`),
    searches: () => t(`chat.chatTurnAsides.kindSearches`),
    reads: () => t(`chat.chatTurnAsides.kindReads`),
    other: () => t(`chat.chatTurnAsides.kindOther`),
} satisfies Record<RunKind, () => string>;

const failureLine = computed(() => (failures.value > 0 ? t(`chat.chatJobRow.failures`, { count: failures.value }) : undefined));
const label = computed(() =>
    [
        jobsOnly.value ? t(`chat.chatJobRow.showJobs`, { count: jobs.value.length }) : t(`chat.chatTurnAsides.showSteps`, { count: steps.value }, steps.value),
        failureLine.value,
    ]
        .filter(Boolean)
        .join(` · `),
);
const foldLabel = computed(() =>
    jobsOnly.value ? t(`chat.chatJobRow.hideJobs`, { count: jobs.value.length }) : t(`chat.chatTurnAsides.foldSteps`),
);
// The count broken into what the steps were, so a hover answers "what was that" without opening anything.
const tip = computed((): TooltipValue => {
    if (jobsOnly.value) {
        return { title: t(`chat.chatJobRow.jobs`, { count: jobs.value.length }), note: failureLine.value };
    }
    const rows: TipRow[] = (run.value?.kinds ?? []).map(({ kind, count }) => ({ label: KIND_LABELS[kind](), value: count }));
    if (jobs.value.length > 0) {
        rows.push({ label: t(`chat.chatTurnAsides.kindJobs`), value: jobs.value.length });
    }
    if (thoughts.value > 0) {
        rows.push({ label: t(`chat.chatTurnAsides.kindThoughts`), value: thoughts.value });
    }
    if (failures.value > 0) {
        rows.push({ label: t(`chat.chatTurnAsides.failed`), value: failures.value, tone: `danger` });
    }
    return { title: t(`chat.chatTurnAsides.steps`, { count: steps.value }, steps.value), rows };
});
</script>

<template>
    <div class="chat-message chat-message-meta chat-stack flex flex-col">
        <div
            ref="spine"
            class="flex w-full min-w-0 flex-col gap-1"
            :class="folds ? [`chat-spine`, open ? `chat-spine-open` : `chat-spine-shut`] : undefined"
            :style="folds ? { '--wash-calls': Math.min(steps, 16) } : undefined"
        >
            <div v-if="folds" class="chat-spine-bar">
                <ChatSpineNode v-if="open" icon="chevron-up" :open="true" :label="foldLabel" :tip="tip" :failed="failures > 0" @toggle="toggle" />
            </div>
            <button
                v-if="folds && !open"
                type="button"
                class="chat-spine-wash"
                :class="{ 'chat-spine-wash-failed': failures > 0 }"
                :aria-expanded="false"
                :aria-label="label"
                v-tooltip.top="tip"
                @click="toggle"
            />
            <!-- Cheap rows stay searchable, and a browser match opens this same disclosure. No combined duration:
                 jobs may overlap, and an untracked job says nothing about whether it succeeded. -->
            <div class="chat-stack flex flex-col" :hidden.attr="folds && !open ? `until-found` : undefined" @beforematch="reveal">
                <slot :inspect="reveal" />
                <!-- Where the reader just asked to see the run: the one press that keeps every run open, in every chat. A
                     tail's own opened run carries it instead, being the last of what the band stood for. -->
                <button
                    v-if="folds && open && !jobsOnly && group.tail === undefined && !maker"
                    type="button"
                    class="touch-target self-start text-2xs text-subtle transition-colors hover:text-content"
                    @click="setShowToolCalls"
                >
                    {{ t(`chat.chatTurnAsides.alwaysShowSteps`) }}
                </button>
            </div>
        </div>
    </div>
</template>
