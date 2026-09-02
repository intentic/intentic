<!-- AN ACTION, set to be judged. What the agent says it will do (`summary`, the headline), the specifics a yes
     is being asked for (`details`, Markdown), and, folded, the brief it left for the turn that will do it
     (`instructions`).

     THE SUMMARY IS THE HEADLINE AND THE DETAILS ARE THE POST, deliberately the same column, measure and type as
     <PostBody>, because the reviewer's job is the same: read what will happen in the owner's name and decide.
     A booking and a tweet are judged by the same eye.

     THE INSTRUCTIONS ARE FOLDED, NOT HIDDEN. They are the agent talking to its later self ("open booking.com as
     travel, pick the double room…"), which the owner rarely needs and occasionally must see: an instruction
     that quietly reaches past what the summary said is exactly the thing this page exists to catch, so they
     are one click away rather than a file away. Drawn as code because that is what they are, a brief to be
     executed literally, and because the monospace box keeps them from reading as part of the proposal. -->
<script setup lang="ts">
import type { ActionApprovalSummary } from "@intentic/sandbox-contract";
import { ui, Code, Markdown } from "@intentic/extension-ui";
import { ref } from "vue";

const { action, tone = `full` } = defineProps<{
    action: ActionApprovalSummary;
    /** `full` where a decision is owed; `quiet` for the sections that are only being kept an eye on. */
    tone?: `full` | `quiet`;
}>();

const showInstructions = ref(false);
</script>

<template>
    <div :class="tone === `full` ? `max-w-read` : `max-w-read-lg`">
        <!-- Quiet sections show the summary alone: the decision there is already made, so one line is enough
             to tell one row from another. -->
        <template v-if="tone === `quiet`">
            <p class="truncate text-sm font-medium text-content">{{ action.summary }}</p>
        </template>

        <template v-else>
            <p class="wrap-break-word text-base font-semibold leading-snug text-content">{{ action.summary }}</p>
            <div v-if="action.details" class="mt-2">
                <Markdown :source="action.details" style="--prose-measure: 72ch" />
            </div>
            <button
                type="button"
                :class="ui.linkButton(`mt-2 gap-1 text-2xs text-muted hover:text-content`)"
                :aria-expanded="showInstructions"
                @click="showInstructions = !showInstructions"
            >
                {{ showInstructions ? `Hide what the agent will be told` : `What the agent will be told` }}
                <Icon :name="showInstructions ? `chevron-up` : `chevron-down`" />
            </button>
            <Code v-if="showInstructions" :code="action.instructions" class="mt-1" />
        </template>
    </div>
</template>
