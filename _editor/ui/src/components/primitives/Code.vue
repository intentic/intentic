<!--
    Highlighted code block: a thin wrapper over useHighlighter with a header label and copy button. Falls back to a plain `<pre>` while highlighting
    is in flight, and permanently for unsupported languages.
-->
<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { ui } from "../../lib/ui.js";
import { useHighlighter } from "../../composables/useHighlighter.js";
import type { ShikiLang } from "@intentic/code-read/langs";
import CopyButton from "./CopyButton.vue";

const {
    code,
    lang,
    label = ``,
    copyable = true,
    wrap = false,
    clampLines,
    scrollLines,
} = defineProps<{
    code: string;
    // Shiki language id (e.g. `bash`); omit to render plain text. Typed to the grammars we ship, so a typo fails to
    // compile.
    lang?: ShikiLang;
    label?: string;
    copyable?: boolean;
    // Long single-line commands read better wrapped; multi-line files scroll horizontally.
    wrap?: boolean;
    // Lines to show before fading out with a "Show all" toggle; copy still works clamped. Omit for no clamp.
    clampLines?: number;
    // Same height budget as `clampLines`, but scrolls in place instead of expanding the page.
    scrollLines?: number;
}>();

// Passed through from the built-in copy button, for a caller whose flow depends on the copy happening.
const emit = defineEmits<{ copied: [] }>();

const { highlight } = useHighlighter();
const html = ref<string | undefined>(undefined);

// Whether there's more to show is measured (ResizeObserver), since wrapping depends on render width.
const expanded = ref(false);
const clamped = computed(() => clampLines !== undefined && !expanded.value);
const scrolled = computed(() => scrollLines !== undefined);
const maxLines = computed(() => clampLines ?? scrollLines);
const block = ref<HTMLElement>();
const overflowing = ref(false);
// Stays visible once expanded, so the toggle doesn't disappear once the block reads "no more to show."
const toggleable = computed(() => clampLines !== undefined && (expanded.value || overflowing.value));

const measure = (): void => {
    const pre = block.value?.querySelector(`pre`);
    overflowing.value = pre !== undefined && pre !== null && pre.scrollHeight > pre.clientHeight + 1;
};
// Only a clamped block is observed; unclamped blocks (there can be dozens, in a transcript) need no measuring.
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
// The highlighted markup replaces the fallback <pre>, so measure again after the swap.
watch(html, () => void nextTick(measure));
onUnmounted(() => observer?.disconnect());

// Safe: Shiki HTML-escapes the code, so the only markup is its own `<span style>` colour tokens.
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
            // Ignore a stale result if code/lang changed while highlighting was in flight.
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
        :class="{ 'ui-code-wrap': wrap, 'ui-code-clamp': clamped, 'ui-code-scroll': scrolled, 'ui-code-copyable': copyable }"
        :style="maxLines === undefined ? undefined : { '--ui-code-clamp-lines': maxLines }"
    >
        <div class="flex flex-col gap-1.5">
            <!--
                Only a label gets a row of its own; an unlabelled block needs no empty chrome row above it. The copy
                button sits on the block, in reserved space, instead.
            -->
            <div v-if="label" class="flex items-center justify-between">
                <span class="text-2xs font-medium text-muted">{{ label }}</span>
            </div>
            <div ref="block" class="relative">
                <div v-if="html" v-html="html"></div>
                <pre
                    v-else
                    class="scrollbar-thin overflow-x-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content"
                    :class="{ 'whitespace-pre-wrap': wrap, 'break-words': wrap }"
                    >{{ code }}</pre>
                <!--
                    `bg-canvas`, not transparent: it sits over the code surface; the block's right padding keeps text
                    clear of it.
                -->
                <!--
                    The wrapper, not the button, carries `relative`: Button's root always sets it too, and class order,
                    not source order, decides which one wins.
                -->
                <!--
                    `flex`, not a bare block: a block-level chip sits on the text line and inherits its leading, which
                    throws off the corner inset.
                -->
                <!--
                    Nudged left of the scrollbar's width in scroll mode; a utility class here beats code.css's `@layer
                    components`.
                -->
                <div v-if="copyable" class="absolute top-1.5 flex" :class="scrolled ? `right-5` : `right-1.5`">
                    <CopyButton :text="code" label="Copy" class="bg-canvas" @copied="emit(`copied`)" />
                </div>
                <!-- The fade signals there's more; a hard cut mid-command would read as a rendering bug. -->
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
