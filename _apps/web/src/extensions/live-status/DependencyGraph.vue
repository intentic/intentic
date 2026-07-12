<script setup lang="ts">
import type { ResourceView } from "@intentic-app/api-contract";
import { useDevice } from "@intentic-app/ui";
import { computed, reactive, ref } from "vue";
import { statusDot, statusLabel } from "../../composables/extensions/reconcileStatus";
import { groupAccent, resourceIcon, resourceLogoUrl } from "../../composables/extensions/resourceVisual";
import { type GraphEdge, layoutGraph } from "./graphLayout";

/* The desired-state dependency graph: each resource as a node, laid out left→right by dependency depth (see
 * graphLayout.ts), edges flowing from a dependency to its dependents. Nodes are HTML (so they reuse the app's
 * Tailwind tokens — title, type chip, reconcile-status dot) positioned over an SVG layer that draws the edges.
 * Selecting a node lifts its id to `selectedId`, which the parent uses to highlight the matching actual-state
 * card across the split. On touch, one-finger drag pans (native scroll) and two fingers pinch-zoom. */

const { resources = [] } = defineProps<{ resources?: readonly ResourceView[] }>();
// Two-way: which node is selected (shared with the actual-state side to cross-highlight). null = none.
const selectedId = defineModel<string | null>({ default: null });

// Padding around the laid-out graph so edge curves + the first column aren't flush to the container.
const PAD = 16;

const layout = computed(() => layoutGraph(resources));

// Node ids whose brand logo failed to load (bad/renamed simple-icons slug) → fall back to the semantic glyph.
const logoFailed = reactive(new Set<string>());

// --- Pinch-zoom (touch only) -------------------------------------------------------------------
// Pan is native overflow-auto scroll; pinch scales the inner layer while a same-size spacer keeps the
// scrollable area correct, and scroll is nudged to hold the pinch's focal point steady.
const { coarse } = useDevice();
const scale = ref(1);
const viewport = ref<HTMLElement>();
const baseWidth = computed(() => layout.value.width + PAD * 2);
const baseHeight = computed(() => layout.value.height + PAD * 2);

// Active touch pointers by id → last client position; a pinch runs while exactly two are down.
const pointers = new Map<number, { x: number; y: number }>();
let pinchDist = 0;
let pinchScale = 1;

const distance = (): number => {
    const [a, b] = [...pointers.values()];
    if (a === undefined || b === undefined) {
        return 0;
    }
    return Math.hypot(a.x - b.x, a.y - b.y);
};

const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === `mouse`) {
        return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
        pinchDist = distance();
        pinchScale = scale.value;
    }
};

const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) {
        return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size !== 2 || pinchDist === 0) {
        return;
    }
    event.preventDefault(); // stop native page zoom while we drive the graph's own
    const el = viewport.value;
    const next = Math.max(0.4, Math.min(2, (pinchScale * distance()) / pinchDist));
    if (el === undefined) {
        scale.value = next;
        return;
    }
    // Hold the focal point (finger midpoint) fixed: find the unscaled content coord under it, then re-scroll
    // so that same content coord lands back under the fingers at the new scale.
    const rect = el.getBoundingClientRect();
    const [a, b] = [...pointers.values()];
    const focalX = ((a?.x ?? 0) + (b?.x ?? 0)) / 2 - rect.left;
    const focalY = ((a?.y ?? 0) + (b?.y ?? 0)) / 2 - rect.top;
    const contentX = (el.scrollLeft + focalX) / scale.value;
    const contentY = (el.scrollTop + focalY) / scale.value;
    scale.value = next;
    el.scrollLeft = contentX * next - focalX;
    el.scrollTop = contentY * next - focalY;
};

const onPointerUp = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) {
        pinchDist = 0;
    }
};

const toggle = (id: string): void => {
    selectedId.value = selectedId.value === id ? null : id;
};

