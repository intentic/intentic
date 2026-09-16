<script setup lang="ts">
import { CAPACITY_RAIL_PX } from "./chatCapacity";
import { uiLength } from "../../../shell/window/uiScale";
import ChatCapacityRail from "./ChatCapacityRail.vue";
import ChatRailChecklist from "./ChatRailChecklist.vue";

// The strip in the pop-out window that panes have no use for (chatCapacity's railFitsBeside). Holds what the reader
// wants standing rather than scrolling past: this chat's checklist, then what they can still run. Presence is decided
// by ChatPanel and keyed on capacity alone, so a chat picking up its first task can't make a 240px column appear
// mid-turn and reflow the panel underneath the answer being read.
</script>

<template>
<!-- No surface of its own: whitespace marks it as a region, not a panel with a border or fill. -->
    <aside
        class="absolute inset-y-0 z-10 flex min-h-0 flex-col"
        :style="{ width: uiLength(CAPACITY_RAIL_PX), right: `var(--chat-scrollbar)` }"
        aria-label="This chat and what you can run"
    >
        <ChatRailChecklist />
        <ChatCapacityRail />
    </aside>
</template>
