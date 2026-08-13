<script setup lang="ts">
import { DagGraph, type DagEdge, type DagNode, Icon, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { toneOfType } from "./knowledgeNote";
import { useGraph } from "./useKnowledge";

/* THE MAP AROUND ONE NOTE — everything within a couple of steps of it, and what each connection is called.
 *
 * This is the picture a folder of files cannot give you: which people touch which projects, what a decision was
 * about, what supersedes what. It is drawn around the OPEN NOTE rather than over the whole vault, because a
 * whole-vault picture of anything past fifty notes is a hairball — pretty, and unable to answer a question. The
 * neighbourhood answers the question you actually have, which is "what is this connected to".
 *
 * Laid out left-to-right by the same dagre renderer the pipeline graphs use. A knowledge graph is not a DAG —
 * relationships go both ways and around in circles — and the layout handles that by choosing an order to draw
 * the cycle in, which is fine here: the reader is being shown WHAT is connected, and the arrow on each edge
 * carries the direction the layout gave up. `magnify` is off and the zoom floor is low, because a hub section
 * is a wide short band and a five-note map blown up to fill it reads as five billboards. */

const { path, depth = 2 } = defineProps<{ path: string | undefined; depth?: number }>();
const emit = defineEmits<{ open: [path: string] }>();

const { graph, error, isLoading } = useGraph(
    toRef(() => path),
    toRef(() => depth),
    ref(true),
);

interface Card {
    readonly title: string;
    readonly type: string | undefined;
    readonly focus: boolean;
    readonly path: string;
}

const nodes = computed<DagNode<Card>[]>(
    () =>
        graph.value?.nodes.map((node) => ({
            id: node.path,
            data: { title: node.title, type: node.type, focus: node.path === graph.value?.focus, path: node.path },
            // The path is what a reader needs to go find the file, and it is the one thing that does not fit on
            // a card this size.
            tooltip: node.path,
            // Depth is drawn as fade rather than as a number: the further out, the less it is about this note.
            dimmed: node.depth > 1,
        })) ?? [],
);

// A relationship's name rides its edge, since the name is most of what an edge means here — "works_on" and
// "supersedes" between the same two notes are entirely different facts.
const edges = computed<DagEdge[]>(
    () =>
        graph.value?.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            kind: edge.relation ?? `mentions`,
            // A link written in the prose is a weaker claim than one the header names, and reads as one.
            dashed: edge.relation === undefined,
        })) ?? [],
);

const selected = ref<string>();
const openSelected = (): void => {
    if (selected.value !== undefined && selected.value !== graph.value?.focus) {
        emit(`open`, selected.value);
    }
};
</script>

<template>
    <!-- A DEFINITE HEIGHT, not a grown one. The canvas measures its parent to lay the graph out, so a box sized
         by its contents measures as zero and renders nothing at all — no error, no empty state, just a blank
         rectangle. It sits inside a scrolling panel body, which cannot give it one, so the height is stated
         here: enough for three ranks of cards, and bounded by the viewport so a short window still shows the
         note's own frame around it. -->
    <div class="relative flex h-figure w-full flex-col">
        <p v-if="error" class="px-4 py-3 text-xs text-danger">{{ error }}</p>
        <p v-else-if="isLoading" class="px-4 py-6 text-xs text-subtle">Drawing the map…</p>
        <div v-else-if="nodes.length <= 1" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <Icon name="sitemap" class="text-base text-subtle" />
            <p class="text-sm text-muted">Nothing links to this note yet.</p>
            <p class="max-w-sm text-xs text-subtle">
                Mention another note as <code>[[its name]]</code> in the text, or name the relationship in the header — <code>works_on:</code>,
                <code>about:</code> — and it appears here.
            </p>
        </div>

        <!-- TOP-TO-BOTTOM, because of the shape of the box rather than the shape of the graph: this pane is a
             narrow column beside a list, and a left-to-right layout wants width it does not have — six notes
             laid out sideways fit only by shrinking to where the labels stop resolving.

             `readable-zoom` is the other half of that. A fit nobody can read is not a fit: below this the
             canvas stops shrinking and shows the graph's leading edge at a size with legible labels, and the
             rest is one drag away. Without it a well-connected note drew a row of grey smudges. -->
        <DagGraph
            v-else
            v-model="selected"
            class="h-full w-full"
            :nodes="nodes"
            :edges="edges"
            direction="TB"
            :node-width="164"
            :node-height="52"
            :magnify="false"
            :readable-zoom="0.7"
            :min-zoom="0.3"
        >
            <template #node="{ node }">
                <button
                    type="button"
                    class="flex h-full w-full flex-col justify-center gap-0.5 px-2.5 text-left"
                    :class="node.data.focus ? `font-medium` : undefined"
                    @dblclick="emit(`open`, node.data.path)"
                >
                    <span class="truncate text-xs text-content">{{ node.data.title }}</span>
                    <StatusBadge v-if="node.data.type" :variant="toneOfType(node.data.type) as StatusVariant" size="xs" :label="node.data.type" />
                </button>
            </template>

            <!-- One control, and it is the one a reader wants after clicking a card: go there. Double-clicking
                 a card does the same, so the gesture works before anybody finds the button. -->
            <template #overlay>
                <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 text-2xs text-subtle">
                    <span v-if="graph?.omitted" class="rounded bg-surface/80 px-1.5 py-0.5">{{ graph.omitted }} more not shown</span>
                    <span v-else></span>
                    <button
                        v-if="selected && selected !== graph?.focus"
                        type="button"
                        class="pointer-events-auto rounded bg-surface/90 px-2 py-1 text-xs text-link hover:underline"
                        @click="openSelected"
                    >
                        Open this note
                    </button>
                </div>
            </template>
        </DagGraph>
    </div>
</template>
