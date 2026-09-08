<!--
    Domain-agnostic, read-only DAG renderer: dagre positions nodes, Vue Flow pans/zooms. The `#node` slot fills each card; `#overlay` draws on top of
    the canvas. Caller must size this component (h-full w-full).
-->
<script setup lang="ts" generic="T">
import { VueFlow, BaseEdge, Handle, Position } from "@vue-flow/core";
import type { Edge, Node, VueFlowStore } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from "vue";
import { type DagEdge, type DagNode, laneKey, lanePath, layoutDag, layoutSignature } from "./dagLayout.js";

const {
    nodes,
    edges,
    nodeWidth = 208,
    nodeHeight = 64,
    direction = `LR`,
    magnify = true,
    minZoom = 0.4,
    readableZoom,
    edgeShape = `curve`,
    rankSep,
    nodeSep,
    fitAlign = `center`,
    fitPadding,
} = defineProps<{
    nodes: readonly DagNode<T>[];
    edges: readonly DagEdge[];
    // Layout box for a node without its own DagNode.width/.height.
    nodeWidth?: number;
    nodeHeight?: number;
    direction?: `LR` | `TB`;
    // Farthest the reader can zoom out by hand; also bounds `fitAll`.
    minZoom?: number;
    // Below this zoom, shows the graph's leading edge at this size instead of shrinking; undefined always fits.
    readableZoom?: number;
    // Scales an undersized graph to fill the viewport; disable on a full page, since fitView scales both axes.
    magnify?: boolean;
    // Use `elbow` for a layered pipeline with a reading order; `curve` for an undirected relation graph.
    edgeShape?: `curve` | `elbow`;
    // Spacing between columns, and cards within one; unset for the roomy default, tighter for row-list cards.
    rankSep?: number;
    nodeSep?: number;
    // Vertical anchor for the readable-zoom clamp: `start` pins to top for shallow bands, `center` for a full pane.
    fitAlign?: `center` | `start`;
    // Inset around the fitted picture as a fraction of the frame; `{x,y}` sets horizontal/vertical separately.
    fitPadding?: number | { readonly x: number; readonly y: number };
}>();

// Which node is selected; re-clicking the selected node clears it.
const selectedId = defineModel<string | undefined>();

defineSlots<{
    node(props: { node: DagNode<T>; selected: boolean }): unknown;
    // Drawn over the canvas; caller positions it (root is `relative`). Passes `fitAll` so a control can reach the
    // viewport without a generic component ref.
    overlay(props: { fitAll: () => void }): unknown;
}>();

// Unique per instance: Vue Flow scopes its injected state by id, and two graphs may share a page.
const flowId = useId();

// Single source for layout inputs; positions, lanes, and the refit signature must all read the same spacing.
const layoutOptions = computed(() => ({
    direction,
    nodeWidth,
    nodeHeight,
    ...(rankSep !== undefined ? { rankSep } : {}),
    ...(nodeSep !== undefined ? { nodeSep } : {}),
}));

// One layout run per render; nodes read positions from it, edges read lanes.
const placement = computed(() => layoutDag(nodes as readonly DagNode<never>[], edges, layoutOptions.value));

const flowNodes = computed<Node<DagNode<T>>[]>(() =>
    nodes.map((node) => ({
        id: node.id,
        type: `card`,
        position: placement.value.nodes.get(node.id) ?? { x: 0, y: 0 },
        data: node,
        style: { width: `${node.width ?? nodeWidth}px`, height: `${node.height ?? nodeHeight}px` },
    })),
);

const flowEdges = computed<Edge[]>(() => {
    const ids = new Set(nodes.map((node) => node.id));
    return edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .map((edge) => ({
            id: `${edge.from}>${edge.to}${edge.kind !== undefined ? `:${edge.kind}` : ``}`,
            source: edge.from,
            target: edge.to,
            type: edgeShape === `elbow` ? `lane` : `default`,
            data: { lane: placement.value.lanes.get(laneKey(edge.from, edge.to)) ?? [] },
            class: [
                edge.accent !== undefined ? `${edge.accent} dag-accent` : ``,
                edge.dashed === true ? `dag-dashed` : ``,
                edge.dimmed === true ? `dag-dimmed` : ``,
            ]
                .filter((cls) => cls !== ``)
                .join(` `),
        }));
});

