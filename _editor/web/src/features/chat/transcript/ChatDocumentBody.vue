<script setup lang="ts">
import { type CardDocument, planParts } from "@intentic/sandbox-contract";
import { MarkdownFigure } from "@intentic/ui";
import { copyCodeFromEvent, renderMarkdownParts } from "@intentic/ui/markdown";
import { computed, ref } from "vue";
import { useChatSurface } from "../tools/chatToolSurface";

// Renders a document a turn wrote: the Write card that produced it, and any question/plan card asking about it. No diff
// view, since a Write carries no `oldText` (a diff of it would be every line as a plus). Uses the injected surface
// (chatToolSurface.ts), not app singletons, since this also renders on a published page with no workspace or router.

const props = withDefaults(
    defineProps<{
        document: CardDocument;
        // How tall the prose may stand before it scrolls; a card asking about the document gets more room.
        maxHeight?: string;
        // Whether this copy folds; the card that wrote the document already folds over it and skips this.
        foldable?: boolean;
        open?: boolean;
        // Whether the header shows the document's title; false inside the tool card whose own row already shows it.
        titled?: boolean;
        // True inside a card asking about the document: renders as a plain section, not a nested box, sharing its edge.
        inCard?: boolean;
    }>(),
    { maxHeight: `24rem`, foldable: false, open: true, titled: true, inCard: false },
);

const surface = useChatSurface();
const openFile = surface.openFile;

// Fold state seeded from `open`, then reader-controlled; not recomputed from the prop on every render.
const shown = ref(props.open);
const toggle = (): void => {
    shown.value = !shown.value;
};

// Strips the opening heading when it duplicates the card's own title (planParts), so it isn't shown twice.
const parts = computed(() => {
    const split = planParts(props.document.markdown);
    return renderMarkdownParts(split.title === undefined ? props.document.markdown : split.body, surface.decorate);
});

// Bare file name for the header chip; the full path isn't useful at a glance.
const fileName = computed(() => props.document.path.split(`/`).pop() ?? props.document.path);

// In-card classes live in chat.css beside the host card's insets, so margins match its body and answers.
const shellClass = computed(() => (props.inCard ? `chat-card-doc` : `overflow-hidden rounded border border-line bg-canvas`));
const headClass = computed(() =>
    props.inCard ? `chat-card-doc-head` : [`border-b px-2 py-1`, shown.value ? `border-line` : `border-transparent`],
);
const bodyClass = computed(() => (props.inCard ? `chat-card-doc-body` : `px-3 py-2`));

// Delegated listener for the rendered prose's code-copy button and file links, since both live inside v-html with no
// component of their own. Navigation goes through the surface, so on a published page (no opener) the click is simply
// swallowed.
const onProseClick = (event: MouseEvent): void => {
    copyCodeFromEvent(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
    }
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(`a.md-file-link`);
    const path = link?.dataset[`file`];
    if (path === undefined || path === `` || openFile === undefined) {
        return;
    }
    event.preventDefault();
    const line = Number(link?.dataset[`line`]);
    openFile(path, Number.isInteger(line) && line > 0 ? line : undefined);
};
</script>

<template>
    <div :class="shellClass">
        <div class="flex items-center gap-1.5 text-2xs text-muted" :class="headClass">
            <!-- Folded, the title row is the whole affordance: the one line naming what can be opened. -->
            <component
                :is="foldable ? 'button' : 'span'"
                :type="foldable ? 'button' : undefined"
                class="flex min-w-0 items-center gap-1.5 text-left transition-colors"
                :class="[foldable && 'hover:text-content', titled ? 'flex-1' : 'shrink-0']"
                :aria-expanded="foldable ? shown : undefined"
                @click="foldable && toggle()"
            >
                <Icon v-if="foldable" :name="shown ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-2xs" />
                <Icon :name="document.plan ? 'list-check' : 'book'" class="shrink-0 text-2xs text-subtle" />
                <!-- Title sits at prose size, not a tier above, so it reads as a label, not a second header. -->
                <span v-if="titled" class="min-w-0 flex-1 truncate font-medium text-content" v-tooltip.top.overflow="document.title">{{
                    document.title
                }}</span>
            </component>
            <!-- Set when the wire cap cut the document short; must never look like the whole document. -->
            <span v-if="document.truncated" class="shrink-0 text-subtle">clipped</span>
            <!-- Titled: a right-side chip. Untitled: takes the label slot (can't nest inside the fold button). -->
            <component
                :is="openFile ? 'button' : 'span'"
                :type="openFile ? 'button' : undefined"
                class="min-w-0 truncate font-mono transition-colors"
                :class="[openFile && 'hover:text-content hover:underline', titled ? 'shrink' : 'flex-1 text-left']"
                v-tooltip.top="openFile ? document.path : undefined"
                @click="openFile?.(document.path)"
                >{{ fileName }}</component
            >
        </div>
        <div
            v-if="shown"
            class="scrollbar-thin md-prose chat-markdown chat-markdown-compact overflow-auto"
            :class="bodyClass"
            :style="{ maxHeight }"
            @click="onProseClick"
            @pointerdown="copyCodeFromEvent"
        >
            <template v-for="(part, index) in parts" :key="index">
                <div v-if="part.kind === `html`" class="md-part" v-html="part.html"></div>
                <MarkdownFigure v-else :figure="part.figure" />
            </template>
        </div>
    </div>
</template>
