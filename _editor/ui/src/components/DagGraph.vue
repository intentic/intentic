<!-- Domain-agnostic DAG renderer: dagre positions the nodes (see dagLayout.ts), Vue Flow renders and
     interacts (pan, wheel + pinch zoom, fit-view). The caller's #node slot fills each card's interior;
     DagGraph owns the card chrome (border, selected ring, dimming) and the click-to-select toggle. Edges
     stroke with currentColor, so an edge's `accent` text-color class tints it and the container's default
     text-subtle colors the rest. The #overlay slot draws on top of the canvas (controls, legends) and is
     handed the actions a control needs. The parent must size this component (single root, h-full w-full). -->
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
    // The box dagre lays a node out at and the card wrapper is sized to, for every node that does not carry
    // its own (DagNode.width / .height, which is how a compound card is as tall as the rows inside it).
    nodeWidth?: number;
    nodeHeight?: number;
    direction?: `LR` | `TB`;
    // How far the reader may zoom out by hand. Raise the ceiling on that (i.e. lower this) for a graph whose
    // whole shape is worth seeing even when the labels stop resolving: `fitAll` is bounded by it too.
    minZoom?: number;
    /* THE FIT'S LOWER BOUND, the way `magnify` is its upper one, and the answer to a diagram that technically
     * contains everything and can be read by nobody. `fitView` shrinks until the graph is inside the frame; on
     * a long chain that lands near 0.3, where a 12px label renders at four pixels and the picture is a row of
     * grey smudges. A fit no one can read is not a fit.
     *
     * Below this zoom, stop shrinking and show the graph's LEADING EDGE at exactly this size instead: the
     * start of a left-to-right flow is where a reader starts. The rest is one drag away, and `fitAll` (handed
     * to the #overlay slot) is there for the whole shape at a glance, deliberately and once. Leave it undefined
     * to always fit, which is right for a graph that is never bigger than its frame. */
    readableZoom?: number;
    /* Whether a graph SMALLER than the viewport is scaled up to fill it. True (the default) is right for
     * this component's usual caller, which gives it a band a couple of hundred pixels tall where filling the
     * height is what a reader wants.
     *
     * Pass false when the graph gets a whole page or a whole window. `fitView` scales in BOTH directions, so
     * a five-node run on a wide screen is magnified until it hits `max-zoom`: at 2× a 12px label renders at
     * 24px and the cards look like billboards. DagEditor caps its own fit for exactly this reason and says so
     * at length; this is that escape hatch, offered rather than imposed because the two caller shapes want
     * opposite answers. */
    magnify?: boolean;
    /* HOW AN EDGE IS DRAWN, which on a layered graph is not a matter of taste. A bezier leaves its node at an
     * angle and takes its own line across the canvas, so a run where a dozen edges span three ranks draws a
     * dozen curves that splay apart and cross in the middle: the spaghetti a reader sees before they have read
     * one label, and the thing they mean by "messy".
     *
     * `elbow` routes the way every CI vendor's own graph does: a stub out of the source, one vertical run, a
     * stub into the target, corners rounded. Parallel edges then SHARE their horizontals instead of fanning,
     * a long span reads as a straight line rather than a swoop, and a crossing is a crossing rather than noise.
     *
     * Offered rather than imposed because the two shapes of caller want opposite answers: a layered pipeline is
     * a flow to be followed, while a graph of relations (a note's links, a package's dependents) has no reading
     * order for elbows to reinforce, and there a curve is the gentler line. */
    edgeShape?: `curve` | `elbow`;
    // How much air between two columns, and between two cards in one (see DagLayoutOptions). Leave them off for
    // the roomy default, which suits a graph of few large cards; a card that is a LIST of rows wants both tighter.
    rankSep?: number;
    nodeSep?: number;
    /* Where a readable-zoom clamp lands vertically. `start` keeps shallow inline bands from floating with empty
     * space above and below; `center` is the default for a graph given a whole pane. */
    fitAlign?: `center` | `start`;
    // Inset around the fitted picture, as a fraction of the frame. `{ x, y }` when horizontal and vertical need
    // different air — shallow inline bands want a tight top/bottom.
    fitPadding?: number | { readonly x: number; readonly y: number };
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

// Vue Flow scopes its injected state by id: unique per instance so two graphs can share a page.
const flowId = useId();

// Everything the layout is asked for, in one place: the two components that read it (positions and lanes, and
// the refit signature) must never disagree about the spacing.
const layoutOptions = computed(() => ({
    direction,
    nodeWidth,
    nodeHeight,
    ...(rankSep !== undefined ? { rankSep } : {}),
    ...(nodeSep !== undefined ? { nodeSep } : {}),
}));

