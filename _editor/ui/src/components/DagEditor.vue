<!-- THE EDITABLE DAG: DagGraph's counterpart, and the two exist apart on purpose.

     DagGraph is a domain-agnostic READ-ONLY renderer: it switches Vue Flow's interactivity off wholesale
     (`nodes-draggable`, `nodes-connectable`, `elements-selectable` all false) and five surfaces depend on it
     doing exactly that. Threading an `editable` mode back through it would blur that contract and put those
     five at risk to serve one caller. So this is a sibling, and what the two SHARE is the thing that must
     never disagree: `dagLayout.ts`, the positions and the layout signature. Draw the same graph in both and
     you get the same picture.

     WHAT IT ADDS OVER ITS SIBLING, and nothing else: a handle you can drag an edge out of, selectable nodes
     AND edges, an add affordance on the trailing handle, and a canvas you can see the extent of (dots,
     zoom controls). No new dependency: `@vue-flow/core` has carried all of this since it arrived, and the
     optional add-on packages it publishes for the background and the controls are a CSS gradient and three
     buttons, which is what they are here.

     NODES ARE NOT DRAGGABLE, AND THAT IS THE DESIGN RATHER THAN A GAP. In a graph whose edges ARE the
     dependencies, a node's position is DERIVED: dagre knows where it goes. Letting it be hand-placed means
     every step you add makes the arrangement you chose slightly wrong, and tidying becomes a permanent chore
     that buys the reader nothing a layout engine was not already giving them for free. Dragging is therefore
     spent on the one thing position cannot express: dragging FROM a handle draws an edge.

     The parent must size this component (single root, h-full w-full), same as DagGraph. -->
<script setup lang="ts" generic="T">
import { Handle, Panel, Position, VueFlow } from "@vue-flow/core";
import type { Connection, Edge, Node, VueFlowStore } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { type DagEdge, type DagNode, layoutDag, layoutSignature } from "./dagLayout.js";
import Icon from "./Icon.vue";

const {
    nodes,
    edges,
    nodeWidth = 208,
    nodeHeight = 64,
    direction = `LR`,
    addLabel,
} = defineProps<{
    nodes: readonly DagNode<T>[];
    edges: readonly DagEdge[];
    // dagre lays out fixed-size nodes; the card wrapper is sized to exactly these.
    nodeWidth?: number;
    nodeHeight?: number;
    direction?: `LR` | `TB`;
    /* The tooltip on each node's add button. Absent ⇒ no add button: this component is an editor, but "you
     * may add a node from here" is the caller's fact, not ours. */
    addLabel?: string;
}>();

// Which node is selected; re-clicking the selected node clears it. Shared with DagGraph so a caller can move
// a selection between the two without re-learning it.
const selectedId = defineModel<string | undefined>();

const emit = defineEmits<{
    // A new dependency, drawn by dragging a handle onto another node. Vue Flow guarantees both ids exist; it
    // does NOT guarantee the result is acyclic, so the caller validates and may refuse.
    connect: [from: string, to: string];
    // An edge the reader picked. Deleting or re-typing it is the caller's business: this only says which.
    selectEdge: [from: string, to: string];
    // The add button on a node's trailing handle: "give me a new node downstream of this one".
    add: [from: string];
}>();

defineSlots<{ node(props: { node: DagNode<T>; selected: boolean }): unknown }>();

// Vue Flow scopes its injected state by id: unique per instance so two graphs can share a page.
const flowId = useId();

// Which edge is picked, as its endpoint pair. Kept locally rather than modelled: an edge selection is a
// transient act (pick it, retype it, it is gone), while a NODE selection drives a whole inspector panel.
const pickedEdge = ref<string>();
const edgeKey = (from: string, to: string): string => `${from}>${to}`;

const flowNodes = computed<Node<DagNode<T>>[]>(() => {
    const { nodes: positions } = layoutDag(nodes as readonly DagNode<never>[], edges, { direction, nodeWidth, nodeHeight });
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
            // Fatter than DagGraph's, because here an edge is a TARGET: a 1.5px curve is not something a mouse
            // can reasonably be asked to hit. The stroke stays thin; `interactionWidth` is the invisible
            // hit area around it.
            interactionWidth: 20,
            class: [
                edge.accent !== undefined ? `${edge.accent} dag-accent` : ``,
                edge.dashed === true ? `dag-dashed` : ``,
                edge.dimmed === true ? `dag-dimmed` : ``,
                pickedEdge.value === edgeKey(edge.from, edge.to) ? `dag-picked` : ``,
            ]
                .filter((cls) => cls !== ``)
                .join(` `),
        }));
});

