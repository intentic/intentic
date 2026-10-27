<script setup lang="ts">
import { useHighlighter } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import ChatFoldClamp from "./ChatFoldClamp.vue";

// Code a tool call showed: a Read's file, a shell command's file slice, a diff or JSON it printed. Highlighted via the
// shared Shiki highlighter, with a line-number gutter when the first line's number is known (`firstLine` restores the
// original numbering: Read may pass an offset, `sed -n 125,200p` starts at 125). Falls back to plain, still-numbered
// monospace while the grammar loads or for an unsupported language. Folded to its first lines (ChatFoldClamp). `bare`
// draws it on the surface it sits in (a command's inset) instead of on an inset of its own.

const {
    code,
    lang,
    firstLine,
    bare = false,
} = defineProps<{
    code: string;
    lang?: string | undefined;
    firstLine?: number | undefined;
    bare?: boolean;
}>();

const { highlightSliced } = useHighlighter();
// Shiki's dual-theme HTML for the code, or undefined until it lands or for an unsupported language.
const html = ref<string | undefined>(undefined);

const lineCount = computed(() => code.split(`\n`).length);

// One gutter number per code line, aligning with either the highlighted or plain-text fallback.
const gutter = computed(() =>
    firstLine === undefined
        ? undefined
        : code
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
        // Sliced and budgeted: a Read of thousands of lines colours its head without holding the transcript.
        void highlightSliced(nextCode, nextLang, { from: `start`, stale: () => id !== seq }).then((out) => {
            if (id === seq) {
                html.value = out;
            }
        });
    },
    { immediate: true },
);
</script>

<template>
    <ChatFoldClamp :lines="lineCount" :class="bare ? '' : 'chat-code-box ml-[var(--chat-hang)]'">
        <div class="chat-code">
            <div v-if="gutter" class="chat-code-gutter" aria-hidden="true">{{ gutter }}</div>
            <div class="flex-none">
                <div v-if="html" v-html="html"></div>
                <pre v-else class="shiki"><code>{{ code }}</code></pre>
            </div>
        </div>
    </ChatFoldClamp>
</template>
