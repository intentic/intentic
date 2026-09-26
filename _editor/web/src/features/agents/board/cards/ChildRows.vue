<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import { agentDisplayTitle } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { trayOf } from "../view/childFold";
import ChildRow from "./ChildRow.vue";
import { CHILD_ROWS } from "./childRows";

// THE CHILDREN A CARD STARTED, hung from it on a rail rather than standing beside it as cards of their own (childFold).
// The rail drops from the card's identity tile, so the rows read as the card's before a word of them is read, and it
// is the only chrome they get: no border, no fill at rest, one line each. Working children are always in sight;
// settled ones fold behind one quiet toggle, since an orchestrator's thirty finished helpers are its history, not its
// news. Draws nothing on a board that provides no trays (CHILD_ROWS), or for a card with nothing riding under it.

const props = defineProps<{
    agent: FleetAgent;
    // The card is drawn at the live lanes' weight (AgentCard's `live`), whose identity tile sits a step further in.
    live?: boolean;
}>();

const t = useT();
const board = inject(CHILD_ROWS, undefined);

// Two steps, so a roster tick that moved nothing under this card wakes nothing here: the list is the fold's steady one
// (steadyFold), and the tray is only re-read when the list, the fold, the filter or the ring moved.
const children = computed(() => board?.childrenOf(props.agent) ?? []);
const tray = computed(() => (board === undefined ? undefined : trayOf(children.value, board.stateOf(props.agent))));
const label = computed(() => t(`agents.childRows.startedBy`, { title: agentDisplayTitle(props.agent) }));
</script>

<template>
    <div
        v-if="board !== undefined && tray !== undefined"
        role="group"
        :aria-label="label"
        class="flex flex-col border-l border-line pt-1 pl-1"
        :class="live ? 'ml-7.5' : 'ml-7'"
    >
        <ChildRow
            v-for="child in tray.lead"
            :key="child.id"
            :ref="(el) => board?.setRowEl(child.id, el)"
            :agent="child"
            :selected="board.selected(child.id)"
            :provider="agent.provider"
            :needle="board.needle.value"
            :match-case="board.matchCase.value"
            @open="(event) => board?.open(child, event)"
            @review="board?.review(child)"
            @menu="(event) => board?.menu(child, event)"
        />
        <!-- The fold, in the rows' own glyph column: a chevron where a row has its standing, so the count reads as one more row. -->
        <button
            v-if="tray.folded > 0"
            type="button"
            class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-2xs text-subtle max-md:min-h-10"
            :aria-expanded="tray.open"
            @click="board.toggle(agent)"
        >
            <Icon :name="tray.open ? `chevron-down` : `chevron-right`" class="shrink-0 text-xs" />
            <span class="min-w-0 flex-1 truncate">{{ t(`agents.childRows.finished`, { count: tray.folded }, tray.folded) }}</span>
        </button>
        <ChildRow
            v-for="child in tray.tail"
            :key="child.id"
            :ref="(el) => board?.setRowEl(child.id, el)"
            :agent="child"
            :selected="board.selected(child.id)"
            :provider="agent.provider"
            :needle="board.needle.value"
            :match-case="board.matchCase.value"
            @open="(event) => board?.open(child, event)"
            @review="board?.review(child)"
            @menu="(event) => board?.menu(child, event)"
        />
    </div>
</template>
