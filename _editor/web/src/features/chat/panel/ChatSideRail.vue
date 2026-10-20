<script setup lang="ts">
import { CAPACITY_RAIL_PX } from "./capacity/chatCapacity";
import { uiLength } from "../../../workbench/window/uiScale";
import ChatCapacityRail from "./capacity/ChatCapacityRail.vue";
import ChatRailChecklist from "./ChatRailChecklist.vue";
import { useT } from "@intentic/ui/i18n";

// The strip in the pop-out window that panes have no use for (chatCapacity's railFitsBeside). Holds what the reader
// wants standing rather than scrolling past: this chat's checklist, then what they can still run. Presence is decided
// by ChatPanel and keyed on capacity alone, so a chat picking up its first task can't make a 240px column appear
// mid-turn and reflow the panel underneath the answer being read.

const t = useT();
</script>

<template>
    <!-- No surface of its own: whitespace marks it as a region, not a panel with a border or fill. Starts under the
         desktop window's buttons when the panel holds the corner (`--window-band`, ChatPanel.vue).
         Two rows that each take their content's height while both fit, so neither scrolls with room to spare. Once
         they don't, the grid shares the height out evenly: a block shorter than half keeps its whole height, the other
         one takes the rest and scrolls inside, and when both are long each gets half. -->
    <aside
        class="absolute top-(--window-band) bottom-0 z-10 grid min-h-0 grid-rows-[minmax(0,auto)_minmax(0,auto)] content-start"
        :style="{ width: uiLength(CAPACITY_RAIL_PX), right: `var(--chat-scrollbar)` }"
        :aria-label="t(`chat.chatSideRail.chatWhatRun`)"
    >
        <ChatRailChecklist />
        <ChatCapacityRail />
    </aside>
</template>
