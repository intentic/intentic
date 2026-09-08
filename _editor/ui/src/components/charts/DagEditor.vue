<!--
    Editable counterpart to <DagGraph>; both share dagLayout.ts so they draw the same graph. Adds edge-drag handles, selectable nodes/edges and an
    add affordance; node position stays derived from dagre and is not draggable. Caller must size this component (h-full w-full).
-->
<script setup lang="ts" generic="T">
import { Handle, Panel, Position, VueFlow } from "@vue-flow/core";
import type { Connection, Edge, Node, VueFlowStore } from "@vue-flow/core";
import "@vue-flow/core/dist/style.css";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { type DagEdge, type DagNode, layoutDag, layoutSignature } from "./dagLayout.js";
import Icon from "../primitives/Icon.vue";

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
    // Tooltip on each node's add button; absent means no button, since adding is the caller's fact, not ours.
    addLabel?: string;
}>();

// Which node is selected; re-clicking clears it. Shared model with DagGraph, so a selection carries over.
const selectedId = defineModel<string | undefined>();

const emit = defineEmits<{
    // A new dependency from dragging a handle; Vue Flow guarantees both ids exist but not that it's acyclic.
    connect: [from: string, to: string];
    // An edge the reader picked. Deleting or re-typing it is the caller's business: this only says which.
    selectEdge: [from: string, to: string];
    // The add button on a node's trailing handle: "give me a new node downstream of this one".
    add: [from: string];
}>();

defineSlots<{ node(props: { node: DagNode<T>; selected: boolean }): unknown }>();

// Vue Flow scopes its injected state by id: unique per instance so two graphs can share a page.
const flowId = useId();

// Kept locally, not modelled: an edge selection is transient, unlike a node selection which drives an inspector.
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
            // Fatter than DagGraph's: a 1.5px stroke is too thin to click, so `interactionWidth` adds an invisible hit
            // area.
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

// Caps fit at 1x so a small graph sits at natural size instead of being magnified to fill this much larger canvas
// — the opposite of DagGraph, whose callers give it only a short band.
// `padding` is a viewport fraction per side; 0.08 leaves room to breathe without shrinking labels illegible.
const FIT = { padding: 0.08, maxZoom: 1 } as const;

const flow = ref<VueFlowStore>();

// `@move-start` fires only on a real gesture; once held, nothing auto-fits over where the reader panned to.
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

// Refits on a real layout change (keyed on signature, not node count), and releases any hold: an edit changes the
// picture, so a new node landing outside the viewport must not look like the click did nothing.
watch(
    () => layoutSignature(nodes as readonly DagNode<never>[], edges, { direction, nodeWidth, nodeHeight }),
    async () => {
        held = false;
        await nextTick();
        refit();
    },
);

// Not `fit-view-on-init` (that uses Vue Flow's own magnifying default); fits on ready instead, plus
// `nodes-initialized` (fitView no-ops before nodes are measured) and a resize observer for the inspector opening.
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

// Clicking empty canvas clears both selections — the only way to close an inspector without hunting for an ×.
const onPaneClick = (): void => {
    pickedEdge.value = undefined;
    selectedId.value = undefined;
};

// Fit is the only button needed: Vue Flow already gives wheel/pinch zoom and drag-to-pan for free.
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
                <!--
                    `relative` and rounded are load-bearing: without `relative`, a slotted descendant (e.g. a status
                    stripe) clips
                    against the frame instead of this box, escaping the rounded corner. Radius is derived (frame's
                    radius minus the
                    1px border), not a literal value, so it stays correct if either token changes.
                -->
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
                <!--
                    Painted in the action colour for contrast, not decoration: neutral tokens topped out at ~2:1
                    against this
                    surface (WCAG needs 3:1 for a control boundary), and hover-only reveal left it unreachable by
                    keyboard. 24px for
                    the same reason on touch-target size; visible on focus as well as hover.
                -->
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
            <!-- `rounded-sm`, not `rounded-md`: this theme sets --radius-sm to 0.375rem and --radius-md to 0.5rem. -->
            <button
                type="button"
                v-tooltip.top="`Fit the whole graph`"
                aria-label="Fit the whole graph"
                class="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm border border-line bg-canvas text-[0.625rem] text-subtle hover:border-line-strong hover:text-content"
                @click="fit()"
            >
                <Icon name="expand" />
            </button>
        </Panel>
    </VueFlow>
</template>

<style>
/* Matches DagGraph's edge chrome, plus two states unique here: a picked edge, and a grabbable handle. */
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
/*
 * Handles are grab targets (unlike DagGraph's inert ones), shown only on hover so the canvas doesn't read as a
 * circuit diagram. Solid `subtle` fill, not a hollow ring, since the ring's outline fell under WCAG's 3:1
 * control-boundary floor.
 */
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
/* Turns the colour an edge will be drawn in on hover — the only preview of the gesture before dragging starts. */
.dag-editor .vue-flow__handle.connectionindicator:hover {
    background: var(--color-link);
}
.dag-editor .vue-flow__connectionline path {
    stroke: var(--color-link);
    stroke-width: 2;
}
/* Shows the canvas's extent so panning reads as movement; a gradient stands in for a background package. */
.dag-editor .vue-flow__pane {
    background-image: radial-gradient(circle, var(--color-line) 1px, transparent 1px);
    background-size: 18px 18px;
}
</style>
