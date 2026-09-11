<script setup lang="ts">
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref, watch } from "vue";

// Single-line shell command rendered as syntax-highlighted code (Shiki), matching ChatCommandBlock's light/dark
// handling via `--shiki-dark`. Truncates rather than wrapping, so a long command can't push its container's layout.

const { command, wrap = false } = defineProps<{
    command: string;
    /**
     * Let a long command take a second line instead of ending in an ellipsis. For the one place where the command is
     * the decision rather than a detail of it — agreeing to run what a repository declares — since a command nobody
     * can finish reading is not something anybody can agree to.
     */
    wrap?: boolean;
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
    <code
        class="rule-command-code inline-block max-w-full font-mono text-content align-bottom"
        :class="wrap ? `whitespace-pre-wrap break-words` : `truncate`"
    >
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
