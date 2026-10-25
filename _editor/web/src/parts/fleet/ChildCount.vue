<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import type { FleetAgent } from "../../models/fleet/useAgents-fleet";
import { stackedRuns, trayCount } from "../../models/fleet/board/childFold";
import { CHILD_ROWS } from "../../models/fleet/board/childRows";

// THE FAMILY, COUNTED ON THE CARD. A card's tray (ChildRows) opens only while the reader is looking at that card, so
// every other card says what hangs under it here instead: how many agents it started, and while any are still at work,
// how many of the total, tinted as live. A number in a row the card already draws changes no card's height, where a row
// under every card came and went with each helper its runtime ran and shook the lanes below it. Reads the board's trays
// itself, as the tray does, so a child's tick redraws this and not the card around it. Draws nothing where no board
// provides trays, or for a card that started nothing. On the card of an automation's latest run, whose tray holds only
// its earlier runs (childFold, stackedRuns), it counts those as runs, under the glyph of a history, not of a family.

const props = defineProps<{ agent: FleetAgent }>();

const t = useT();
const board = inject(CHILD_ROWS, undefined);

const count = computed(() => (board === undefined ? undefined : trayCount(board.childrenOf(props.agent), board.subagentsOf(props.agent))));
// Every rider an earlier run of the card's automation, and nothing its runtime ran in-process.
const runs = computed(() => {
    const value = count.value;
    return value !== undefined && board !== undefined && stackedRuns(board.childrenOf(props.agent)).length === value.total;
});
const hint = computed(() => {
    const value = count.value;
    if (value === undefined) {
        return ``;
    }
    if (runs.value) {
        return value.running > 0
            ? t(`agents.childRows.runsWorking`, { running: value.running, total: value.total })
            : t(`agents.childRows.runsCount`, { count: value.total });
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
        <Icon :name="runs ? `history` : `subagents`" class="shrink-0 text-2xs" />{{ count.running > 0 ? `${count.running}/${count.total}` : count.total }}
    </span>
</template>
