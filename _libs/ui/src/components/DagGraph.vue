<!-- Domain-agnostic DAG renderer: dagre positions the nodes (see dagLayout.ts), Vue Flow renders and
     interacts (pan, wheel + pinch zoom, fit-view). The caller's #node slot fills each card's interior;
     DagGraph owns the card chrome (border, selected ring, dimming) and the click-to-select toggle. Edges
     stroke with currentColor, so an edge's `accent` text-color class tints it and the container's default
     text-subtle colors the rest. The #overlay slot draws on top of the canvas (controls, legends) and is
     handed the actions a control needs. The parent must size this component (single root, h-full w-full). -->
<script setup lang="ts" generic="T">
import { VueFlow, Handle, Position } from "@vue-flow/core";
import type { Edge, Node, VueFlowStore } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import { computed, nextTick, ref, useId, watch } from "vue";
import { type DagEdge, type DagNode, layoutDag, layoutSignature } from "./dagLayout.js";

const {
    nodes,
    edges,
    nodeWidth = 208,
    nodeHeight = 64,
    direction = `LR`,
    magnify = true,
    minZoom = 0.4,
    readableZoom,
} = defineProps<{
    nodes: readonly DagNode<T>[];
    edges: readonly DagEdge[];
    // dagre lays out fixed-size nodes; the card wrapper is sized to exactly these.
    nodeWidth?: number;
    nodeHeight?: number;
    direction?: `LR` | `TB`;
    // How far the reader may zoom out by hand. Raise the ceiling on that (i.e. lower this) for a graph whose
    // whole shape is worth seeing even when the labels stop resolving — `fitAll` is bounded by it too.
    minZoom?: number;
    /* THE FIT'S LOWER BOUND, the way `magnify` is its upper one, and the answer to a diagram that technically
     * contains everything and can be read by nobody. `fitView` shrinks until the graph is inside the frame; on
     * a long chain that lands near 0.3, where a 12px label renders at four pixels and the picture is a row of
     * grey smudges. A fit no one can read is not a fit.
     *
     * Below this zoom, stop shrinking and show the graph's LEADING EDGE at exactly this size instead — the
     * start of a left-to-right flow is where a reader starts. The rest is one drag away, and `fitAll` (handed
     * to the #overlay slot) is there for the whole shape at a glance, deliberately and once. Leave it undefined
     * to always fit, which is right for a graph that is never bigger than its frame. */
    readableZoom?: number;
    /* Whether a graph SMALLER than the viewport is scaled up to fill it. True — the default — is right for
     * this component's usual caller, which gives it a band a couple of hundred pixels tall where filling the
     * height is what a reader wants.
     *
     * Pass false when the graph gets a whole page or a whole window. `fitView` scales in BOTH directions, so
     * a five-node run on a wide screen is magnified until it hits `max-zoom`: at 2× a 12px label renders at
     * 24px and the cards look like billboards. DagEditor caps its own fit for exactly this reason and says so
     * at length; this is that escape hatch, offered rather than imposed because the two caller shapes want
     * opposite answers. */
    magnify?: boolean;
}>();

// Which node is selected; re-clicking the selected node clears it.
const selectedId = defineModel<string | undefined>();

defineSlots<{
    node(props: { node: DagNode<T>; selected: boolean }): unknown;
    // Drawn over the canvas, positioned by the caller (the root is `relative`). `fitAll` is passed rather than
    // exposed on a template ref so a control can reach the viewport without the caller typing a generic
    // component instance.
    overlay(props: { fitAll: () => void }): unknown;
}>();

// Vue Flow scopes its injected state by id — unique per instance so two graphs can share a page.
const flowId = useId();

const flowNodes = computed<Node<DagNode<T>>[]>(() => {
    const positions = layoutDag(nodes as readonly DagNode<never>[], edges, { direction, nodeWidth, nodeHeight });
    return nodes.map((node) => ({
        id: node.id,
        type: `card`,
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: node,
        style: { width: `${nodeWidth}px`, height: `${nodeHeight}px` },
    }));
});

