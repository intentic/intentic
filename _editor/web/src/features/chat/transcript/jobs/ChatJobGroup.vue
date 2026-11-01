<script setup lang="ts">
import type { TooltipValue } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { TranscriptBackgroundJob } from "@intentic/sandbox-contract/events/transcript";
import type { AgentJob } from "@intentic/sandbox-contract/schemas/agents";
import { computed, inject, ref, useTemplateRef } from "vue";
import { useToolCalls } from "../../../../models/conversations/tools/useToolCalls";
import ChatSpineNode from "../asides/ChatSpineNode.vue";
import { jobPhase } from "../jobPhase";
import { TRANSCRIPT_HOLD } from "../useStickToBottom";

const props = defineProps<{
    jobs: readonly TranscriptBackgroundJob[];
    live?: readonly AgentJob[];
}>();
const t = useT();
const { showToolCalls } = useToolCalls();
const phases = computed(() => props.jobs.map((job) => jobPhase(props.live?.find((entry) => entry.id === job.id))));
const folds = computed(() => !showToolCalls.value && phases.value.every((phase) => phase.kind !== `running`));
const failures = computed(() => phases.value.filter((phase) => phase.kind === `failed`).length);
const shown = ref(false);
const spine = useTemplateRef<HTMLElement>(`spine`);
const hold = inject(TRANSCRIPT_HOLD, (_element, change) => change());
const toggle = (): void => hold(spine.value, () => (shown.value = !shown.value));
// A command the reader opened while its job ran stays on screen when the last job ends. The rows stay mounted too.
const inspect = (): void => { shown.value = true; };
const failureLine = computed(() => failures.value > 0 ? t(`chat.chatJobRow.failures`, { count: failures.value }) : undefined);
const label = computed(() => [t(`chat.chatJobRow.showJobs`, { count: props.jobs.length }), failureLine.value].filter(Boolean).join(` · `));
const tip = computed((): TooltipValue => ({ title: t(`chat.chatJobRow.jobs`, { count: props.jobs.length }), note: failureLine.value }));
</script>

<template>
    <div class="chat-message chat-message-meta chat-stack flex flex-col">
        <div
            ref="spine"
            class="flex w-full min-w-0 flex-col gap-1"
            :class="folds ? [`chat-spine`, shown ? `chat-spine-open` : `chat-spine-shut`] : undefined"
            :style="folds ? { '--wash-calls': Math.min(jobs.length, 16) } : undefined"
        >
            <div v-if="folds" class="chat-spine-bar">
                <ChatSpineNode
                    v-if="shown"
                    icon="chevron-up"
                    :open="true"
                    :label="t(`chat.chatJobRow.hideJobs`, { count: jobs.length })"
                    :tip="tip"
                    :failed="failures > 0"
                    @toggle="toggle"
                />
            </div>
            <button
                v-if="folds && !shown"
                type="button"
                class="chat-spine-wash"
                :class="{ 'chat-spine-wash-failed': failures > 0 }"
                :aria-expanded="false"
                :aria-label="label"
                v-tooltip.top="tip"
                @click="toggle"
            />
            <!-- Cheap text stays searchable, and a browser match opens this same disclosure. No combined duration:
                 jobs may overlap, and an untracked job says nothing about whether it succeeded. -->
            <div
                class="chat-stack flex flex-col"
                :hidden.attr="folds && !shown ? `until-found` : undefined"
                @beforematch="inspect"
            >
                <slot :jobs="jobs" :inspect="inspect" />
            </div>
        </div>
    </div>
</template>
