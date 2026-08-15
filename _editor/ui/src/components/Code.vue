<!-- Highlighted code block. A thin design-system wrapper over useHighlighter: renders the dual-theme Shiki
     HTML (recolored for dark mode by [data-mode] in code.css) with a header label and a copy button. Falls
     back to a plain <pre> while highlighting is in flight, and permanently for unsupported languages — so
     the text is always readable. -->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { ui } from "../lib/ui.js";
import { useHighlighter } from "../composables/useHighlighter.js";
import type { ShikiLang } from "../lib/shikiLangs.js";
import CopyButton from "./CopyButton.vue";

const {
    code,
    lang,
    label = ``,
    copyable = true,
    wrap = false,
    clampLines,
} = defineProps<{
    code: string;
    // Shiki language id (e.g. `bash`, `powershell`); omit to render as plain text. Typed against the grammars
    // we actually ship, so a name that would silently render grey (`dockerfile` for `docker`) fails to compile.
    lang?: ShikiLang;
    label?: string;
    copyable?: boolean;
    // Long single-line commands read better wrapped; multi-line files scroll horizontally.
    wrap?: boolean;
    /* How many lines to show before cutting the block off with a fade and a "Show all" toggle. For the
     * surface where the code is something to COPY rather than to read (a phone-width install command wraps
     * to nine ragged lines of env vars, burying the step after it) — the copy button works clamped, so the
     * full text is one tap away for whoever actually wants to read it. Omit for no clamp. */
    clampLines?: number;
}>();

// Passed straight through from the built-in copy button, for a caller whose flow turns on the copy having
// happened (setup's install command, which is run somewhere this browser cannot see).
const emit = defineEmits<{ copied: [] }>();

const { highlight } = useHighlighter();
const html = ref<string | undefined>(undefined);

/* The clamp's HEIGHT is code.css's job (`.ui-code-clamp`, which owns the line-height it counts in); what is
 * left here is how many lines, whether the reader has asked for the rest — and whether there is a rest at all.
 * That last one has to be measured: whether a command overflows four lines is a question of wrapping, which
 * moves with the width the block is rendered at, so a toggle offering to reveal nothing is otherwise exactly
 * what a short command on a wide screen gets. Observed rather than computed, and re-observed on resize. */
const expanded = ref(false);
const clamped = computed(() => clampLines !== undefined && !expanded.value);
const block = ref<HTMLElement>();
const overflowing = ref(false);
// Kept visible once expanded — the measurement says "no more to show" the moment the clamp lifts, and a
// toggle that vanishes on use leaves the reader with no way back.
const toggleable = computed(() => clampLines !== undefined && (expanded.value || overflowing.value));

const measure = (): void => {
    const pre = block.value?.querySelector(`pre`);
    overflowing.value = pre !== undefined && pre !== null && pre.scrollHeight > pre.clientHeight + 1;
};
// Only a clamped block is ever measured: a chat transcript renders dozens of these, and an observer each for a
// question none of them asks is a cost with no reader.
let observer: ResizeObserver | undefined;
watch(block, (el, _old, onCleanup) => {
    observer?.disconnect();
    if (clampLines === undefined || !el) {
        return;
    }
    observer ??= new ResizeObserver(() => measure());
    observer.observe(el);
    onCleanup(() => observer?.disconnect());
});
// The highlighted markup replaces the fallback <pre>, so the block that was measured is not the one on screen.
watch(html, () => void nextTick(measure));
onUnmounted(() => observer?.disconnect());

// v-html trusts Shiki's own output — it HTML-escapes the code text, so the only markup is its
// <span style=…> color tokens, which is why rendering it raw is safe here.
let seq = 0;
watch(
    () => [code, lang] as const,
    ([nextCode, nextLang]) => {
        const id = ++seq;
        if (nextLang === undefined) {
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
    <div
        class="ui-code"
        :class="{ 'ui-code-wrap': wrap, 'ui-code-clamp': clamped }"
        :style="clampLines === undefined ? undefined : { '--ui-code-clamp-lines': clampLines }"
    >
        <div class="flex flex-col gap-1.5">
            <div v-if="label || copyable" class="flex items-center justify-between">
                <span class="text-2xs font-medium text-muted">{{ label }}</span>
                <CopyButton v-if="copyable" :text="code" label="Copy" @copied="emit(`copied`)" />
            </div>
            <div ref="block" class="relative">
                <div v-if="html" v-html="html"></div>
                <pre
                    v-else
                    class="scrollbar-thin overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content"
                    :class="{ 'whitespace-pre-wrap': wrap, 'break-words': wrap }"
                    >{{ code }}</pre>
                <!-- The fade is what says "there is more": a hard cut mid-command reads as a rendering bug. -->
                <div
                    v-if="clamped && overflowing"
                    class="pointer-events-none absolute inset-x-px bottom-px h-6 rounded-b-md bg-linear-to-t from-canvas to-transparent"
                ></div>
            </div>
            <button
                v-if="toggleable"
                type="button"
                :class="ui.linkButton(`gap-1 text-2xs text-muted hover:text-content`)"
                @click="expanded = !expanded"
            >
                {{ expanded ? `Show less` : `Show all` }}
                <Icon :name="expanded ? `chevron-up` : `chevron-down`" />
            </button>
        </div>
    </div>
</template>
