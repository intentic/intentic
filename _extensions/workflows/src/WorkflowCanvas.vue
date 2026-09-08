<script setup lang="ts">
import { DagEditor } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { workflowDag } from "./workflowDag";

// Editable canvas for the designer; the only place in the extension that mutates the graph's shape via gestures. A thin
// shell over the kit's `DagEditor`, sharing `workflowDag` and `WorkflowNodeCard` with the run view. Mutations
// themselves live in `workflowEdit.ts`; this component only reports gestures.

const { workflow } = defineProps<{ workflow: Pick<Workflow, "steps"> }>();
const selectedId = defineModel<string | undefined>();
const emit = defineEmits<{
    connect: [from: string, to: string];
    selectEdge: [from: string, to: string];
    add: [from: string];
}>();

const dag = computed(() => workflowDag(workflow));

// Wider and shorter than the run view's card; the canvas has the whole page to give a step's title room.
const NODE_WIDTH = 216;
const NODE_HEIGHT = 56;
</script>

<template>
    <DagEditor
        v-model="selectedId"
        :nodes="dag.nodes"
        :edges="dag.edges"
        :node-width="NODE_WIDTH"
        :node-height="NODE_HEIGHT"
        add-label="Add a step after this one"
        @connect="(from, to) => emit(`connect`, from, to)"
        @select-edge="(from, to) => emit(`selectEdge`, from, to)"
        @add="(from) => emit(`add`, from)"
    >
        <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
    </DagEditor>
</template>