const sourcePosition = computed(() => (direction === `LR` ? Position.Right : Position.Bottom));
const targetPosition = computed(() => (direction === `LR` ? Position.Left : Position.Top));

/* FITTING NEVER MAGNIFIES, and this is the single most visible difference from DagGraph.
 *
 * `fitView` scales the graph to fill the viewport in BOTH directions, so on a canvas this large a one- or
 * two-node graph is scaled UP until it hits `maxZoom`: at 2×, a 12px label renders at 24px and the cards
 * look like billboards. That is not a hypothetical: it is what a two-step workflow looked like. Capping the
 * FIT at 1 means a small graph sits at its natural size in the corner of a big canvas, which is the honest
 * picture, and the reader can still zoom in past it by hand.
 *
 * DagGraph does not need this because its callers give it a band a couple of hundred pixels tall, where
 * filling the height is the right answer. Give the same component a full page and it stops being.
 */
// `padding` is a fraction of the VIEWPORT applied on each side, so 0.2 spends 40% of the width on margin and
// a four-step chain lands at 0.74 zoom with labels too small to read. 0.08 leaves the graph room to breathe
// without paying for it in legibility, which is the thing a canvas is for.
const FIT = { padding: 0.08, maxZoom: 1 } as const;

const flow = ref<VueFlowStore>();

/* THE READER HAS TAKEN HOLD of the viewport: DagGraph's rule, and it matters more on a canvas somebody is
 * working on: `@move-start` fires only for a real gesture (Vue Flow returns before emitting it when the
 * transform came from code), and from that moment nothing below fits over where they panned to. */
let held = false;
const hold = (): void => {
    held = true;
};

const refit = (): void => {
    if (held) {
        return;
    }
    void flow.value?.fitView(FIT);
};

let observer: ResizeObserver | undefined;
onBeforeUnmount(() => observer?.disconnect());

/* Refit whenever a DIFFERENT graph arrives: the same rule and the same reasoning as DagGraph's, keyed on the
 * layout signature rather than the node count so two different graphs of one size cannot be mistaken for each
 * other. It earns its place harder here: the graph changes on every edit, and a canvas that let a new node
 * land outside the viewport would look like the click did nothing, which is also why an edit RELEASES the
 * hold: the picture the reader had chosen a place in is not the picture any more. */
watch(
    () => layoutSignature(nodes as readonly DagNode<never>[], edges, { direction, nodeWidth, nodeHeight }),
    async () => {
        held = false;
        await nextTick();
        refit();
    },
);

/* Not `fit-view-on-init`: that runs Vue Flow's own fit with default options, which is exactly the magnifying
 * one. Fitting on ready instead is the same moment with our cap applied, and the two hooks beside it are what
 * make the fit hold: `nodes-initialized`, because `fitView` does NOTHING while no node has been measured yet
 * (a graph mounted a moment after its page loses that race and is left at 1× in the corner), and the observer,
 * because the canvas is resized every time the inspector opens beside it. DagGraph carries the long version. */
const onReady = async (store: VueFlowStore): Promise<void> => {
    flow.value = store;
    await nextTick();
    refit();
    const element = store.vueFlowRef.value;
    if (element !== null) {
        observer = new ResizeObserver(() => refit());
        observer.observe(element);
    }
};

const toggle = (id: string): void => {
    pickedEdge.value = undefined;
    selectedId.value = selectedId.value === id ? undefined : id;
};

const onConnect = (connection: Connection): void => {
    if (connection.source !== connection.target) {
        emit(`connect`, connection.source, connection.target);
    }
};

const onEdgeClick = (edge: Edge): void => {
    pickedEdge.value = edgeKey(edge.source, edge.target);
    emit(`selectEdge`, edge.source, edge.target);
};