// One layout run per render, read by the nodes for their positions and by the edges for their lanes.
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

// The picture's own bounding box in graph units: measured from where the nodes actually landed rather than
// guessed from their count, because it is what decides whether a fit can stay legible. Each node contributes
// its OWN box, not the caller's default: a card that overrode its height is the one most likely to be the
// thing hanging over the edge of a fit measured without it.
const extent = computed(() => {
    // `data` is optional on Vue Flow's own node type, though every node above is built with one.
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

/* Refit whenever a DIFFERENT graph arrives: `fit-view-on-init` only covers mount, and mount is not when this
 * usually happens. A caller that renders one DagGraph per page (a document's figures, keyed by position) has
 * Vue patch the same instance with new props rather than remount it, so the viewport transform survives from
 * the graph before it while the nodes underneath are replaced.
 *
 * Keyed on the layout SIGNATURE, not the node count: a count cannot tell two different graphs of the same size
 * apart, which is how a page could inherit the previous page's zoom. See layoutSignature for the failure that
 * produced. `nextTick` first because the container is often sized from the same render (a frame whose height
 * scales with node count), and fitView measures the container. */
// Undefined is Vue Flow's own default fit: the magnifying one, and what every caller had until `magnify`
// existed. The capped pair is DagEditor's, down to the padding: two components fitting the same kind of
// picture must not disagree about how much room it gets.
// DagEditor's padding, kept the same here so two components fitting the same kind of picture do not disagree
// about how much room it gets.
const PADDING = 0.08;
const padOf = (): { x: number; y: number } => {
    const value = fitPadding ?? PADDING;
    return typeof value === `number` ? { x: value, y: value } : value;
};
/* The zoom below which a whole-graph fit stops being worth having. Above it, fitting everything wins over
 * showing part of it larger (see applyFit).
 *
 * Deliberately well under the readable floor rather than just under it. The floor is what a CLAMPED view is
 * drawn at, and it is set where a label is comfortable; this is the different question of when a whole picture
 * stops being worth seeing at all, and the honest answer is much lower. A run needing 0.46 to fit its own
 * dialog was refused at 0.55 and clipped instead — a diagram overflowing a frame it plainly had room for. */
const LEGIBLE_FIT = 0.45;
const FIT = computed(() => {
    const pad = padOf();
    return magnify ? undefined : { padding: pad, maxZoom: 1 };
});

/* SHALLOW, and that is not an optimization: `ref()` deep-reactivates what it holds, and `reactive()` UNWRAPS
 * the refs it finds, so a store parked in a plain ref hands back `dimensions` as a bare `{width, height}` while
 * its own types still promise `Ref<Dimensions>`. `store.dimensions.value` then reads `undefined` at runtime and
 * type-checks perfectly, which is exactly how `readableZoom` came to be dead code: `applyFit` read the frame as
 * unmeasured, took the fallback every single time, and every graph in the app fitted the magnifying way it was
 * asked not to. The store is an external object with its own reactivity; this ref only has to hold it. */
const flow = shallowRef<VueFlowStore>();
const root = ref<HTMLElement>();

/* THE READER HAS TAKEN HOLD, and from here the viewport is theirs: nothing below fits over it. `@move-start`
 * says exactly that and only that: Vue Flow returns before emitting it when the transform came from code (no
 * `sourceEvent`), so our own fits can never trip it. The same rule ImageView keeps for a hand-zoomed image. */
let held = false;
const hold = (): void => {
    held = true;
};

// The fit `readableZoom` describes: whichever of the two the graph's size calls for. The estimate mirrors
// Vue Flow's own arithmetic closely enough to pick a branch: the branch it picks then does the real work.
const applyFit = (store: VueFlowStore): void => {
    const pad = padOf();
    if (readableZoom === undefined) {
        void store.fitView(FIT.value);
        return;
    }
    /* THE FRAME MAY NOT BE MEASURED YET, and reaching into it when it isn't took the whole view down with a
     * `Cannot read properties of undefined (reading 'width')`. Vue Flow populates `dimensions` from its own
     * observer, so a graph mounted into a container that has just appeared: a tab switched to, a pane
     * revealed: can be ready before it has been measured. The graph mounted WITH its page (every caller until
     * one wasn't) always won that race, which is why this only ever crashed for the one that didn't.
     *
     * Falling back to the plain fit is the right answer rather than a guard: `fitView` is itself a no-op until
     * the boxes exist, and the resize observer below calls back the moment they do: at which point this runs
     * again with a real frame and applies the readable fit properly. */
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
    /* TOP-ALIGNED INLINE BANDS never call `fitView`: it always centres vertically, which leaves a shallow run
     * floating in a band sized for it. Manual placement keeps the leading edge at the top inset instead. */
    if (fitAlign === `start`) {
        place(fitted >= Math.min(readableZoom, LEGIBLE_FIT) ? Math.min(fitted, 1) : readableZoom);
        return;
    }
    /* SHOWING EVERYTHING BEATS SHOWING IT SLIGHTLY LARGER, and this used to trade the wrong way round.
     *
     * The floor exists for the fit that lands near 0.3, where the labels stop being letters. It was applied as
     * an exact threshold, so a graph that needed 0.78 to fit was refused it, clamped to 0.8, and one card
     * pushed out of frame to gain two per cent of glyph — a diagram that visibly does not fit inside a frame it
     * plainly had room for, which is the first thing anyone opening the view notices.
     *
     * So the floor keeps deciding what zoom a CLAMPED view uses, and a separate, lower bound decides WHETHER to
     * clamp at all: anything that fits and can still be read is fitted. `min` so a caller asking for a lower
     * floor than this is never held to a higher one. */
    if (fitted >= Math.min(readableZoom, LEGIBLE_FIT)) {
        void store.fitView(FIT.value);
        return;
    }
    place(readableZoom);
};

// The whole shape at a glance, floor and all: what a "fit" control is for, and why it ignores `readableZoom`:
// asking to see everything is asking to trade legibility for it, deliberately and for as long as you look.
const fitAll = (): void => void flow.value?.fitView({ padding: padOf(), maxZoom: 1 });

// The one door back to a fitted picture: everything that can invalidate a fit calls this, and it is the only
// place the reader's own pan is protected from being fitted over.
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
        // A DIFFERENT graph is not the reader's view any more: whatever they had panned to was a place in the
        // picture this one replaced, so the hold is released with it and the new graph is fitted.
        held = false;
        await nextTick();
        refit();
    },
);

