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
import { computed } from "vue";
import { ResizeSeam } from "@intentic/ui";
import { DEFAULT_RAIL_WIDTH, MAX_RAIL_WIDTH, MIN_RAIL_WIDTH, railWidth, setRailWidth } from "../features/agents/board/columnWidth";
import { toAppPx, toScreenPx, uiLength } from "../shell/window/uiScale";

/* The seam speaks in pointer coordinates; the rail's width is stored in app pixels (see uiScale), so the two
 * meet here rather than in a conversion inside the drag.
 *
 * The seam reports a SIZE rather than a position, which is what retires this component's old measure-the-left-
 * edge arithmetic: the width used to be read as the pointer's x minus the rail's own left edge, because in the
 * /chat area and on /subagents the shell's icon rail stands to the left and a raw clientX was that column's
 * width too wide on every drag. A size taken at pointer-down plus the distance dragged since is correct
 * wherever the seam sits, so there is nothing left to measure. */
const seamWidth = computed<number>({
    get: () => toScreenPx(railWidth.value),
    set: (px) => setRailWidth(toAppPx(px)),
});
</script>

<template>
    <!-- No divider down the right edge: the lane slabs are the structure, and a hairline against a column of
         them is a second edge saying what the first already said. -->
    <!-- The width stays on the <aside>, which is the rail: hosts, and railColumn.test.ts, address it as one
         element at one width. Inside, the column of content and the seam beside it are a flex ROW, because the
         seam is dragged off the right edge and an in-flow strip is what <ResizeSeam> is. It costs the content
         nothing: the seam's negative margin gives back exactly the width it takes, so the column is as wide
         with a seam as without one. The gutter stays on the content box and never on the host's scroller, for
         the reason in this file's header. -->
    <aside class="relative flex h-full min-h-0 shrink-0" :style="{ width: uiLength(railWidth) }">
        <div class="flex min-h-0 min-w-0 flex-1 flex-col items-stretch gap-1 p-1.5">
            <slot />
        </div>
        <ResizeSeam
            v-model="seamWidth"
            :min="toScreenPx(MIN_RAIL_WIDTH)"
            :max="toScreenPx(MAX_RAIL_WIDTH)"
            :reset="toScreenPx(DEFAULT_RAIL_WIDTH)"
            title="Drag to resize · double-click to reset"
        />
    </aside>
</template>
