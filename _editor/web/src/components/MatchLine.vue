<script setup lang="ts">
// Renders the matched line from a filtered row, with the term marked and the speaker labeled. Only the line;
// wrapper, icon and clamp are the caller's.
import type { MatchSnippet } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { markSegments } from "../features/agents/review/markSegments";

const props = defineProps<{
    snippet: MatchSnippet;
    // Filter term, already case-folded; absent means the line renders unmarked.
    needle?: string;
    // Whether matching is case-sensitive; marks obey it so a differently-cased match is never lit as a hit.
    matchCase?: boolean;
}>();

const runs = computed(() => markSegments(props.snippet.text, props.needle ?? ``, props.matchCase === true));
</script>

<template>
    <span class="italic">
        <span class="pr-1 font-medium not-italic text-subtle">{{ snippet.speaker === `user` ? `You:` : `Agent:` }}</span>
        <span v-for="(run, at) in runs" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 not-italic text-content' : ''">{{ run.text }}</span>
    </span>
</template>
