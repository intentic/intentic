<script setup lang="ts">
import type { PipelineJob } from "@intentic/sandbox-contract";
import { DagGraph, Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { pipelineDag, type PipelineStage } from "./pipelineDag";
import { formatDuration, STATUS_TONE } from "./statusVisual";

/* The run's job graph, drawn by the same dagre + Vue Flow renderer as the dependency graph — one job per
 * card, laid out left→right in execution order with the stage fan-out between layers (see pipelineDag.ts for
 * where the layering comes from). Pan, wheel-zoom and fit-view come free with DagGraph. */

const { stages } = defineProps<{ stages: readonly PipelineStage[] }>();

// Selecting a node is local highlight only — nothing outside the graph reacts to it yet.
const selected = ref<string | undefined>();

const dag = computed(() => pipelineDag(stages));

const NODE_HEIGHT = 52;
// dagre's in-rank gap (nodesep) is 28 — see dagLayout.ts.
const ROW_PITCH = NODE_HEIGHT + 28;

// Size the band to the widest layer so a two-job pipeline doesn't sit in a half-empty box and a fan-out of
// twenty is still pannable rather than crushed.
const bandHeight = computed(() => {
    const widest = stages.reduce((most, stage) => Math.max(most, stage.jobs.length), 1);
    return Math.min(420, Math.max(150, widest * ROW_PITCH + 32));
});

const toneOf = (job: PipelineJob) => STATUS_TONE[job.status];
</script>

<template>
    <div :style="{ height: `${bandHeight}px` }" class="rounded-lg border border-line bg-canvas">
        <DagGraph v-model="selected" :nodes="dag.nodes" :edges="dag.edges" :node-width="200" :node-height="NODE_HEIGHT">
            <template #node="{ node }">
                <!-- Status stripe down the card's leading edge — the scannable layer above the text. -->
                <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="toneOf(node.data).bar"></span>
                <span class="flex h-full items-center gap-2 pl-3 pr-2.5" :class="toneOf(node.data).tint">
                    <Icon
                        :name="toneOf(node.data).icon"
                        class="shrink-0 text-sm"
                        :class="[toneOf(node.data).text, toneOf(node.data).spin ? `animate-spin` : ``]"
                    />
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span
                            class="truncate text-xs font-medium leading-tight"
                            :class="node.data.status === `failed` ? `text-danger` : `text-content`"
                        >
                            {{ node.data.name }}
                        </span>
                        <span class="truncate text-2xs leading-tight text-subtle">
                            {{ [node.data.stage, formatDuration(node.data.durationSeconds)].filter(Boolean).join(` · `) || `—` }}
                        </span>
                    </span>
                </span>
            </template>
        </DagGraph>
    </div>
</template>