const sourcePosition = computed(() => (direction === `LR` ? Position.Right : Position.Bottom));
const targetPosition = computed(() => (direction === `LR` ? Position.Left : Position.Top));

// Picture's bounding box in graph units, from each node's actual position and its own size, since that (not node count)
// decides whether a fit stays legible.
const extent = computed(() => {
    // `data` is optional on Vue Flow's node type; every node here always has one.
    const boxes = flowNodes.value.map((node) => ({
        ...node.position,
        width: node.data?.width ?? nodeWidth,
        height: node.data?.height ?? nodeHeight,
    }));
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    return {
        x: left,
        y: top,
        width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
        height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
    };
});

// Refits on a graph swap (patch, not remount), keyed on the layout signature, not node count, after nextTick.
// Undefined fit is Vue Flow's own default; the capped fit's padding matches DagEditor's, for consistent sizing.
const PADDING = 0.08;
const padOf = (): { x: number; y: number } => {
    const value = fitPadding ?? PADDING;
    return typeof value === `number` ? { x: value, y: value } : value;
};
// Zoom below which fitting the whole graph isn't worth it; kept under the readable floor for the clamped view.
const LEGIBLE_FIT = 0.45;
const FIT = computed(() => {
    const pad = padOf();
    return magnify ? undefined : { padding: pad, maxZoom: 1 };
});

// Shallow, not an optimization: ref()/reactive() would unwrap `dimensions` and break `store.dimensions.value`.
const flow = shallowRef<VueFlowStore>();
const root = ref<HTMLElement>();

// Blocks refitting once the reader has panned; `@move-start` fires only for a user transform, not our own fits.
let held = false;
const hold = (): void => {
    held = true;
};

// Applies the fit `readableZoom` describes, picking clamp vs. full fit from an estimate that mirrors Vue Flow's own
// zoom arithmetic.
const applyFit = (store: VueFlowStore): void => {
    const pad = padOf();
    if (readableZoom === undefined) {
        void store.fitView(FIT.value);
        return;
    }
    // Frame may be unmeasured yet; the plain fit is a no-op until boxes exist, retried by the resize observer.
    const frame = store.dimensions.value;
    const box = extent.value;
    if (frame === undefined || frame.width === 0 || frame.height === 0) {
        void store.fitView(FIT.value);
        return;
    }
    const fitted = Math.min(
        (frame.width * (1 - 2 * pad.x)) / box.width,
        (frame.height * (1 - 2 * pad.y)) / box.height,
        magnify ? 2 : 1,
    );
    const place = (zoom: number): void => {
        void store.setViewport({
            x: frame.width * pad.x - box.x * zoom,
            y: (fitAlign === `start` ? frame.height * pad.y : (frame.height - box.height * zoom) / 2) - box.y * zoom,
            zoom,
        });
    };
    // Skips fitView, which always centers vertically; placed manually to pin the leading edge at the top inset.
    if (fitAlign === `start`) {
        place(fitted >= Math.min(readableZoom, LEGIBLE_FIT) ? Math.min(fitted, 1) : readableZoom);
        return;
    }
    // The floor picks the clamped zoom; a lower bound decides whether to clamp at all, keeping legible fits full.
    if (fitted >= Math.min(readableZoom, LEGIBLE_FIT)) {
        if (typeof fitPadding === `object`) {
            place(Math.min(fitted, 1));
            return;
        }
        void store.fitView(FIT.value);
        return;
    }
    place(readableZoom);
};

// Fits the whole graph regardless of `readableZoom`: an explicit request to trade legibility for seeing everything at
// once.
const fitAll = (): void => {
    const pad = padOf();
    const padding = typeof pad === `number` ? pad : Math.max(pad.x, pad.y);
    void flow.value?.fitView({ padding, maxZoom: 1 });
};

