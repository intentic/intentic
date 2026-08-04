<script setup lang="ts">
import type { AgentSummary } from "@intentic/sandbox-contract";

/* "This conversation is one step of a workflow run" — provenance, in OriginMark's slot and OriginMark's
 * grammar, because it is the same kind of fact: an agent the user did not start directly, whose card without
 * this reads as one they forgot starting.
 *
 * IT IS TEXT, NOT A LINK, and that is a correction. It used to open the run page on click and explain itself
 * on hover, which made a provenance line the most clickable thing on a card whose click means "focus this
 * chat" — a mark you read in passing sat under the pointer as a navigation you did not ask for, and the
 * tooltip fired every time the cursor crossed it. The way into a run is the run's own row (WorkflowRunCard and
 * the rail's), which is a control rather than a caption; this only says where the conversation came from.
 *
 * Renders nothing for an ordinary conversation, so callers hand it the optional projection unconditionally.
 * `compact` drops the step title for the chat rail, where the width is not there and the run's name and
 * position are the part that groups. */

defineProps<{ workflow?: NonNullable<AgentSummary["workflow"]>; compact?: boolean }>();
</script>

<template>
    <span v-if="workflow !== undefined" class="flex min-w-0 items-center gap-1.5 text-2xs text-muted">
        <Icon name="sitemap" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">{{ workflow.name }}</span>
        <!-- "step 3/4" rather than a bare "3/4", to match the loop line's "Iteration 2/6" directly beneath it:
             two unlabelled fractions on adjacent rows of one card is a card the reader has to decode. -->
        <span class="shrink-0">· step {{ workflow.index }}/{{ workflow.total }}</span>
        <template v-if="compact !== true">
            <span>·</span>
            <span class="truncate">{{ workflow.step }}</span>
        </template>
    </span>
</template>