// A forward cubic bézier from the dependency's right edge to the dependent's left edge.
const edgePath = (edge: GraphEdge): string => {
    const x0 = edge.start.x + PAD;
    const y0 = edge.start.y + PAD;
    const x1 = edge.end.x + PAD;
    const y1 = edge.end.y + PAD;
    const mid = (x0 + x1) / 2;
    return `M ${x0},${y0} C ${mid},${y0} ${mid},${y1} ${x1},${y1}`;
};

// Read-only hover summary that decodes the status dot and surfaces the drift reason at a glance.
const nodeSummary = (resource: ResourceView): string =>
    `${statusLabel(resource.status)}${resource.reason ? ` — ${resource.reason}` : ``} · ${resource.type} · ${resource.group}`;
</script>

<template>
    <div
        v-if="layout.nodes.length > 0"
        ref="viewport"
        class="scrollbar-thin overflow-auto"
        :style="coarse ? { touchAction: `pan-x pan-y` } : undefined"
        @pointerdown="coarse ? onPointerDown($event) : undefined"
        @pointermove="coarse ? onPointerMove($event) : undefined"
        @pointerup="coarse ? onPointerUp($event) : undefined"
        @pointercancel="coarse ? onPointerUp($event) : undefined"
    >
        <!-- Spacer sized to the scaled graph so the scroll area matches; the inner layer is the base-size
             graph transformed by `scale` from its top-left. -->
        <div :style="{ width: `${baseWidth * scale}px`, height: `${baseHeight * scale}px` }">
            <div class="relative origin-top-left" :style="{ width: `${baseWidth}px`, height: `${baseHeight}px`, transform: `scale(${scale})` }">
                <svg class="pointer-events-none absolute inset-0 text-subtle" :width="baseWidth" :height="baseHeight">
                    <path
                        v-for="edge in layout.edges"
                        :key="edge.from + '>' + edge.to"
                        :d="edgePath(edge)"
                        fill="none"
                        stroke="currentColor"
                        stroke-opacity="0.45"
                        stroke-width="1.5"
                    />
                </svg>
                <button
                    v-for="node in layout.nodes"
                    :key="node.id"
                    type="button"
                    v-tooltip.top="nodeSummary(node.resource)"
                    class="absolute flex items-center gap-2.5 overflow-hidden rounded-md border bg-canvas py-2 pl-3 pr-2.5 text-left transition-colors"
                    :class="node.id === selectedId ? 'border-link ring-1 ring-link' : 'border-line hover:border-line-strong'"
                    :style="{ left: `${node.x + PAD}px`, top: `${node.y + PAD}px`, width: `${node.width}px`, height: `${node.height}px` }"
                    @click="toggle(node.id)"
                >
                    <!-- Category stripe (left) — the coarse group, on its own layer so it coexists with the border/ring. -->
                    <span class="pointer-events-none absolute inset-y-0 left-0 w-0.5" :class="groupAccent(node.resource.group).bar"></span>
                    <!-- Framed icon: the product's brand logo when we know it, else the semantic glyph; tinted by group. -->
                    <span
                        class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border"
                        :class="groupAccent(node.resource.group).frame"
                    >
                        <img
                            v-if="resourceLogoUrl(node.resource.type) && !logoFailed.has(node.id)"
                            :src="resourceLogoUrl(node.resource.type)"
                            :alt="node.resource.type"
                            class="h-5 w-5 shrink-0 object-contain"
                            @error="logoFailed.add(node.id)"
                        />
                        <Icon v-else :name="resourceIcon(node.resource.type)" class="text-sm" />
                    </span>
                    <!-- Title over "type · group". -->
                    <span class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-sm font-medium leading-tight text-content">{{ node.resource.title }}</span>
                        <span class="truncate text-2xs leading-tight text-subtle">{{ node.resource.type }} · {{ node.resource.group }}</span>
                    </span>
                    <!-- Reconcile-status dot (right) — the axis orthogonal to category. -->
                    <span class="h-2 w-2 shrink-0 self-center rounded-full" :class="statusDot(node.resource.status)"></span>
                </button>
            </div>
        </div>
    </div>
    <p v-else class="py-6 text-center text-sm text-muted">No desired state yet. Declare backends in Configuration, then provision.</p>
</template>
