<script setup lang="ts">
import { Card, DagGraph } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { workflowDag, workflowLayers } from "./workflowDag";

// One card for both a saved workflow and a template (dashed = not owned yet). Draws the actual graph via
// `workflowDag`/`<DagGraph>`, the same derivation the designer and run view use, not a decorative diagram.
// `description` is a prop, not read off the workflow, since a template's pitch differs from a saved design's.

const { workflow, description, dashed = false } = defineProps<{ workflow: Workflow; description?: string; dashed?: boolean }>();
const emit = defineEmits<{ open: [] }>();

const dag = computed(() => workflowDag(workflow));
const layers = computed(() => workflowLayers(workflow.steps));
const widest = computed(() => Math.max(...layers.value.map((layer) => layer.length)));

// Matches the designer canvas's geometry, so a step is the same box in both places.
const NODE_WIDTH = 216;
const NODE_HEIGHT = 56;
// dagre's `nodesep` (dagLayout.ts): the gap between two boxes sharing a rank.
const NODE_GAP = 28;

// Height comes from the widest parallel layer, not chain length; clamped to 6-20rem plus fit padding.
const frameRem = computed(() => Math.min(20, Math.max(6, (widest.value * NODE_HEIGHT + (widest.value - 1) * NODE_GAP) / 16 + 2)));

// Step count, plus `maxParallel` only when there's an actual fan-out to note.
const shape = computed(() => {
    const steps = `${workflow.steps.length} step${workflow.steps.length === 1 ? `` : `s`}`;
    return widest.value > 1 ? `${steps} · up to ${workflow.maxParallel} at once` : steps;
});
</script>

<template>
    <!-- `group/card` is what hover-only actions (edit, delete) key off; Run always shows. -->
    <Card :dashed="dashed" class="group/card flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <button type="button" class="cursor-pointer truncate text-sm font-semibold text-content hover:underline" @click="emit(`open`)">
                        {{ workflow.name }}
                    </button>
                    <slot name="badges" />
                </div>
                <!-- Clamped to two lines, not truncated to one: the only place a workflow says what it's for. -->
                <p v-if="description" class="mt-1 line-clamp-2 text-xs leading-snug text-muted">{{ description }}</p>
            </div>
            <div class="flex shrink-0 items-center gap-1"><slot name="actions" /></div>
        </div>

        <!-- Documentation-figure frame: a wash, not a stroke, since the picture inside is already boxes. -->
        <div class="relative w-full overflow-hidden rounded-lg bg-content/4" :style="{ height: `${frameRem}rem` }">
            <!-- Inert: the graph's own zoom/pan would otherwise hijack scrolling past it on a page of cards. -->
            <div class="pointer-events-none h-full w-full">
                <DagGraph :nodes="dag.nodes" :edges="dag.edges" :node-width="NODE_WIDTH" :node-height="NODE_HEIGHT" :magnify="false">
                    <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
                </DagGraph>
            </div>
            <!-- Overlay button, not a wrapper: the nodes underneath are themselves buttons. -->
            <button
                type="button"
                class="absolute inset-0 cursor-pointer rounded-lg transition-shadow hover:ring-1 hover:ring-line-strong focus-visible:ring-1 focus-visible:ring-link focus-visible:outline-none"
                :aria-label="`Open ${workflow.name} in the designer`"
                @click="emit(`open`)"
            ></button>
        </div>

        <!-- Anchored at both ends: what the design is on the left, how it last ran on the right. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
            <span>{{ shape }}</span>
            <div v-if="$slots[`meta`]" class="ml-auto flex items-center gap-3"><slot name="meta" /></div>
        </div>
    </Card>
</template>