const flowEdges = computed<Edge[]>(() => {
    const ids = new Set(nodes.map((node) => node.id));
    return edges
        .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
        .map((edge) => ({
            id: `${edge.from}>${edge.to}${edge.kind !== undefined ? `:${edge.kind}` : ``}`,
            source: edge.from,
            target: edge.to,
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

// The picture's own bounding box in graph units — measured from where the nodes actually landed rather than
// guessed from their count, because it is what decides whether a fit can stay legible.
const extent = computed(() => {
    const boxes = flowNodes.value.map((node) => node.position);
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    return {
        x: left,
        y: top,
        width: Math.max(...boxes.map((box) => box.x + nodeWidth)) - left,
        height: Math.max(...boxes.map((box) => box.y + nodeHeight)) - top,
    };
});

/* Refit whenever a DIFFERENT graph arrives — `fit-view-on-init` only covers mount, and mount is not when this
 * usually happens. A caller that renders one DagGraph per page (a document's figures, keyed by position) has
 * Vue patch the same instance with new props rather than remount it, so the viewport transform survives from
 * the graph before it while the nodes underneath are replaced.
 *
 * Keyed on the layout SIGNATURE, not the node count: a count cannot tell two different graphs of the same size
 * apart, which is how a page could inherit the previous page's zoom. See layoutSignature for the failure that
 * produced. `nextTick` first because the container is often sized from the same render (a frame whose height
 * scales with node count), and fitView measures the container. */
// Undefined is Vue Flow's own default fit — the magnifying one, and what every caller had until `magnify`
// existed. The capped pair is DagEditor's, down to the padding: two components fitting the same kind of
// picture must not disagree about how much room it gets.
// DagEditor's padding, kept the same here so two components fitting the same kind of picture do not disagree
// about how much room it gets.
const PADDING = 0.08;
const FIT = computed(() => (magnify ? undefined : { padding: PADDING, maxZoom: 1 }));

const flow = ref<VueFlowStore>();

// The fit `readableZoom` describes: whichever of the two the graph's size calls for. The estimate mirrors
// Vue Flow's own arithmetic closely enough to pick a branch — the branch it picks then does the real work.
const applyFit = (store: VueFlowStore): void => {
    if (readableZoom === undefined) {
        void store.fitView(FIT.value);
        return;
    }
    const frame = store.dimensions.value;
    const box = extent.value;
    const fitted = Math.min((frame.width * (1 - 2 * PADDING)) / box.width, (frame.height * (1 - 2 * PADDING)) / box.height, magnify ? 2 : 1);
    if (fitted >= readableZoom) {
        void store.fitView(FIT.value);
        return;
    }
    void store.setViewport({
        x: frame.width * PADDING - box.x * readableZoom,
        y: (frame.height - box.height * readableZoom) / 2 - box.y * readableZoom,
        zoom: readableZoom,
    });
};

// The whole shape at a glance, floor and all — what a "fit" control is for, and why it ignores `readableZoom`:
// asking to see everything is asking to trade legibility for it, deliberately and for as long as you look.
const fitAll = (): void => void flow.value?.fitView({ padding: PADDING });

watch(
    () => layoutSignature(nodes as readonly DagNode<never>[], edges, { direction, nodeWidth, nodeHeight }),
    async () => {
        await nextTick();
        const store = flow.value;
        if (store !== undefined) {
            applyFit(store);
        }
    },
);

// Not `fit-view-on-init`: that runs Vue Flow's own fit with default options, which is the magnifying one
// whatever this component was asked for. Fitting on ready is the same moment with the caller's answer applied.
const onReady = async (store: VueFlowStore): Promise<void> => {
    flow.value = store;
    await nextTick();
    applyFit(store);
};

const toggle = (id: string): void => {
    selectedId.value = selectedId.value === id ? undefined : id;
};
</script>

<template>
    <div class="relative h-full w-full">
        <!-- `elements-selectable` is TRUE even though this component keeps its own selection and wants none of Vue
             Flow's, and that is not a preference — it is what makes the nodes touchable at all. A node wrapper
             takes pointer events only when something could want them (NodeWrapper's `hasPointerEvents`:
             `isSelectable || isDraggable || any node listener`), and with all of those off Vue Flow writes
             `pointer-events: none` onto every node. Which made the card below inert: the click-to-select this
             component advertises never fired, its own hover border never lit, its tooltip never opened, and
             nothing a caller drew in the #node slot could be hovered either. It rendered as a picture. DagEditor
             has always passed true, which is why the designer's canvas worked and this never did. -->
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
        >
            <template #node-card="{ data }">
                <button
                    type="button"
                    v-tooltip.top="data.tooltip"
                    class="relative block h-full w-full overflow-hidden rounded-md border bg-canvas text-left transition-[colors,opacity]"
                    :class="[
                        data.id === selectedId ? `border-link ring-1 ring-link` : `border-line hover:border-line-strong`,
                        data.dimmed === true ? `opacity-30` : ``,
                    ]"
                    @click="toggle(data.id)"
                >
                    <Handle type="target" :position="targetPosition" />
                    <slot name="node" :node="data" :selected="data.id === selectedId" />
                    <Handle type="source" :position="sourcePosition" />
                </button>
            </template>
        </VueFlow>
        <slot name="overlay" :fit-all="fitAll" />
    </div>
</template>

<style>
/* Edge chrome mirrors the pre-Vue-Flow look: 1.5px currentColor curves at 0.45 opacity, full-strength when
   accent-tinted. Handles exist only as edge anchors — invisible and inert. */
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
    opacity: 0.15;
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
