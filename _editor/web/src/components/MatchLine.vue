<script setup lang="ts">
/* WHY a filtered row survived — the line the query hit, with the term marked and the side of the conversation
 * that said it named in front of it.
 *
 * The speaker label is not decoration. The filter matches the agent's own replies as well as the user's
 * prompts, and prose lifted out of a chat reads as something the reader wrote until the row says otherwise:
 * "landAgent lives in laneDrop.ts" under a card they never opened is a sentence they would go looking for in
 * their own memory. One word in front of it settles that before it can happen.
 *
 * Renders the LINE only — the wrapper, its icon and its clamp belong to whatever is showing it, because a card
 * in a lane and a row in a history list frame the same evidence differently.
 */
import type { MatchSnippet } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { markSegments } from "../composables/agents/markSegments";

const props = defineProps<{
    snippet: MatchSnippet;
    // The filter's term, lowercased. Absent while nothing is typed, which renders the line unmarked.
    needle?: string;
}>();

const runs = computed(() => markSegments(props.snippet.text, props.needle ?? ``));
</script>

<template>
    <span class="italic">
        <span class="pr-1 font-medium not-italic text-subtle">{{ snippet.speaker === `user` ? `You:` : `Agent:` }}</span>
        <span v-for="(run, at) in runs" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''">{{ run.text }}</span>
    </span>
</template>