/* Not `fit-view-on-init`: that runs Vue Flow's own fit with default options, which is the magnifying one
 * whatever this component was asked for. Fitting on ready is the same moment with the caller's answer applied.
 *
 * WHY READY IS NOT ENOUGH ON ITS OWN, and this is the defect that left one card's diagram in the corner of its own
 * frame while the card under it was drawn perfectly: `fitView` reads each node's MEASURED box, and while none
 * of them has one it does nothing at all: returns false, leaves the viewport at the identity transform, and
 * is never asked again. Boxes are measured by an observer, so whether they are in by `pane-ready` is a RACE: a
 * graph mounted with the page usually wins it, one mounted a moment later (a list that arrived from the daemon,
 * a card a query revealed) usually loses. `nodes-initialized` is Vue Flow saying the boxes are in, which is the
 * first moment a fit can mean anything. */
const onReady = async (store: VueFlowStore): Promise<void> => {
    flow.value = store;
    await nextTick();
    refit();
};

/* AND AGAIN WHENEVER THE FRAME CHANGES SIZE, because a fit is a statement about the frame it was measured in.
 * Open the chat column beside a page of cards, resize the window, or reveal a pane that mounted hidden, and
 * every picture on it is still transformed for the frame it no longer has: off-centre, or spilling out of its
 * own box and clipped. Vue Flow observes this same element for its `dimensions` and registers first (a child's
 * onMounted runs before its parent's), so the store already knows the new size when this runs. */
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
        <!-- `elements-selectable` is TRUE even though this component keeps its own selection and wants none of Vue
             Flow's, and that is not a preference: it is what makes the nodes touchable at all. A node wrapper
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
            @nodes-initialized="refit()"
            @move-start="hold()"
        >
            <!-- The lane shape, drawn from dagre's own routing rather than from the two endpoints (see
                 lanePath). Only reached when the caller asked for `elbow`; a `curve` graph never names it. -->
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
                    <!-- THE CONTENT FADES, NOT THE CARD, and the difference is visible the moment a highlight is
                         drawn: `opacity` on the box makes its BACKGROUND translucent too, so an edge running
                         behind a faded card showed through the middle of its text as a strikethrough, on exactly
                         the long spans a trace lights up. Fading the interior leaves the card opaque, which is
                         what a card is for.

                         Faded, not hidden: a highlight is only useful if the run it is picked out of is still
                         readable beside it. At 0.3 the rest of a dark-canvas graph went to a smear of grey on
                         grey, so tracing one job cost you the picture it was in. -->
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
/* Edge chrome mirrors the pre-Vue-Flow look: 1.5px currentColor curves at 0.45 opacity, full-strength when
   accent-tinted. Handles exist only as edge anchors: invisible and inert. */
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
