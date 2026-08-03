<script setup lang="ts">
import type { AgentSummary } from "@intentic/sandbox-contract";
import { useRouter } from "vue-router";

/* "This conversation is one step of a workflow run" — provenance, in OriginMark's slot and OriginMark's
 * grammar, because it is the same kind of fact: an agent the user did not start directly, whose card without
 * this reads as one they forgot starting.
 *
 * IT IS THE ONLY THING THAT MAKES A RUN LOOK LIKE A RUN. A workflow of four `fresh` steps IS four conversations
 * — that separation is the feature, since a session that spent three phases arguing for an approach is the
 * worst available judge of it — but it means the board receives four unrelated cards that happen to have
 * started minutes apart. Repeating the run's NAME down each of them is what turns a scatter into a block, and
 * it costs one line rather than a second kind of card the board would have to learn to drag, filter and archive.
 *
 * IT IS A LINK, and that is the other half. The picture of a run — which step is on which node, what is waiting
 * on what, what the failed one said — is the run page, and this is the only route to it from the board. Steps
 * chained with `continue` share one conversation, so several nodes can lead back to the same card; the graph is
 * where that stops being confusing.
 *
 * Renders nothing for an ordinary conversation, so callers hand it the optional projection unconditionally.
 * `compact` drops the step title for the chat rail, where the width is not there and the run's name and
 * position are the part that groups. */

const props = defineProps<{ workflow?: NonNullable<AgentSummary["workflow"]>; compact?: boolean }>();

const router = useRouter();

const open = (): void => {
    if (props.workflow !== undefined) {
        void router.push({ name: `extension`, params: { ext: `workflows` }, query: { run: props.workflow.runId } });
    }
};
</script>

<template>
    <button
        v-if="workflow !== undefined"
        type="button"
        class="flex min-w-0 cursor-pointer items-center gap-1.5 text-2xs text-muted transition-colors hover:text-content"
        v-tooltip.top="`Step ${workflow.index} of ${workflow.total} of “${workflow.name}” — open the run`"
        @click.stop="open"
    >
        <Icon name="sitemap" class="shrink-0 text-2xs" />
        <span class="shrink-0 font-medium">{{ workflow.name }}</span>
        <!-- "step 3/4" rather than a bare "3/4", to match the loop line's "Iteration 2/6" directly beneath it:
             two unlabelled fractions on adjacent rows of one card is a card the reader has to decode. -->
        <span class="shrink-0">· step {{ workflow.index }}/{{ workflow.total }}</span>
        <template v-if="compact !== true">
            <span>·</span>
            <span class="truncate">{{ workflow.step }}</span>
        </template>
    </button>
</template>
