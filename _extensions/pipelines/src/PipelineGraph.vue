<script setup lang="ts">
import { Icon, Popover, StatusBadge } from "@intentic/extension-ui";
import { ref } from "vue";
import { type PipelineStage, stageLabel } from "./pipelineDag";
import { formatDuration, STATUS_TONE } from "./statusVisual";

/* The mini pipeline graph that sits in a run row: one circle per stage, connected left→right, each coloured
 * by the worst status inside it. Clicking a circle opens that stage's job list. Stages arrive already
 * derived (pipelineDag.ts) so this and the expanded DagGraph can never disagree about the shape of a run. */

const { stages, recurring } = defineProps<{
    stages: readonly PipelineStage[];
    // Job name → consecutive runs it has been failing. A job in here is the same breakage as last time, not a
    // new one — the difference between "triage this" and "you already know".
    recurring: ReadonlyMap<string, number>;
}>();

// Popovers are addressed by stage index — a derived GitHub wave has no name to key on, and GitLab stage
// names are only unique by convention.
const popovers = ref<Record<number, InstanceType<typeof Popover> | null>>({});
const open = ref<number | undefined>();

const toggleStage = (index: number, event: Event): void => {
    if (open.value !== undefined && open.value !== index) {
        popovers.value[open.value]?.hide();
    }
    popovers.value[index]?.toggle(event);
    open.value = open.value === index ? undefined : index;
};

// Hover text: what the stage is called, how it ended, and — when it holds more than the one job its label
// already names — how many jobs are inside.
const stageTooltip = (stage: PipelineStage, index: number): string => {
    const detail = stage.jobs.length > 1 ? ` · ${stage.jobs.length} jobs` : ``;
    return `${stageLabel(stage, index)} — ${STATUS_TONE[stage.status].label}${detail}`;
};
</script>

<template>
    <div class="flex items-center gap-0" @click.stop>
        <template v-for="(stage, index) in stages" :key="index">
            <!-- Connector between consecutive stages. -->
            <div v-if="index > 0" class="h-px w-3 shrink-0 bg-line"></div>

            <button
                type="button"
                class="relative flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full border transition-transform hover:scale-110"
                :class="STATUS_TONE[stage.status].circle"
                v-tooltip.top="stageTooltip(stage, index)"
                @click="toggleStage(index, $event)"
            >
                <Icon
                    :name="STATUS_TONE[stage.status].icon"
                    class="text-2xs"
                    :class="STATUS_TONE[stage.status].spin ? `animate-spin` : ``"
                />
            </button>

            <Popover :ref="(el: any) => { popovers[index] = el; }">
                <div class="flex w-64 flex-col gap-2 p-1">
                    <div class="flex items-center gap-2">
                        <span class="min-w-0 flex-1 truncate text-sm font-semibold text-content">{{ stageLabel(stage, index) }}</span>
                        <StatusBadge :variant="STATUS_TONE[stage.status].variant" :label="STATUS_TONE[stage.status].label" size="xs" />
                    </div>
                    <div class="flex flex-col divide-y divide-line">
                        <div v-for="job in stage.jobs" :key="job.name" class="flex items-center gap-2 py-1.5">
                            <Icon
                                :name="STATUS_TONE[job.status].icon"
                                class="shrink-0 text-xs"
                                :class="[STATUS_TONE[job.status].text, STATUS_TONE[job.status].spin ? `animate-spin` : ``]"
                            />
                            <!-- The whole point of opening this popover is usually "so what did that job say?" -->
                            <a
                                v-if="job.webUrl"
                                :href="job.webUrl"
                                target="_blank"
                                rel="noopener"
                                class="min-w-0 flex-1 truncate text-xs hover:underline"
                                :class="job.status === `failed` ? `font-medium text-danger` : `text-content hover:text-link`"
                            >
                                {{ job.name }}
                            </a>
                            <span
                                v-else
                                class="min-w-0 flex-1 truncate text-xs"
                                :class="job.status === `failed` ? `font-medium text-danger` : `text-content`"
                            >
                                {{ job.name }}
                            </span>
                            <span
                                v-if="recurring.get(job.name)"
                                class="shrink-0 rounded bg-danger/10 px-1 text-2xs font-semibold text-danger"
                                v-tooltip.top="`Failing for ${recurring.get(job.name)} runs in a row`"
                                >×{{ recurring.get(job.name) }}</span
                            >
                            <span v-if="formatDuration(job.durationSeconds)" class="shrink-0 text-2xs text-subtle">
                                {{ formatDuration(job.durationSeconds) }}
                            </span>
                        </div>
                    </div>
                </div>
            </Popover>
        </template>
    </div>
</template>
