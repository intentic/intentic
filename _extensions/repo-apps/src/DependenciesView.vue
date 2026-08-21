<script setup lang="ts">
import type { WorkspaceDepEdge, WorkspacePackage } from "@intentic/sandbox-contract";
import { Card, ui, DagGraph, Notice, noticeOf, ToggleSwitch, useLoadingReveal, type DagEdge, type DagNode } from "@intentic/extension-ui";
import { computed, ref, toRef } from "vue";
import { useWorkspaceGraph } from "./useWorkspaceGraph";

/* The monorepo's workspace package dependency graph: one card per package (colored by its top-level dir),
 * edges flowing dependency → dependent left-to-right. Dev deps hide behind a toggle: with them shown, hub
 * devDependencies like a shared tsconfig swamp the picture. Selecting a package highlights its transitive
 * closure both ways (what it uses vs what uses it, tinted apart) and dims the rest. */

const props = defineProps<{ repo: string }>();
const { packages, edges, error, isLoading } = useWorkspaceGraph(toRef(props, `repo`));
// Drawn only once the wait has earned it, and keyed on the repo so switching starts a fresh wait.
const outline = useLoadingReveal(isLoading, toRef(props, `repo`));

const showDev = ref(false);
const selectedId = ref<string | undefined>(undefined);

// The directory groups' accents: a stripe on each card and a matching legend dot. Unknown groups fall to subtle.
const GROUP_BAR: Record<string, string> = {
    _apps: `bg-success`,
    _libs: `bg-info`,
    _extensions: `bg-primary-500`,
    _tools: `bg-warning`,
};
const barOf = (group: string): string => GROUP_BAR[group] ?? `bg-subtle`;
const legend = computed(() => [...new Set(packages.value.map((pkg) => pkg.group))].toSorted());

// The visible slice. Without the toggle, dev edges are hidden along with packages ONLY reachable through them
// (a shared tsconfig devDep'd by everything); packages with no edges at all stay visible.
const visibleEdges = computed(() => edges.value.filter((edge) => showDev.value || edge.type !== `dev`));
const visiblePackages = computed(() => {
    if (showDev.value) {
        return packages.value;
    }
    const incident = new Set<string>();
    const nonDev = new Set<string>();
    for (const edge of edges.value) {
        incident.add(edge.from).add(edge.to);
        if (edge.type !== `dev`) {
            nonDev.add(edge.from).add(edge.to);
        }
    }
    return packages.value.filter((pkg) => !incident.has(pkg.name) || nonDev.has(pkg.name));
});

const edgeKey = (edge: WorkspaceDepEdge): string => `${edge.from}>${edge.to}:${edge.type}`;

// The selection's transitive closure over the VISIBLE edges, walked both ways from the selected package:
// `uses` follows from→to (its dependencies), `usedBy` follows to→from (its dependents). Edges collect the
// accent of whichever walk traversed them.
const closure = computed(() => {
    const start = selectedId.value;
    if (start === undefined || !visiblePackages.value.some((pkg) => pkg.name === start)) {
        return undefined;
    }
    const walk = (follow: (edge: WorkspaceDepEdge, id: string) => string | undefined, accent: string) => {
        const reached = new Set<string>();
        const accents = new Map<string, string>();
        const queue = [start];
        while (queue.length > 0) {
            const current = queue.pop();
            if (current === undefined) {
                break;
            }
            for (const edge of visibleEdges.value) {
                const next = follow(edge, current);
                if (next === undefined) {
                    continue;
                }
                accents.set(edgeKey(edge), accent);
                if (next !== start && !reached.has(next)) {
                    reached.add(next);
                    queue.push(next);
                }
            }
        }
        return { reached, accents };
    };
    const uses = walk((edge, id) => (edge.from === id ? edge.to : undefined), `text-warning`);
    const usedBy = walk((edge, id) => (edge.to === id ? edge.from : undefined), `text-info`);
    return { uses, usedBy, nodes: new Set([start, ...uses.reached, ...usedBy.reached]) };
});

