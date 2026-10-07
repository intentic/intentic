<script setup lang="ts">
import { SEALED_PAGE_POLICY, pageThemeCss } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import type { PageDraftView } from "../../session/turnClient";
import { usePageTheme } from "./pageTheme";

// A page as the agent is still writing it, drawn as its markup streams in, the way prose is. The browser's own HTML
// parser does the streaming: each new stretch is written into the frame's open document, so a half-written table or a
// chart's container appears as it arrives. The frame runs no script at all (no `allow-scripts`), which is what lets
// this window write into it directly; the page's scripts run once it is whole, in its own sealed frame (ChatPageFrame).

const t = useT();

const props = defineProps<{ draft: PageDraftView }>();

const theme = usePageTheme();
const frame = useTemplateRef<HTMLIFrameElement>(`frame`);
// The tallest a draft grows before the rest of it waits for the page: enough to watch it take shape.
const MAX_HEIGHT = 560;
const height = ref(48);
// How much of the markup the open document holds.
let written = 0;
let doc: Document | undefined;

// Opens the frame's document with the seal and the theme first, so nothing the draft names loads and it already wears
// the chat's colours; everything written after is the page's own markup.
const open = (): Document | undefined => {
    const target = frame.value?.contentDocument ?? undefined;
    if (target === undefined) {
        return undefined;
    }
    target.open();
    target.write(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SEALED_PAGE_POLICY}"><meta name="referrer" content="no-referrer">` +
            `<style>${pageThemeCss(theme.value)}</style>`,
    );
    written = 0;
    return target;
};

const measure = (): void => {
    const root = doc?.documentElement;
    if (root !== undefined) {
        height.value = Math.min(MAX_HEIGHT, Math.max(48, Math.ceil(root.getBoundingClientRect().height)));
    }
};

const flush = (): void => {
    doc ??= open();
    if (doc === undefined) {
        return;
    }
    const html = props.draft.html;
    // A replay rewrote what was already drawn: start the document over rather than append onto the wrong markup.
    if (html.length < written) {
        doc = open();
        if (doc === undefined) {
            return;
        }
    }
    if (html.length > written) {
        // The policy governs what loads, not where the frame goes: a refresh or a base is renamed into an element that does
        // nothing, so neither takes the frame elsewhere.
        doc.write(html.slice(written).replace(/<(meta|base)\b(?=[^>]*(?:http-equiv\s*=\s*["']?refresh|href))/gi, `<intentic-inert-$1`));
        written = html.length;
    }
    measure();
};

onMounted(flush);
watch(() => props.draft.html, flush);
// The draft keeps the look it opened with; one switched mid-draft is put right by the page itself moments later.
onBeforeUnmount(() => {
    doc?.close();
    doc = undefined;
});
</script>

<template>
    <section class="flex w-full flex-col gap-1" aria-busy="true">
        <div class="px-3.5">
            <div class="relative overflow-hidden" :style="{ height: `${height}px` }">
                <!-- `allow-same-origin` without `allow-scripts`: this window writes the markup in; nothing in it runs. -->
                <iframe ref="frame" sandbox="allow-same-origin" class="block size-full border-0" :style="{ colorScheme: theme.appearance }" :title="draft.title ?? t(`chat.chatPages.drafting`)" />
                <!-- A fade over the cut edge while the page is taller than the draft may grow. -->
                <div v-if="height >= MAX_HEIGHT" class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-canvas to-transparent" />
            </div>
        </div>
        <div class="flex min-w-0 items-center gap-1.5 px-3.5 text-2xs text-subtle">
            <Icon name="spinner" spin class="shrink-0 text-2xs text-info" />
            <span class="min-w-0 truncate">{{ draft.title === undefined ? t(`chat.chatPages.drafting`) : t(`chat.chatPages.draftingTitled`, { title: draft.title }) }}</span>
        </div>
    </section>
</template>
