<script setup lang="ts">
import { type CodeToken, useHighlighter } from "@intentic/ui";
import { ref, watch } from "vue";

// Single-line shell command rendered as syntax-highlighted code (Shiki), dark in the dark scheme by code.css's one
// `--shiki-dark` rule. Truncates rather than wrapping, so a long command can't push its container's layout.

const { command, wrap = false } = defineProps<{
    command: string;
/** Let a long command take a second line instead of ending in an ellipsis. */
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
    <code class="inline-block max-w-full font-mono text-content align-bottom" :class="wrap ? `whitespace-pre-wrap break-words` : `truncate`">
        <template v-if="tokens !== undefined && tokens.length > 0">
            <span v-for="(token, index) in tokens" :key="index" :style="token.htmlStyle">{{ token.content }}</span>
        </template>
        <template v-else>{{ command }}</template>
    </code>
</template>
