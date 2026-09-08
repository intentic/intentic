<script setup lang="ts">
import { DagGraph, Icon } from "@intentic/ui";
import { workflowDag, WorkflowNodeCard } from "@intentic/ext-workflows";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import type { RunSession } from "../run/chatRun";
import { RUN_NODE_HEIGHT, RUN_NODE_WIDTH, runColumns } from "../run/runColumns";

// The run's diagram in the chat panel, drawn from the same derivation and card as the workflows page (workflowDag,
// WorkflowNodeCard), so the two never disagree about what's running. Clicking a node opens its whole column, not just
// that node: a fanned-out run wants its parallel branches compared side by side.

const { run } = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ open: [sessions: RunSession[]] }>();

const dag = computed(() => workflowDag(run.workflow, run));
const columns = computed(() => runColumns(run));

// Hovering lights the whole column, openable or not, in two tints, so every band gives feedback.
const hovered = ref<string | undefined>();
const openable = (stepId: string): boolean => (columns.value.get(stepId)?.sessions.length ?? 0) > 0;
const lit = (stepId: string): boolean => hovered.value !== undefined && columns.value.get(hovered.value)?.stepIds.includes(stepId) === true;

// Selection is treated as a press: the id clears right after emitting, so no node stays ringed.
const selectedId = ref<string | undefined>();
watch(selectedId, (stepId) => {
    if (stepId === undefined) {
        return;
    }
    const column = columns.value.get(stepId);
    selectedId.value = undefined;
    if (column !== undefined && column.sessions.length > 0) {
        emit(`open`, [...column.sessions]);
    }
});

// Whether anything in the run can be opened yet; otherwise the diagram would ignore every click silently.
const anyOpenable = computed(() => [...columns.value.values()].some((column) => column.sessions.length > 0));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <p class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-2xs text-subtle">
            <Icon name="sitemap" class="shrink-0 text-2xs" />
            <span v-if="anyOpenable">Pick a step: its whole column opens side by side.</span>
            <span v-else>No step in this run ran, so there is nothing to open.</span>
        </p>
        <div class="min-h-0 flex-1">
            <!-- magnify off: a small run stays natural-sized here rather than stretched to fill this floating window. -->
            <DagGraph
                v-model="selectedId"
                :nodes="dag.nodes"
                :edges="dag.edges"
                :node-width="RUN_NODE_WIDTH"
                :node-height="RUN_NODE_HEIGHT"
                :magnify="false"
            >
                <!-- Wrapper draws the column-wide hover tint and cursor; DagGraph owns the card's own chrome. -->
                <template #node="{ node }">
                    <span
                        class="block h-full w-full transition-colors"
                        :class="[
                            openable(node.data.step.id) ? `cursor-pointer` : `cursor-default`,
                            lit(node.data.step.id) ? (openable(node.data.step.id) ? `bg-primary-600/15` : `bg-content/5`) : ``,
                        ]"
                        @mouseenter="hovered = node.data.step.id"
                        @mouseleave="hovered = undefined"
                    >
                        <WorkflowNodeCard :node="node.data" />
                    </span>
                </template>
            </DagGraph>
        </div>
    </div>
</template>
