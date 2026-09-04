<script setup lang="ts">
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref, watch } from "vue";

/* A single-line command fragment styled as code with Shiki syntax highlighting.
 *
 * It uses `useHighlighter().tokenizeLine` to break single-line shell commands into
 * colored tokens, flipping light/dark themes via `--shiki-dark` CSS variable identically
 * to ChatCommandBlock and the design system's code styles.
 *
 * Keeps layout inline and handles trailing truncation gracefully so chips don't overflow
 * their container or push layout boundaries. */

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
/* Shiki tokens deliver light theme inline colors and a --shiki-dark property.
 * When data-mode is dark, flip to the dark color variant. */
[data-mode="dark"] .rule-command-code span {
    color: var(--shiki-dark) !important;
}
</style>
