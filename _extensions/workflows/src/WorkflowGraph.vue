<script setup lang="ts">
import { DagGraph, Icon } from "@intentic/extension-ui";
import type { Workflow, WorkflowRun } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { stepSubtitle, toneFor, type WorkflowNode, workflowDag } from "./workflowDag";

/* THE PICTURE, drawn once and used by both the designer and the run view.
 *
 * That sharing is the point. A designer whose preview lays out differently from the run it produces is worse
 * than no preview: you would trust it, and then the thing you get would not be the thing you drew. One
 * component, one derivation (workflowDag.ts), two callers — the only difference between them is whether a
 * `run` is passed, and the node cards pick that up on their own.
 *
 * WHY A READ-ONLY CANVAS AND NOT A NODE EDITOR. A workflow's content is prose — each step is a goal, an
 * instruction, an output shape — and a canvas is a bad place to write prose. Dragging edges is also slower
 * than picking from a list once there are more than about four nodes, and it is much slower to correct. So the
 * canvas does the one thing a canvas is genuinely better at, which is showing you the SHAPE of what you wrote,
 * and the list beside it does the writing. Nothing here is draggable and nothing is connectable; the graph
 * reads and it selects.
 */

const { workflow, run } = defineProps<{ workflow: Pick<Workflow, "steps">; run?: WorkflowRun }>();
const selected = defineModel<string | undefined>();

const dag = computed(() => workflowDag(workflow, run));

const NODE_HEIGHT = 62;
const NODE_WIDTH = 210;
// dagre's in-rank gap; see dagLayout.ts.
const ROW_PITCH = NODE_HEIGHT + 28;

/* Size the band to the widest RANK, not to the step count. A twelve-step chain is one node tall and needs no
 * more room than a two-step one; a fan-out of five needs all of it. Approximated by the largest number of
 * steps sharing a dependency, which is what a rank is in practice and is far cheaper than laying out twice.
 */
const bandHeight = computed(() => {
    const fanout = new Map<string, number>();
    for (const step of workflow.steps) {
        const key = [...step.needs].toSorted().join(`,`);
        fanout.set(key, (fanout.get(key) ?? 0) + 1);
    }
    const widest = Math.max(1, ...fanout.values());
    return Math.min(460, Math.max(170, widest * ROW_PITCH + 36));
});

const tone = (node: WorkflowNode) => toneFor(node);
</script>

<template>
    <div :style="{ height: `${bandHeight}px` }" class="rounded-lg border border-line bg-canvas">
        <DagGraph v-model="selected" :nodes="dag.nodes" :edges="dag.edges" :node-width="NODE_WIDTH" :node-height="NODE_HEIGHT">
            <template #node="{ node }">
                <!-- Status stripe down the leading edge — the layer you scan before reading a word of it. -->
                <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="tone(node.data).bar"></span>
                <span class="flex h-full flex-col justify-center gap-0.5 py-1.5 pl-3 pr-2.5">
                    <span class="flex items-center gap-1.5">
                        <Icon
                            :name="tone(node.data).icon"
                            class="shrink-0 text-2xs"
                            :class="[tone(node.data).text, tone(node.data).spin ? `animate-spin` : ``]"
                        />
                        <span class="min-w-0 flex-1 truncate text-xs font-medium leading-tight text-content">{{ node.data.step.title }}</span>
                        <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ node.data.index }}</span>
                    </span>
                    <!-- What it produces and what gates it. The one line that makes a graph of titles into a
                         graph you can audit — "a claim" next to "3 fields · a command" is the difference
                         between a step you have to trust and one you do not. -->
                    <span class="truncate pl-4 text-2xs leading-tight text-subtle">{{ stepSubtitle(node.data.step) }}</span>
                    <span
                        v-if="node.data.run !== undefined && node.data.run.state !== `pending`"
                        class="truncate pl-4 text-2xs leading-tight"
                        :class="tone(node.data).text"
                    >
                        {{ tone(node.data).label
                        }}<template v-if="node.data.run.iterations > 0">
                            · {{ node.data.run.iterations }} iteration{{ node.data.run.iterations === 1 ? `` : `s` }}
                        </template>
                    </span>
                </span>
            </template>
        </DagGraph>
    </div>
</template>