// Clicking the empty canvas clears both selections: the ordinary "nothing is picked" gesture, and the only
// way to close an inspector without hunting for an ×.
const onPaneClick = (): void => {
    pickedEdge.value = undefined;
    selectedId.value = undefined;
};

// Fit is the ONLY control, because it is the only one with no gesture behind it: Vue Flow already gives wheel
// and pinch zoom and drag-to-pan for free. A +/− pair beside them would be three buttons where one is needed.
const fit = (): void => void flow.value?.fitView(FIT);
</script>

<template>
    <VueFlow
        :id="flowId"
        class="dag-editor h-full w-full text-subtle"
        :nodes="flowNodes"
        :edges="flowEdges"
        :min-zoom="0.4"
        :max-zoom="2"
        :nodes-draggable="false"
        :nodes-connectable="true"
        :elements-selectable="true"
        :zoom-on-double-click="false"
        :connection-radius="30"
        @pane-ready="onReady"
        @nodes-initialized="refit()"
        @move-start="hold()"
        @connect="onConnect"
        @edge-click="onEdgeClick($event.edge)"
        @pane-click="onPaneClick"
    >
        <template #node-card="{ data }">
            <div
                class="group/node relative h-full w-full rounded-md border bg-canvas text-left transition-[colors,opacity]"
                :class="[
                    data.id === selectedId ? `border-link ring-1 ring-link` : `border-line hover:border-line-strong`,
                    data.dimmed === true ? `opacity-30` : ``,
                ]"
            >
                <!-- The card's whole face is the select target; the handles and the add button sit over it.

                     IT IS `relative` AND ROUNDED, AND BOTH ARE LOAD-BEARING RATHER THAN COSMETIC. A card's slot
                     content may position something against the card's own edge: the workflow card's status
                     stripe runs down the leading edge, and an `overflow-hidden` on a STATIC element does not
                     clip a descendant whose containing block is an ancestor of it. Without `relative` here that
                     stripe resolved against the FRAME instead, escaped this clip entirely, and painted its
                     square corners over the frame's rounded ones: two dark notches at the top and bottom of the
                     leading edge, obvious the moment a selected card put a ring behind them.

                     THE RADIUS IS DERIVED, NOT TYPED. This button fills the frame's PADDING box, which curves
                     one border-width tighter than the frame's own `rounded-md`, so the clip is that token
                     minus the 1px border, and it stays right if either ever changes. Writing the number instead
                     is how it went wrong the first time: `rounded-md` is 0.5rem against a root the app scales,
                     which is 8.8px here and not the 6 it looks like in the stylesheet.

                     DagGraph never had any of this because its card is ONE element: border, rounding and clip
                     on the same box, so the browser reconciles them itself. -->
                <button
                    type="button"
                    v-tooltip.top="data.tooltip"
                    class="relative block h-full w-full overflow-hidden rounded-[calc(var(--radius-md)-1px)] text-left"
                    @click="toggle(data.id)"
                >
                    <slot name="node" :node="data" :selected="data.id === selectedId" />
                </button>
                <Handle type="target" :position="targetPosition" class="dag-editor-handle" />
                <Handle type="source" :position="sourcePosition" class="dag-editor-handle" />
                <!-- The one-click chain. It sits ON the trailing handle because that is where the same action's
                     drag gesture starts: one affordance, two ways to use it, and the cheap way is the default.

                     IT IS PAINTED IN THE ACTION COLOUR, and that is a contrast fix rather than a decoration.
                     It used to be `border-line` on `bg-canvas`: a ring at 1.42:1 in dark and 1.20:1 in light
                     against the surface behind it, where WCAG's floor for the boundary of a control is 3:1, and
                     a fill IDENTICAL to that surface, so the chip had no figure/ground at all. People reported
                     hovering a node and not finding it, which is exactly what those numbers predict. No neutral
                     in this palette can carry the job: `line-strong`, the darkest line token, still only reaches
                     2.10:1/1.40:1. The accent does (8.42:1/4.29:1), and a button that chains a step IS the
                     canvas's primary action, so it is the honest colour as well as the legible one.

                     24px rather than 20 for the same reason on the other axis: SC 2.5.8's minimum target. And it
                     answers focus, not only hover: revealed by `group-hover` alone, it was a control a keyboard
                     could reach and never see. -->
                <button
                    v-if="addLabel !== undefined"
                    type="button"
                    v-tooltip.top="addLabel"
                    :aria-label="addLabel"
                    class="absolute z-10 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border border-link bg-card text-2xs text-link opacity-0 shadow-sm transition hover:bg-link hover:text-fill-content focus-visible:opacity-100 group-hover/node:opacity-100"
                    :class="direction === `LR` ? `-right-3 top-1/2 -translate-y-1/2` : `-bottom-3 left-1/2 -translate-x-1/2`"
                    @click.stop="emit(`add`, data.id)"
                >
                    <Icon name="plus" />
                </button>
            </div>
        </template>

        <Panel position="bottom-right">
            <button type="button" v-tooltip.top="`Fit the whole graph`" aria-label="Fit the whole graph" class="dag-editor-control" @click="fit()">
                <Icon name="expand" />
            </button>
        </Panel>
    </VueFlow>
