<!-- THE RAIL: the column a list of agents is drawn in, and the frame around RailLane and RailCard.

     Two surfaces put one on screen: the chat's open conversations (chat/ChatTabs in its vertical form, in a
     floating window or in the /chat area) and the agents this sandbox's agents started (pages/Subagents.vue).
     They were two hand-rolled columns holding the same cards on the same lanes: one 288px and fixed, the other
     320px and resizable, one padded at 12px and the other at 6, the two scrollers a half-step apart in their
     lane spacing. Nothing about that was a decision, and it read as two components rather than one list in two
     places. So the column is a component, and the only thing a host decides is what goes in it.

     THE WIDTH IS SHARED, not merely equal (composables/rail.ts): dragging either rail is dragging THE rail.

     THE GUTTER IS ON THIS FRAME, NEVER ON THE SCROLLER INSIDE IT, and that is load-bearing rather than
     stylistic: a scroll container's padding insets where its sticky children COME TO REST but not where it
     CLIPS, so a padded scroller pins a lane's cap below its own top edge and every card scrolls through the
     strip above it, selection ring and all. Hosts put their scroller in bare.

     It resizes off its RIGHT edge (pointer capture, double-click resets), since it stands at the left of
     whatever surface hosts it. -->
<script setup lang="ts">
import { ref } from "vue";
import { DEFAULT_RAIL_WIDTH, railWidth, setRailWidth } from "../composables/rail";
import { toAppPx, uiLength } from "../composables/uiScale";

const frame = ref<HTMLElement | null>(null);
const resizing = ref(false);

const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};
/* The width is the distance from the rail's own left edge to the pointer: measured off the ELEMENT, not off
 * the window. In a floating window the two are the same thing (the rail is flush with that window's left
 * edge), but in the /chat area and on /subagents the shell's icon rail stands to its left, and a width read as
 * the pointer's x would be that column's width too wide on every drag. */
const onResize = (event: PointerEvent): void => {
    if (resizing.value) {
        const left = frame.value?.getBoundingClientRect().left ?? 0;
        setRailWidth(toAppPx(event.clientX - left));
    }
};
const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
</script>

<template>
    <!-- No divider down the right edge: the lane slabs are the structure, and a hairline against a column of
         them is a second edge saying what the first already said. -->
    <aside
        ref="frame"
        class="relative flex h-full min-h-0 shrink-0 flex-col items-stretch gap-1 p-1.5"
        :class="{ 'rail-resizing': resizing }"
        :style="{ width: uiLength(railWidth) }"
    >
        <div
            class="rail-resize"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="setRailWidth(DEFAULT_RAIL_WIDTH)"
            title="Drag to resize · double-click to reset"
        ></div>
        <slot />
    </aside>
</template>

<style scoped>
/* Drag-to-resize handle on the rail's RIGHT edge: the seam against whatever stands beside it (pointer-capture,
 * mirrors the chat panel's .resize-handle). */
.rail-resize {
    position: absolute;
    inset: 0 0 0 auto;
    width: 6px;
    cursor: col-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.rail-resize:hover,
.rail-resizing .rail-resize {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.rail-resizing {
    user-select: none;
}
</style>
