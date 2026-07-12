<!-- Highlighted code block. A thin design-system wrapper over useHighlighter: renders the dual-theme Shiki
     HTML (recolored for dark mode by [data-mode] in code.css) with a header label and a copy button. Falls
     back to a plain <pre> while highlighting is in flight, and permanently for unsupported languages — so
     the text is always readable. -->
<script setup lang="ts">
import { ref, watch } from "vue";
import { useHighlighter } from "../vue/useHighlighter.js";
import CopyButton from "./CopyButton.vue";

const {
    code,
    lang = ``,
    label = ``,
    copyable = true,
    wrap = false,
} = defineProps<{
    code: string;
    // Shiki language id (e.g. `bash`, `powershell`); empty renders as plain text.
    lang?: string;
    label?: string;
    copyable?: boolean;
    // Long single-line commands read better wrapped; multi-line files scroll horizontally.
    wrap?: boolean;
}>();

const { highlight } = useHighlighter();
const html = ref<string | undefined>(undefined);

// v-html trusts Shiki's own output — it HTML-escapes the code text, so the only markup is its
// <span style=…> color tokens, which is why rendering it raw is safe here.
let seq = 0;
watch(
    () => [code, lang] as const,
    ([nextCode, nextLang]) => {
        const id = ++seq;
        if (!nextLang) {
            html.value = undefined;
            return;
        }
        void highlight(nextCode, nextLang).then((out) => {
            // Ignore a stale result if inputs changed while highlighting was in flight.
            if (id === seq) {
                html.value = out;
            }
        });
    },
    { immediate: true },
);
</script>

<template>
    <div class="ui-code" :class="{ 'ui-code-wrap': wrap }">
        <div class="flex flex-col gap-1.5">
            <div v-if="label || copyable" class="flex items-center justify-between">
                <span class="text-2xs font-medium text-muted">{{ label }}</span>
                <CopyButton v-if="copyable" :text="code" label="Copy" />
            </div>
            <div v-if="html" v-html="html"></div>
            <pre
                v-else
                class="scrollbar-thin overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content"
                :class="{ 'whitespace-pre-wrap': wrap, 'break-words': wrap }"
                >{{ code }}</pre>
        </div>
    </div>
</template>
