<script setup lang="ts">
import type { ResourceView } from "@intentic-app/api-contract";
import { DagGraph, type DagEdge, type DagNode } from "@intentic-app/ui";
import { computed, reactive } from "vue";
import { statusDot, statusLabel } from "../../composables/extensions/reconcileStatus";
import { groupAccent, resourceIcon, resourceLogoUrl } from "../../composables/extensions/resourceVisual";

/* The desired-state dependency graph: each resource as a node, laid out left→right by dependency depth,
 * edges flowing from a dependency to its dependents — rendered by the shared DagGraph (dagre layout + Vue
 * Flow pan/zoom/pinch). Node cards reuse the app's Tailwind tokens — title, type chip, reconcile-status dot.
 * Selecting a node lifts its id to `selectedId`, which the parent uses to highlight the matching actual-state
 * card across the split. */

const { resources = [] } = defineProps<{ resources?: readonly ResourceView[] }>();
// Two-way: which node is selected (shared with the actual-state side to cross-highlight).
const selectedId = defineModel<string | undefined>();

// Read-only hover summary that decodes the status dot and surfaces the drift reason at a glance.
const nodeSummary = (resource: ResourceView): string =>
    `${statusLabel(resource.status)}${resource.reason ? ` — ${resource.reason}` : ``} · ${resource.type} · ${resource.group}`;

const nodes = computed<DagNode<ResourceView>[]>(() =>
    resources.map((resource) => ({ id: resource.id, data: resource, tooltip: nodeSummary(resource) })),
);
// Only edges to resources we actually have — drop dangling refs so a missing dep never breaks the graph.
const edges = computed<DagEdge[]>(() => {
    const ids = new Set(resources.map((resource) => resource.id));
    return resources.flatMap((resource) => (resource.dependsOn ?? []).filter((dep) => ids.has(dep)).map((dep) => ({ from: dep, to: resource.id })));
});

// Node ids whose brand logo failed to load (bad/renamed simple-icons slug) → fall back to the semantic glyph.
const logoFailed = reactive(new Set<string>());
</script>

<template>
    <!-- Vue Flow needs a sized container (the section flows) — a fixed band with fit-view + pan/zoom inside. -->
    <div v-if="nodes.length > 0" class="h-96">
        <DagGraph v-model="selectedId" :nodes="nodes" :edges="edges">
            <template #node="{ node }">
                <span class="flex h-full items-center gap-2.5 py-2 pl-3 pr-2.5">
                    <!-- Category stripe (left) — the coarse group, on its own layer so it coexists with the border/ring. -->
                    <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="groupAccent(node.data.group).bar"></span>
                    <!-- Framed icon: the product's brand logo when we know it, else the semantic glyph; tinted by group. -->
                    <span
                        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
                        :class="groupAccent(node.data.group).frame"
                    >
                        <img
                            v-if="resourceLogoUrl(node.data.type) && !logoFailed.has(node.id)"
                            :src="resourceLogoUrl(node.data.type)"
                            :alt="node.data.type"
                            class="h-5 w-5 shrink-0 object-contain"
                            @error="logoFailed.add(node.id)"
                        />
                        <Icon v-else :name="resourceIcon(node.data.type)" class="text-sm" />
                    </span>
                    <!-- Title over "type · group". -->
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-sm font-medium leading-tight text-content">{{ node.data.title }}</span>
                        <span class="truncate text-2xs leading-tight text-subtle">{{ node.data.type }} · {{ node.data.group }}</span>
                    </span>
                    <!-- Reconcile-status dot (right) — the axis orthogonal to category. -->
                    <span class="h-2 w-2 shrink-0 self-center rounded-full" :class="statusDot(node.data.status)"></span>
                </span>
            </template>
        </DagGraph>
    </div>
    <p v-else class="py-6 text-center text-sm text-muted">No desired state yet. Declare backends in Configuration, then provision.</p>
</template>
