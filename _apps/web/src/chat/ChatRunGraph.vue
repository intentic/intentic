<script setup lang="ts">
import { DagGraph, Icon } from "@intentic/ui";
import { workflowDag, WorkflowNodeCard } from "@intentic/ext-workflows";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { RUN_NODE_HEIGHT, RUN_NODE_WIDTH, runColumns } from "../composables/chat/chatRun";

/* THE RUN'S DIAGRAM, IN THE CHAT PANEL — the map you come back to in order to choose a different part of the
 * run, one press behind the sessions themselves.
 *
 * SAME PICTURE AS THE WORKFLOWS PAGE, from the same derivation and the same card (workflowDag,
 * WorkflowNodeCard, both imported from the extension that owns them). A run drawn one way here and another way
 * there would be two claims about what is running, and the reader has no way to tell which one is lying.
 *
 * CLICKING A NODE OPENS ITS WHOLE COLUMN, not just that node, and that is the interaction worth having rather
 * than a nicety. The interesting runs fan out — two models on one brief, three auditors on one codebase — and
 * what a person wants from that band of the graph is not one of them, it is both, side by side. Picking a
 * single node would make the reader open them one at a time and lose the comparison the workflow was designed
 * to produce. Any node in the column is the handle for the column, so there is nothing extra to learn.
 */

const { run } = defineProps<{ run: WorkflowRun }>();
const emit = defineEmits<{ open: [conversationIds: string[]] }>();

const dag = computed(() => workflowDag(run.workflow, run));
const columns = computed(() => runColumns(run));

// DagGraph's selection is a v-model it toggles itself; this component treats a selection as a PRESS and hands
// the column up, so the id is cleared straight after — a node left ringed would suggest the graph is holding a
// state that outlives the click, and it does not.
const selectedId = ref<string | undefined>();
watch(selectedId, (stepId) => {
    if (stepId === undefined) {
        return;
    }
    const column = columns.value.get(stepId);
    selectedId.value = undefined;
    if (column !== undefined && column.conversationIds.length > 0) {
        emit(`open`, [...column.conversationIds]);
    }
});

// Whether anything in this run can be opened at all. A run whose every step is still `pending` — or one old
// enough that its agents have been swept off the roster — has a graph worth reading and no sessions behind it,
// and a diagram that silently ignores clicks is worse than one that says why.
const openable = computed(() => [...columns.value.values()].some((column) => column.conversationIds.length > 0));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <p class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-2xs text-subtle">
            <Icon name="sitemap" class="shrink-0 text-2xs" />
            <span v-if="openable">Pick a step — its whole column opens side by side.</span>
            <span v-else>No step in this run has a session yet.</span>
        </p>
        <div class="min-h-0 flex-1">
            <DagGraph v-model="selectedId" :nodes="dag.nodes" :edges="dag.edges" :node-width="RUN_NODE_WIDTH" :node-height="RUN_NODE_HEIGHT">
                <template #node="{ node }"><WorkflowNodeCard :node="node.data" /></template>
            </DagGraph>
        </div>
    </div>
</template>
