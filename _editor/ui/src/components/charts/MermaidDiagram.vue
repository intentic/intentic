<!--
    Renders a ```mermaid fence as a diagram; mermaid.js loads lazily on the first document that holds one. Mermaid itself validates the body: a
    diagram it refuses falls back to a plain code block.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { codeBlockHtml } from "../../markdown/code.js";
import { MERMAID_LANG } from "../../markdown/figures.js";
import { renderMermaid } from "./mermaidRender.js";
import { useTheme } from "../../composables/useTheme.js";

const { code } = defineProps<{ code: string }>();

const { scheme, accent } = useTheme();

const host = ref<HTMLElement>();
const drawn = ref<string>();
const refused = ref(false);

// Rendered as an ordinary fenced code block, so the prose surface's copy-button handler reaches it too.
const source = computed(() => codeBlockHtml({ code, lang: MERMAID_LANG }, 0, true));

// Ticket for the current render; a newer render must win over one still queued behind other diagrams.
let latest = 0;

const draw = (): void => {
    const ticket = (latest += 1);
    // Read while mounted: render resolves later when the host may be gone; falls back to document font otherwise.
    const font = getComputedStyle(host.value ?? document.body).fontFamily;
    void renderMermaid(code, scheme.value, font).then(
        (svg) => {
            if (ticket === latest) {
                drawn.value = svg;
                refused.value = false;
            }
        },
        () => {
            // Invalid syntax or an unknown diagram type; shows the source instead of leaving a hole.
            if (ticket === latest) {
                drawn.value = undefined;
                refused.value = true;
            }
        },
    );
};

// Floor for mermaid's fit-to-width shrink; below it, the diagram scrolls sideways instead of shrinking further.
const MIN_SCALE = 0.8;

const floorWidth = (): void => {
    const svg = host.value?.querySelector(`svg`) ?? undefined;
    // Mermaid sets the svg's natural width as max-width; if absent, fit-to-width behavior is left as is.
    const natural = Number.parseFloat(svg?.style.maxWidth ?? ``);
    if (svg !== undefined && Number.isFinite(natural)) {
        svg.style.minWidth = `${Math.round(natural * MIN_SCALE)}px`;
    }
};

// Accent is watched too: it moves the same tokens the diagram was painted from.
watch(() => [code, scheme.value, accent.value], draw, { immediate: true });
watch(drawn, () => void nextTick(floorWidth));
</script>

<template>
    <!-- Uses `text-center`, not flex: an over-wide flex child clips its overflow unreachably in a scroll container. -->
    <!-- Block-rhythm margin lives on the root, like other figures, so prose's block collapse reaches it too. -->
    <div ref="host" class="md-mermaid my-4">
        <div v-if="drawn !== undefined" class="overflow-x-auto text-center" v-html="drawn"></div>
        <div v-else-if="refused" v-html="source"></div>
        <!-- Pending state: fixed height sized like a small diagram. -->
        <div v-else class="h-24 rounded-lg bg-content/[0.04]"></div>
    </div>
</template>