// Single entry point back to a fitted view; guards the reader's own pan so nothing else re-fits over it.
const refit = (): void => {
    const store = flow.value;
    if (store === undefined || held) {
        return;
    }
    applyFit(store);
};

watch(
    () => layoutSignature(nodes as readonly DagNode<never>[], edges, layoutOptions.value),
    async () => {
        // A new graph replaces whatever the reader had panned to, so the pan hold is released and the graph refit.
        held = false;
        await nextTick();
        refit();
    },
);

// Applies the caller's fit options on ready, unlike `fit-view-on-init`, which always uses Vue Flow's default. Waits a
// tick since fitView needs each node's measured box first.
const onReady = async (store: VueFlowStore): Promise<void> => {
    flow.value = store;
    await nextTick();
    refit();
};

// Also refits on resize: a fit is valid only for its measured frame, and the store already has the new size.
let observer: ResizeObserver | undefined;
onBeforeUnmount(() => observer?.disconnect());
watch(root, (element) => {
    observer?.disconnect();
    if (element === undefined) {
        return;
    }
    observer = new ResizeObserver(() => refit());
    observer.observe(element);
});

const toggle = (id: string): void => {
    selectedId.value = selectedId.value === id ? undefined : id;
};
</script>

<template>
    <div ref="root" class="relative h-full w-full">
        <!--
            `elements-selectable` must stay true: Vue Flow gates pointer events on it, and with it false, clicks,
            hover, and tooltips inside #node all go dead.
        -->
        <VueFlow
            :id="flowId"
            class="dag-graph h-full w-full text-subtle"
            :nodes="flowNodes"
            :edges="flowEdges"
            :min-zoom="minZoom"
            :max-zoom="2"
            :nodes-draggable="false"
            :nodes-connectable="false"
            :elements-selectable="true"
            :zoom-on-double-click="false"
            @pane-ready="onReady"
            @nodes-initialized="refit()"
            @move-start="hold()"
        >
            <!--
                Elbow routing from dagre's own path (see lanePath), not the two endpoints; only used when `edgeShape`
                is `elbow`.
            -->
            <template #edge-lane="edge">
                <BaseEdge
                    :id="edge.id"
                    :path="lanePath({ x: edge.sourceX, y: edge.sourceY }, { x: edge.targetX, y: edge.targetY }, edge.data.lane)"
                />
            </template>
            <template #node-card="{ data }">
                <button
                    type="button"
                    v-tooltip.top="data.tooltip"
                    class="relative block h-full w-full overflow-hidden rounded-md border bg-canvas text-left transition-colors"
                    :class="data.id === selectedId ? `border-link ring-1 ring-link` : `border-line hover:border-line-strong`"
                    @click="toggle(data.id)"
                >
                    <Handle type="target" :position="targetPosition" />
                    <!--
                        Fades the interior only, not the card: opacity on the card itself would let an edge behind it
                        show through as a strikethrough.
                    -->
                    <div class="h-full w-full transition-opacity" :class="data.dimmed === true ? `opacity-45` : ``">
                        <slot name="node" :node="data" :selected="data.id === selectedId" />
                    </div>
                    <Handle type="source" :position="sourcePosition" />
                </button>
            </template>
        </VueFlow>
        <slot name="overlay" :fit-all="fitAll" />
    </div>
</template>

<style>
.dag-graph .vue-flow__edge-path {
    stroke: currentColor;
    stroke-opacity: 0.45;
    stroke-width: 1.5;
}
.dag-graph .vue-flow__edge.dag-accent .vue-flow__edge-path {
    stroke-opacity: 1;
}
.dag-graph .vue-flow__edge.dag-dashed .vue-flow__edge-path {
    stroke-dasharray: 6 4;
}
.dag-graph .vue-flow__edge.dag-dimmed {
    opacity: 0.35;
}
.dag-graph .vue-flow__handle {
    height: 1px;
    width: 1px;
    min-height: 0;
    min-width: 0;
    border: none;
    background: transparent;
    pointer-events: none;
}
</style>
