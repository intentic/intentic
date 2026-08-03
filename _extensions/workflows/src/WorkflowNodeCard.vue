<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { stepSubtitle, toneFor, type WorkflowNode } from "./workflowDag";

/* ONE STEP, AS A CARD — the interior of a node in both the designer's canvas and the run view's graph.
 *
 * The two frames differ (one is editable, one is not) and the CARD must not: a step you just drew and the
 * same step running an hour later are the same thing, and drawing them differently would make the run read as
 * a different workflow from the one that was designed. So the card lives here and the frames pass it through
 * their `#node` slot — one card, two frames, the same rule the chat rail follows against the fleet board.
 *
 * `node.run` being absent is what says "this is the designer", and the tone table answers that on its own
 * (DESIGN_TONE) rather than the card carrying a mode flag.
 */

const { node } = defineProps<{ node: WorkflowNode }>();
</script>

<template>
    <span class="flex h-full flex-col justify-center gap-0.5 py-1.5 pl-3 pr-2.5">
        <!-- Status stripe down the leading edge — the layer you scan before reading a word. -->
        <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5 rounded-l-md" :class="toneFor(node).bar"></span>
        <span class="flex items-center gap-1.5">
            <Icon :name="toneFor(node).icon" class="shrink-0 text-2xs" :class="[toneFor(node).text, toneFor(node).spin ? `animate-spin` : ``]" />
            <span class="min-w-0 flex-1 truncate text-xs font-medium leading-tight text-content">{{ node.step.title }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle">{{ node.index }}</span>
        </span>
        <!-- What it produces and what gates it. The line that turns a graph of titles into a graph you can
             audit — "a claim" beside "3 fields · a command" is the difference between a step you have to
             trust and one you do not. -->
        <span class="truncate pl-4 text-2xs leading-tight text-subtle">{{ stepSubtitle(node.step) }}</span>
        <span v-if="node.run !== undefined && node.run.state !== `pending`" class="truncate pl-4 text-2xs leading-tight" :class="toneFor(node).text">
            {{ toneFor(node).label
            }}<template v-if="node.run.iterations > 0"> · {{ node.run.iterations }} round{{ node.run.iterations === 1 ? `` : `s` }}</template>
        </span>
    </span>
</template>
