<script setup lang="ts">
import { type CardDocument, planParts } from "@intentic/sandbox-contract";
import { MarkdownFigure } from "@intentic/ui";
import { copyCodeFromEvent, renderMarkdownParts } from "@intentic/ui/markdown";
import { computed, ref } from "vue";
import { useChatSurface } from "./chatSurface";

/* A DOCUMENT THE TURN WROTE, drawn as the thing it is.
 *
 * One renderer, three places: the Write card that produced it, and the question and plan cards that are asking
 * about it (ChatMessageView). The same component in all three so a document reads the same wherever the reader
 * meets it, and so the card that ASKS can carry the document without the reader having to go find the card that
 * WROTE it, which by then is folded and well up the scroll.
 *
 * NO DIFF VIEW, deliberately. A document only ever comes from a whole-file Write, and a Write carries no "before"
 * on the wire (agent/tool-calls.ts sends `newText` alone), so a diff of one is every line prefixed with a plus:
 * the shape of a change, with none of the information. An EDIT to a markdown file is a real change and stays a
 * diff, which is why documents.ts only claims the Write.
 *
 * Everything that leads off it comes from the injected surface (chatSurface.ts) rather than from the app's
 * singletons: this renders inside a conversation published to the public, where there is no workspace to open
 * and no router to reach, and the file links inside the prose must go dead rather than 404. */

const props = withDefaults(
    defineProps<{
        document: CardDocument;
        // How tall the prose may stand before it scrolls. A document written for the reader is worth more room
        // than a tool's output, and a card asking a question about one is worth more still: the answer is below
        // it, and a reader who has to scroll a box to reach the question has been given a worse card than a
        // folded one.
        maxHeight?: string;
        /* A FOLD OF ITS OWN, for the copies that are not the only one on screen. The tool card that WROTE a
         * document already folds over it, so it passes neither of these; a question card carrying the same
         * document as its subject does, and opens closed when the write's own card is drawn right above it.
         * Two copies of a 135-line document in a row is not twice as readable. */
        foldable?: boolean;
        open?: boolean;
        /* Whether the header says what the document is CALLED. False inside the tool card that wrote it, whose
         * own row already carries the title in the slot a path would take: said twice, two lines apart, it reads
         * as two documents. The file name stays either way, because it is also the way into the workspace. */
        titled?: boolean;
    }>(),
    { maxHeight: `24rem`, foldable: false, open: true, titled: true },
);

const surface = useChatSurface();
const openFile = surface.openFile;

// The fold, seeded from `open` and the reader's from then on. Not a computed off the prop: once somebody has
// opened a document, a re-render must not close it again.
const shown = ref(props.open);
const toggle = (): void => {
    shown.value = !shown.value;
};

/* The prose. Rendered through the ENGINE rather than through the app's markdown composable: the composable
 * decorates with the app's own file links, which reach the workspace cache and the query client behind it, and
 * this card also draws on a published page that must carry neither. The decoration is the surface's to supply
 * (chatSurface.ts), so in the app the links are there and on a shared page the paths are plain text.
 *
 * Parsed once, not per frame: a document arrives whole with the frame that carries it, so there is no streaming
 * split to make (see useMarkdown for the case that needs one).
 *
 * The opening heading is left OUT of the body when it is the one this card is already headed with, exactly as
 * the plan card splits a plan (planParts): a document whose name is printed twice, two lines apart, reads as a
 * document quoted inside another one. A document that opens with prose has no heading to promote and keeps
 * every word it was written with. */
const parts = computed(() => {
    const split = planParts(props.document.markdown);
    return renderMarkdownParts(split.title === undefined ? props.document.markdown : split.body, surface.decorate);
});

// What the file is called, for the header's right-hand chip: the title above it already says what the document
// IS, and the whole path (`.intentic/records/sessions/claude/plans/…`) says nothing a reader wants at a glance.
const fileName = computed(() => props.document.path.split(`/`).pop() ?? props.document.path);

/* One delegated listener for the controls the rendered prose carries: a code block's copy button, and the file
 * links a mentioned path becomes. Both live inside v-html and can hold no component of their own.
 *
 * The link goes through the SURFACE rather than through the app's own navigation, which is what keeps this
 * component mountable on a published page: with nothing to open, the click is simply swallowed and the anchor
 * stays what it always was, the record of a path the document named. */
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
    <div class="overflow-hidden rounded border border-line bg-canvas">
        <div class="flex items-center gap-1.5 border-b px-2 py-1 text-2xs text-muted" :class="shown ? 'border-line' : 'border-transparent'">
            <!-- Folded, the title row IS the affordance: one line naming what the reader can open, which is what
                 a card asking about a document owes them when the document is already drawn above it. -->
            <component
                :is="foldable ? 'button' : 'span'"
                :type="foldable ? 'button' : undefined"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors"
                :class="foldable && 'hover:text-content'"
                :aria-expanded="foldable ? shown : undefined"
                @click="foldable && toggle()"
            >
                <Icon v-if="foldable" :name="shown ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-2xs" />
                <Icon :name="document.plan ? 'list-check' : 'book'" class="shrink-0 text-2xs text-subtle" />
                <!-- The title, at the size of the prose it names rather than a tier above it: this is a card
                     inside a card, and a heading shouted over a two-line question reads as a banner. -->
                <span v-if="titled" class="min-w-0 flex-1 truncate font-medium text-content" v-tooltip.top.overflow="document.title">{{
                    document.title
                }}</span>
                <span v-else class="flex-1"></span>
            </component>
            <!-- The wire cap cut it. Said out loud, next to the way to read the rest: a document silently missing
                 its last third is the one failure this card must never present as a whole document. -->
            <span v-if="document.truncated" class="shrink-0 text-subtle">clipped</span>
            <component
                :is="openFile ? 'button' : 'span'"
                :type="openFile ? 'button' : undefined"
                class="min-w-0 shrink truncate font-mono transition-colors"
                :class="openFile && 'hover:text-content hover:underline'"
                v-tooltip.top="openFile ? document.path : undefined"
                @click="openFile?.(document.path)"
                >{{ fileName }}</component
            >
        </div>
        <div
            v-if="shown"
            class="scrollbar-thin md-prose chat-markdown chat-markdown-compact overflow-auto px-3 py-2"
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