</template>

<style>
/* Edge chrome matches DagGraph's, so the same graph reads the same in both: plus the two states only an
   editable canvas has: a picked edge, and a handle you are meant to be able to grab. */
.dag-editor .vue-flow__edge-path {
    stroke: currentColor;
    stroke-opacity: 0.45;
    stroke-width: 1.5;
}
.dag-editor .vue-flow__edge.dag-accent .vue-flow__edge-path {
    stroke-opacity: 1;
}
.dag-editor .vue-flow__edge.dag-dashed .vue-flow__edge-path {
    stroke-dasharray: 6 4;
}
.dag-editor .vue-flow__edge.dag-dimmed {
    opacity: 0.15;
}
.dag-editor .vue-flow__edge:hover .vue-flow__edge-path {
    stroke-opacity: 1;
}
.dag-editor .vue-flow__edge.dag-picked .vue-flow__edge-path {
    stroke: var(--color-link);
    stroke-opacity: 1;
    stroke-width: 2;
}
/* Unlike DagGraph's inert anchors these are grab targets, so they are visible and hit-testable, but only
   once the pointer is on the card. A canvas that shows every handle at rest reads as a circuit diagram.

   A SOLID DOT, NOT A HOLLOW RING. Hollow, it was a 1px `line-strong` outline on a `canvas` fill: 2.10:1 in
   dark and 1.40:1 in light against the surface it sits on, well under the 3:1 a control's boundary owes the
   reader, and the fill was the surface, so a "visible" handle was a dot you had to already know was there.
   Filled in `subtle` it clears the floor in both schemes (4.52:1 / 4.05:1) with the same 8px footprint, and
   the canvas-coloured halo keeps it legible whether it lands on the card's edge or on the dotted pane. */
.dag-editor .vue-flow__handle {
    height: 8px;
    width: 8px;
    min-height: 0;
    min-width: 0;
    border: none;
    background: var(--color-subtle);
    box-shadow: 0 0 0 2px var(--color-canvas);
    opacity: 0;
    transition:
        opacity 120ms,
        background-color 120ms;
}
.dag-editor .group\/node:hover .vue-flow__handle,
.dag-editor .vue-flow__handle.connectionindicator:hover {
    opacity: 1;
}
/* Under the pointer it becomes the thing an edge will be drawn in, which is the only preview of the gesture
   there is before the drag starts. */
.dag-editor .vue-flow__handle.connectionindicator:hover {
    background: var(--color-link);
}
.dag-editor .vue-flow__connectionline path {
    stroke: var(--color-link);
    stroke-width: 2;
}
/* The canvas's own extent, so panning reads as movement rather than as nothing happening. The published
   @vue-flow/background package draws this with an SVG pattern; one gradient is the same picture. */
.dag-editor .vue-flow__pane {
    background-image: radial-gradient(circle, var(--color-line) 1px, transparent 1px);
    background-size: 18px 18px;
}
.dag-editor-control {
    display: flex;
    height: 1.5rem;
    width: 1.5rem;
    cursor: pointer;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    border: 1px solid var(--color-line);
    background: var(--color-canvas);
    font-size: 0.625rem;
    color: var(--color-subtle);
}
.dag-editor-control:hover {
    border-color: var(--color-line-strong);
    color: var(--color-content);
}
</style>
