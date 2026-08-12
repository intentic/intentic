<script setup lang="ts">
import { DagGraph, Icon } from "@intentic/ui";
import { workflowDag, WorkflowNodeCard } from "@intentic/ext-workflows";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import type { RunSession } from "../composables/chat/chatRun";
import { RUN_NODE_HEIGHT, RUN_NODE_WIDTH, runColumns } from "../composables/chat/runColumns";

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
const emit = defineEmits<{ open: [sessions: RunSession[]] }>();

const dag = computed(() => workflowDag(run.workflow, run));
const columns = computed(() => runColumns(run));

/* THE COLUMN UNDER THE POINTER, lit as one. A click here opens a whole band, and until it lit up there was
 * nothing on screen that said so: two nodes that are about to open together looked exactly like two nodes that
 * happen to be near each other. Hovering one lights all of them, which is the only honest preview of what the
 * press does — and it is drawn INSIDE the node slot because DagGraph owns the card's own chrome, so a caller
 * that wants to say something about a group has the interior to say it in.
 *
 * EVERY COLUMN LIGHTS, INCLUDING THE ONES THAT CANNOT BE OPENED, in two different tints. Lighting only the
 * openable ones was the wrong call: on a run that has just started, four of five bands are still `pending` and
 * the diagram answered a hover with nothing at all — which reads as a diagram with no hover effect rather than
 * as "that band has no session yet". So the grouping is always shown, and whether it can be OPENED is said by
 * the strength of the tint and by the cursor, before the click rather than after it. */
const hovered = ref<string | undefined>();
const openable = (stepId: string): boolean => (columns.value.get(stepId)?.sessions.length ?? 0) > 0;
const lit = (stepId: string): boolean => hovered.value !== undefined && columns.value.get(hovered.value)?.stepIds.includes(stepId) === true;

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
    if (column !== undefined && column.sessions.length > 0) {
        emit(`open`, [...column.sessions]);
    }
});

// Whether anything in this run can be opened at all — a run that has not started a single step has a graph
// worth reading and nothing behind it, and a diagram that ignores every click is worse than one that says why.
const anyOpenable = computed(() => [...columns.value.values()].some((column) => column.sessions.length > 0));
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <p class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-1.5 text-2xs text-subtle">
            <Icon name="sitemap" class="shrink-0 text-2xs" />
            <span v-if="anyOpenable">Pick a step — its whole column opens side by side.</span>
            <span v-else>No step in this run ran, so there is nothing to open.</span>
        </p>
        <div class="min-h-0 flex-1">
            <!-- `magnify` off: this is a popped-out window, and a five-node run stretched to fill one reads
                 as a diagram of five billboards. Small graphs sit at their natural size and the reader zooms
                 in by hand if they want to. -->
            <DagGraph
                v-model="selectedId"
                :nodes="dag.nodes"
                :edges="dag.edges"
                :node-width="RUN_NODE_WIDTH"
                :node-height="RUN_NODE_HEIGHT"
                :magnify="false"
            >
                <!-- The slot fills the card, so the wrapper is where a column-wide state can be drawn: a tint
                     across every node of the band under the pointer, and the pointer itself only where there
                     is a session to open. -->
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
