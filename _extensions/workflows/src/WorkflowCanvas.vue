<script setup lang="ts">
import { DagEditor } from "@intentic/extension-ui";
import type { Workflow } from "@intentic/sandbox-contract";
import { computed } from "vue";
import WorkflowNodeCard from "./WorkflowNodeCard.vue";
import { workflowDag } from "./workflowDag";

/* THE EDITABLE CANVAS — the designer's whole working surface, and deliberately the only place in the
 * extension that knows the graph can be changed at all.
 *
 * It is a thin shell over the kit's DagEditor: the derivation is `workflowDag` (shared with the run view, so
 * the two can never draw one workflow two ways) and the card is `WorkflowNodeCard` (likewise). What is left
 * here is the sizing and the vocabulary — turning "a node was connected" into "a step now waits for another".
 *
 * The mutations themselves live in `workflowEdit.ts`, not here. This component reports gestures; it does not
 * decide what they mean to a workflow.
 */

const { workflow } = defineProps<{ workflow: Pick<Workflow, "steps"> }>();
const selectedId = defineModel<string | undefined>();
const emit = defineEmits<{
    connect: [from: string, to: string];
    selectEdge: [from: string, to: string];
    add: [from: string];
}>();

const dag = computed(() => workflowDag(workflow));

// Wider and shorter than the run view's card: the designer's canvas has the whole page, and a step's title is
// the thing being read here, so it gets the width rather than the height.
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
