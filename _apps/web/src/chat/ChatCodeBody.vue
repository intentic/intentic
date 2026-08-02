<script setup lang="ts">
import { useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";

/* A Read tool card's body: the file's contents syntax-highlighted by the shared Shiki highlighter (the same
 * grammars/themes the /workspace editor uses) with a line-number gutter — so code in chat reads like the code
 * viewer, not a flat dump. The SDK's own line-number prefixes were stripped upstream (numberedFileBody in
 * toolPresentation); `firstLine` restores them here as a real gutter (Read honors an offset, so the first line
 * isn't always 1). Falls back to plain — but still numbered — monospace while the grammar loads and permanently
 * for a file whose extension we ship no grammar for, so the contents are always readable. */

const { code, lang, firstLine } = defineProps<{ code: string; lang?: string; firstLine: number }>();

const { highlight } = useHighlighter();
// Shiki's dual-theme HTML for the code, or undefined until it lands / for a language we don't ship.
const html = ref<string | undefined>(undefined);

// One gutter number per code line. Shiki emits one visual line per `\n`-split segment and the plain <pre>
// fallback shows the same, so this count aligns with either body. Right-aligned + tabular in CSS.
const gutter = computed(() =>
    code
        .split(`\n`)
        .map((_, index) => firstLine + index)
        .join(`\n`),
);

// v-html trusts Shiki's own output — it HTML-escapes the code text, so the only markup is its <span> color
// tokens (see the design system's <Code>). A seq guard drops a stale highlight if the props change first.
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
        <div class="chat-code-view">
            <div v-if="html" v-html="html"></div>
            <pre v-else class="shiki"><code>{{ code }}</code></pre>
        </div>
    </div>
</template>
