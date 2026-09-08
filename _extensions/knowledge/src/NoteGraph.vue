<script setup lang="ts">
import { Button, DagGraph, type DagEdge, type DagNode, Icon, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { toneOfType } from "./knowledgeNote";
import { useGraph } from "./useKnowledge";

// The neighbourhood around one note, with what each connection is called: what a folder of files can't show. Drawn
// around the open note, not the whole knowledge base, since a full graph is an unreadable hairball past a few dozen
// notes. Left-to-right with dagre; edges keep their direction though the graph isn't a DAG.

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
            // The path, for finding the file; the one thing that doesn't fit on a card this size.
            tooltip: node.path,
            // Depth shown as fade, not a number: further out matters less to this note.
            dimmed: node.depth > 1,
        })) ?? [],
);

// A relationship's name rides its edge, since two notes can carry entirely different relations.
const edges = computed<DagEdge[]>(
    () =>
        graph.value?.edges.map((edge) => ({
            from: edge.from,
            to: edge.to,
            kind: edge.relation ?? `mentions`,
            // A link written in prose is a weaker claim than one the header names, and reads as one.
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
    <!-- A definite height, not a grown one: the canvas measures its parent, and content-sized zero renders nothing. -->
    <div class="relative flex h-figure w-full flex-col">
        <p v-if="error" class="px-4 py-3 text-xs text-danger">{{ error }}</p>
        <p v-else-if="isLoading" class="px-4 py-6 text-xs text-subtle">Drawing the map…</p>
        <div v-else-if="nodes.length <= 1" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
            <Icon name="sitemap" class="text-base text-subtle" />
            <p class="text-sm text-muted">Nothing links to this note yet.</p>
            <p class="max-w-sm text-xs text-subtle">
                Mention another note as <code>[[its name]]</code> in the text, or name the relationship in the header: <code>works_on:</code>,
                <code>about:</code>, and it appears here.
            </p>
        </div>

        <!-- Top-to-bottom for this column's shape, not the graph's; `readable-zoom` stops shrinking before labels blur. -->
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

            <!-- One control, the one thing wanted after picking a card; double-click does the same before it's found. -->
            <template #overlay>
                <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-2 text-2xs text-subtle">
                    <span v-if="graph?.omitted" class="rounded bg-surface/80 px-1.5 py-0.5">{{ graph.omitted }} more not shown</span>
                    <span v-else></span>
                    <Button
                        v-if="selected && selected !== graph?.focus"
                        size="small"
                        severity="secondary"
                        class="pointer-events-auto"
                        @click="openSelected"
                    >
                        Open this note
                    </Button>
                </div>
            </template>
        </DagGraph>
    </div>
</template>
