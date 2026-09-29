<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, computed, inject } from "vue";
import { agentDisplayTitle } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { FINISHED_FOLD, inProcess, type TrayChild, trayOf } from "../view/childFold";
import ChildGroupRow from "./ChildGroupRow.vue";
import ChildRow from "./ChildRow.vue";
import { CHILD_ROWS } from "./childRows";

// THE AGENTS A CARD STARTED, hung from it on a rail rather than standing beside it as cards of their own (childFold):
// the conversations it spawned and the subagents its runtime ran in-process alike. The rail drops from the card's
// identity tile, so the rows read as the card's before a word of them is read, and it is the only chrome they get: no
// border, no fill at rest, one line each. Top to bottom: a child asking what only the reader can give, wearing its ask;
// the working ones, always in sight; then one row per thing the stopped ones stopped on, since fifteen children refused
// by one provider are one fact about that provider, not fifteen; and the settled ones behind one quiet toggle, since an
// orchestrator's thirty finished helpers are its history, not its news. Draws nothing on a board that provides no trays
// (CHILD_ROWS), or for a card with nothing riding under it.

const props = defineProps<{
    agent: FleetAgent;
    // The card is drawn at the live lanes' weight (AgentCard's `live`), whose identity tile sits a step further in.
    live?: boolean;
    // Hung from a chat list's card (RailCard) rather than the board's: its identity tile is smaller and sits further left.
    rail?: boolean;
}>();

const t = useT();
const board = inject(CHILD_ROWS, undefined);

// Two steps, so a roster tick that moved nothing under this card wakes nothing here: the list is the fold's steady one
// (steadyFold), and the tray is only re-read when the list, the folds, the filter or the ring moved.
const children = computed(() => board?.childrenOf(props.agent) ?? []);
const subagents = computed(() => board?.subagentsOf(props.agent) ?? []);
const tray = computed(() => (board === undefined ? undefined : trayOf(children.value, board.stateOf(props.agent), subagents.value)));
const title = computed(() => agentDisplayTitle(props.agent));
const label = computed(() => t(`agents.childRows.startedBy`, { title: title.value }));

// A conversation's row answers the card's own presses for itself; an in-process subagent's shows its transcript in this
// card's chat, and joins no motion, being no card that could fly to a lane of its own.
const open = (child: TrayChild, event: MouseEvent): void => {
    if (inProcess(child)) {
        board?.openSubagent(props.agent, child);
        return;
    }
    board?.open(child, event);
};
const selected = (child: TrayChild): boolean => board?.selected(child.id) === true;
const setRow = (child: TrayChild, el: Element | ComponentPublicInstance | null): void => {
    if (!inProcess(child)) {
        board?.setRowEl(child.id, el);
    }
};
const review = (child: TrayChild): void => {
    if (!inProcess(child)) {
        board?.review(child);
    }
};
const menu = (child: TrayChild, event: MouseEvent): void => {
    if (!inProcess(child)) {
        board?.menu?.(child, event);
    }
};
// Where the rail drops from: the middle of the card's identity tile, whichever card it hangs from.
const inset = computed(() => (props.rail ? `ml-6` : props.live ? `ml-7.5` : `ml-7`));
</script>

<template>
    <div
        v-if="board !== undefined && tray !== undefined"
        role="group"
        :aria-label="label"
        class="child-tray flex flex-col border-l border-line pt-1 pl-1"
        :class="inset"
    >
        <ChildRow
            v-for="child in [...tray.asks, ...tray.lead]"
            :key="child.id"
            :ref="(el) => setRow(child, el)"
            :child="child"
            :selected="selected(child)"
            :provider="agent.provider"
            :needle="board.needle.value"
            :match-case="board.matchCase.value"
            :menus="board.menu !== undefined"
            @open="(event) => open(child, event)"
            @review="review(child)"
            @menu="(event) => menu(child, event)"
        />
        <template v-for="group in tray.groups" :key="group.key">
            <!-- One child alone is its own row: a fold of one would be a press to read a single line. -->
            <ChildGroupRow v-if="group.members.length > 1" :group="group" :parent="title" @toggle="board?.toggle(agent, group.key)" />
            <ChildRow
                v-for="child in group.shown"
                :key="child.id"
                :ref="(el) => setRow(child, el)"
                :child="child"
                :selected="selected(child)"
                :provider="agent.provider"
                :needle="board.needle.value"
                :match-case="board.matchCase.value"
                :menus="board.menu !== undefined"
                @open="(event) => open(child, event)"
                @review="review(child)"
                @menu="(event) => menu(child, event)"
            />
        </template>
        <!-- The fold, in the rows' own glyph column: a chevron where a row has its standing, so the count reads as one more row. -->
        <button
            v-if="tray.folded > 0"
            type="button"
            class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-2xs text-subtle max-md:min-h-10"
            :aria-expanded="tray.open"
            @click="board.toggle(agent, FINISHED_FOLD)"
        >
            <Icon :name="tray.open ? `chevron-down` : `chevron-right`" class="shrink-0 text-xs" />
            <span class="min-w-0 flex-1 truncate">{{ t(`agents.childRows.finished`, { count: tray.folded }, tray.folded) }}</span>
        </button>
        <ChildRow
            v-for="child in tray.tail"
            :key="child.id"
            :ref="(el) => setRow(child, el)"
            :child="child"
            :selected="selected(child)"
            :provider="agent.provider"
            :needle="board.needle.value"
            :match-case="board.matchCase.value"
            :menus="board.menu !== undefined"
            @open="(event) => open(child, event)"
            @review="review(child)"
            @menu="(event) => menu(child, event)"
        />
    </div>
</template>