const dagNodes = computed<DagNode<WorkspacePackage>[]>(() =>
    visiblePackages.value.map((pkg) => ({
        id: pkg.name,
        data: pkg,
        tooltip: `${pkg.name} · ${pkg.dir}`,
        dimmed: closure.value !== undefined && !closure.value.nodes.has(pkg.name),
    })),
);
// The API edge says "from DEPENDS ON to"; rendered flipped (dependency → dependent) so dependencies sit left
// and the arrow of time flows into the things built on top: same orientation as the live-status graph.
const dagEdges = computed<DagEdge[]>(() =>
    visibleEdges.value.map((edge) => ({
        from: edge.to,
        to: edge.from,
        kind: edge.type,
        dashed: edge.type === `dev`,
        accent: closure.value?.uses.accents.get(edgeKey(edge)) ?? closure.value?.usedBy.accents.get(edgeKey(edge)),
        dimmed: closure.value !== undefined && !closure.value.uses.accents.has(edgeKey(edge)) && !closure.value.usedBy.accents.has(edgeKey(edge)),
    })),
);
</script>

<template>
    <div class="flex h-full min-h-0 flex-col gap-3 p-4">
        <Notice v-if="error" :of="noticeOf(error)" />
        <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-3 text-2xs text-muted">
                <span v-for="group in legend" :key="group" class="flex items-center gap-1.5">
                    <span class="h-2 w-2 rounded-full" :class="barOf(group)"></span>{{ group }}
                </span>
                <span class="flex items-center gap-1.5">
                    <svg class="h-px w-5 overflow-visible text-subtle" aria-hidden="true">
                        <line x1="0" y1="0.5" x2="20" y2="0.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 3" />
                    </svg>
                    dev
                </span>
            </div>
            <div class="flex items-center gap-4">
                <span v-if="closure" class="flex items-center gap-3 text-2xs text-muted">
                    <span class="flex items-center gap-1"
                        ><span class="h-2 w-2 rounded-full bg-warning"></span>uses {{ closure.uses.reached.size }}</span
                    >
                    <span class="flex items-center gap-1"
                        ><span class="h-2 w-2 rounded-full bg-info"></span>used by {{ closure.usedBy.reached.size }}</span
                    >
                </span>
                <label class="flex cursor-pointer items-center gap-2 text-xs text-muted">
                    <ToggleSwitch v-model="showDev" class="scale-75" />
                    Dev dependencies
                </label>
            </div>
        </div>
        <!-- The graph fills the pane, so the wait for it is the largest blank in this tab. Drawn as a scatter
             of package cards at the size the real ones land at, not as a graph: the shape of somebody's
             dependency tree is the one thing this view exists to show and the last thing to invent. -->
        <div v-if="isLoading && outline" class="min-h-0 flex-1 p-2" role="status" aria-busy="true">
            <span class="sr-only">Reading the workspace graph…</span>
            <div class="flex flex-wrap gap-3" aria-hidden="true">
                <span v-for="card in 6" :key="card" class="skeleton block h-12" :class="[`w-44`, `w-52`, `w-40`][card % 3]" />
            </div>
        </div>

        <Card v-else-if="packages.length === 0 && !isLoading" dashed class="text-center text-sm text-muted">
            No workspace packages found: pnpm-workspace.yaml names no package dirs.
        </Card>
        <div v-else class="min-h-0 flex-1">
            <DagGraph v-model="selectedId" :nodes="dagNodes" :edges="dagEdges" :node-height="52">
                <template #node="{ node }">
                    <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="barOf(node.data.group)"></span>
                    <span class="flex h-full min-w-0 flex-col justify-center px-3">
                        <span class="truncate text-sm font-medium leading-tight text-content">{{ node.data.name }}</span>
                        <span class="truncate font-mono text-2xs leading-tight text-subtle">{{ node.data.dir }}</span>
                    </span>
                </template>
            </DagGraph>
        </div>
    </div>
</template>
