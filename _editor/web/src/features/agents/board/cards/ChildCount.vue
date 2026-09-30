<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { trayCount } from "../view/childFold";
import { CHILD_ROWS } from "./childRows";

// THE FAMILY, COUNTED ON THE CARD. A card's tray (ChildRows) opens only while the reader is looking at that card, so
// every other card says what hangs under it here instead: how many agents it started, and while any are still at work,
// how many of the total, tinted as live. A number in a row the card already draws changes no card's height, where a row
// under every card came and went with each helper its runtime ran and shook the lanes below it. Reads the board's trays
// itself, as the tray does, so a child's tick redraws this and not the card around it. Draws nothing where no board
// provides trays, or for a card that started nothing.

const props = defineProps<{ agent: FleetAgent }>();

const t = useT();
const board = inject(CHILD_ROWS, undefined);

const count = computed(() => (board === undefined ? undefined : trayCount(board.childrenOf(props.agent), board.subagentsOf(props.agent))));
const hint = computed(() => {
    const value = count.value;
    if (value === undefined) {
        return ``;
    }
    return value.running > 0
        ? t(`agents.childRows.workingCount`, { running: value.running, total: value.total })
        : t(`agents.childRows.startedCount`, { count: value.total });
});
</script>

<template>
    <span
        v-if="count !== undefined"
        v-tooltip.top="hint"
        role="img"
        :aria-label="hint"
        class="inline-flex shrink-0 items-center gap-0.5 tabular-nums"
        :class="count.running > 0 ? `text-link` : ``"
    >
        <Icon name="subagents" class="shrink-0 text-2xs" />{{ count.running > 0 ? `${count.running}/${count.total}` : count.total }}
    </span>
</template>
