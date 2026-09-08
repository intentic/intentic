<script setup lang="ts">
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref, watch } from "vue";

// Single-line shell command rendered as syntax-highlighted code (Shiki), matching ChatCommandBlock's light/dark
// handling via `--shiki-dark`. Truncates rather than wrapping, so a long command can't push its container's layout.

const { command } = defineProps<{
    command: string;
}>();

const { tokenizeLine } = useHighlighter();
const tokens = ref<readonly CodeToken[] | undefined>(undefined);

let seq = 0;
watch(
    () => command,
    (nextCommand) => {
        const id = ++seq;
        void tokenizeLine(nextCommand, `bash`)
            .catch(() => undefined)
            .then((result) => {
                if (id === seq) {
                    tokens.value = result;
                }
            });
    },
    { immediate: true },
);
</script>

<template>
    <code class="rule-command-code inline-block max-w-full truncate font-mono text-content align-bottom">
        <template v-if="tokens !== undefined && tokens.length > 0">
            <span v-for="(token, index) in tokens" :key="index" :style="token.htmlStyle">{{ token.content }}</span>
        </template>
        <template v-else>{{ command }}</template>
    </code>
</template>

<style scoped>
/* Shiki inlines the light color and a `--shiki-dark` var; dark mode swaps to the latter. */
[data-mode="dark"] .rule-command-code span {
    color: var(--shiki-dark) !important;
}
</style>
