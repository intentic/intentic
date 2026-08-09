<!-- A ```mermaid fence, drawn.
     Mermaid is the notation people already write diagrams in — a repository's READMEs and design notes are
     full of it long before this app opens them — so a file preview that printed the arrow syntax instead of
     the picture would be the one tool on the machine that cannot read them.

     THE PARSER IS THE VALIDATOR, and it arrives late. Mermaid is a megabyte of diagram grammars: it loads on
     the first document that actually holds a diagram, and never on the many that do not. That is also why the
     "is this valid?" question is answered here rather than in markdown/figures.ts, which decides every other
     figure kind synchronously — nothing but mermaid can judge mermaid. A body it refuses renders as an
     ordinary code block, which keeps the engine's contract exactly where it always was: a broken figure costs
     itself, never the page.

     Untrusted input, and treated as such — see mermaidRender.ts, which owns everything singular about mermaid
     (its configuration, its ids, the order renders run in), because a page holds many diagrams and one
     mermaid. This file owns what is per-diagram: which of the three states it is in, and the theme it was
     drawn for. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { codeBlockHtml } from "../markdown/code.js";
import { MERMAID_LANG } from "../markdown/figures.js";
import { renderMermaid } from "./mermaidRender.js";
import { useTheme } from "../composables/useTheme.js";

const { code } = defineProps<{ code: string }>();

const { scheme, theme } = useTheme();

const host = ref<HTMLElement>();
const drawn = ref<string>();
const refused = ref(false);

// The source, dressed exactly like any other fenced block — same chrome, same copy button, which the prose
// surface's delegated handler reaches because this markup is inside it.
const source = computed(() => codeBlockHtml({ code, lang: MERMAID_LANG }, 0, true));

// Which render is the current one. A theme flip or an edited source starts another while the previous is still
// queued behind the other diagrams on the page, and the older result must not win.
let latest = 0;

const draw = (): void => {
    const ticket = (latest += 1);
    // Read while the element is in the document: the render resolves several awaits later, by which point the
    // surface may be gone. Falls back to the document's family for a diagram drawn before the host is mounted.
    const font = getComputedStyle(host.value ?? document.body).fontFamily;
    void renderMermaid(code, scheme.value, font).then(
        (svg) => {
            if (ticket === latest) {
                drawn.value = svg;
                refused.value = false;
            }
        },
        () => {
            // Invalid syntax, or a diagram type this build of mermaid does not know. Either way the reader
            // gets the source rather than a hole in the document.
            if (ticket === latest) {
                drawn.value = undefined;
                refused.value = true;
            }
        },
    );
};

/* A DIAGRAM SHRUNK TO FIT IS NOT ALWAYS A DIAGRAM ANYONE CAN READ. Mermaid caps its svg at the container's
 * width, which is right up until the diagram is twice as wide as the column it is being read in: the flowchart
 * that prompted this feature is 1163px of boxes, and in a 627px preview it drew at 54% — labels at seven
 * pixels, a picture of a diagram rather than one.
 *
 * So the shrink gets a floor and, past it, the figure scrolls sideways instead. It is the same trade DagGraph
 * makes with `readableZoom`, for the same reason and with the same conclusion: a fit no one can read is not a
 * fit. The floor is loose enough that a diagram only somewhat too wide still fits whole — scrolling to see a
 * picture that WOULD have been legible is the other way to get this wrong. */
const MIN_SCALE = 0.8;

const floorWidth = (): void => {
    const svg = host.value?.querySelector(`svg`) ?? undefined;
    // Mermaid writes the diagram's natural width as the svg's own max-width; absent (a version that stops
    // doing so, a diagram type that does not) simply leaves today's fit-to-width behaviour in place.
    const natural = Number.parseFloat(svg?.style.maxWidth ?? ``);
    if (svg !== undefined && Number.isFinite(natural)) {
        svg.style.minWidth = `${Math.round(natural * MIN_SCALE)}px`;
    }
};

// The brand theme is watched beside the scheme because it moves the same tokens the diagram was painted from.
watch(() => [code, scheme.value, theme.value], draw, { immediate: true });
watch(drawn, () => void nextTick(floorWidth));
</script>

<template>
    <!-- Centred with `text-center` rather than flex: an over-wide flex child centred in a scroll container has
         its overflowing left edge clipped unreachably, and the whole point of the floor above is that this
         container sometimes scrolls. An svg is inline, so text alignment centres it while it still fits. -->
    <div ref="host" class="md-mermaid">
        <div v-if="drawn !== undefined" class="my-4 overflow-x-auto text-center" v-html="drawn"></div>
        <div v-else-if="refused" v-html="source"></div>
        <!-- Pending: a wash the size of a small diagram, so the page does not jump when one arrives. -->
        <div v-else class="my-4 h-24 rounded-lg bg-content/[0.04]"></div>
    </div>
</template>
