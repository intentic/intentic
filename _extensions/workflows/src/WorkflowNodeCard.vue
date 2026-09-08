<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { stepSubtitle, toneFor, type WorkflowNode } from "./workflowDag";

// Interior of a workflow-step node, shared by the designer's canvas and the run view's graph so a step looks identical
// whether it's being designed or is mid-run. `node.run` being absent means the designer context; the tone table
// (DESIGN_TONE) reads that directly rather than the card carrying a mode flag.

const { node } = defineProps<{ node: WorkflowNode }>();
</script>

<template>
    <span class="flex h-full flex-col justify-center gap-0.5 py-1.5 pl-3 pr-2.5">
        <!-- Inset clears the corner radius to avoid a ragged corner; capped since the bar stops short of the edge. -->
        <span class="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full" :class="toneFor(node).bar"></span>
        <span class="flex items-center gap-1.5">
            <Icon :name="toneFor(node).icon" :spin="toneFor(node).spin" class="shrink-0 text-2xs" :class="toneFor(node).text" />
            <span class="min-w-0 flex-1 truncate text-xs font-medium leading-tight text-content">{{ node.step.title }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ node.index }}</span>
        </span>
        <!-- What the step produces and what gates it, so the graph can be audited, not just read. -->
        <span class="truncate pl-4 text-2xs leading-tight text-subtle">{{ stepSubtitle(node.step) }}</span>
        <span v-if="node.run !== undefined && node.run.state !== `pending`" class="truncate pl-4 text-2xs leading-tight" :class="toneFor(node).text">
            {{ toneFor(node).label
            }}<template v-if="node.run.iterations > 0"> · {{ node.run.iterations }} round{{ node.run.iterations === 1 ? `` : `s` }}</template>
        </span>
    </span>
</template>
