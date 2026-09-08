<script setup lang="ts">
import { useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";

// A Read tool card's body: syntax-highlighted via the shared Shiki highlighter with a line-number gutter. `firstLine`
// restores the original numbering (Read may pass an offset). Falls back to plain, still-numbered monospace while the
// grammar loads or for an unsupported extension.

const { code, lang, firstLine } = defineProps<{ code: string; lang?: string; firstLine: number }>();

const { highlight } = useHighlighter();
// Shiki's dual-theme HTML for the code, or undefined until it lands or for an unsupported language.
const html = ref<string | undefined>(undefined);

// One gutter number per code line, aligning with either the highlighted or plain-text fallback.
const gutter = computed(() =>
    code
        .split(`\n`)
        .map((_, index) => firstLine + index)
        .join(`\n`),
);

// v-html trusts Shiki's escaped output; `seq` drops a stale highlight if props change before it resolves.
let seq = 0;
watch(
    () => [code, lang] as const,
    ([nextCode, nextLang]) => {
        const id = ++seq;
        if (nextLang === undefined || nextLang === ``) {
            html.value = undefined;
            return;
        }
        void highlight(nextCode, nextLang).then((out) => {
            if (id === seq) {
                html.value = out;
            }
        });
    },
    { immediate: true },
);
</script>

<template>
    <div class="chat-code scrollbar-thin ml-4">
        <div class="chat-code-gutter" aria-hidden="true">{{ gutter }}</div>
        <div class="flex-none">
            <div v-if="html" v-html="html"></div>
            <pre v-else class="shiki"><code>{{ code }}</code></pre>
        </div>
    </div>
</template>
