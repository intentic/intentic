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
        <!-- Status stripe down the leading edge — the layer you scan before reading a word.

             IT STOPS SHORT OF BOTH CORNERS, and that inset is the whole reason the card's outline reads as one
             clean line. Run to full height, the bar ends where the card's corner curves, and a CLIP is the only
             thing that can end it there — so the corner gets drawn twice, once as the frame's border and once
             as this bar's clipped edge, each anti-aliased against the page with no knowledge of the other. Where
             both land half-covered the page shows between them, and the 2px outline thins to roughly one along
             the curve: measured off the rendered pixels, 1.3px at the 45° point against 2.0px on the straight
             run. That thinning is the ragged corner people see on a selected card.

             The inset clears the corner radius, so the bar lives entirely on the straight part of the edge and
             the two shapes never meet — with it, the corner's profile is pixel-identical to the same card with
             no bar at all. Rounded caps because a bar that no longer runs to the edge is a mark rather than an
             edge, and a mark with square ends reads as cut off. -->
        <span class="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full" :class="toneFor(node).bar"></span>
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
