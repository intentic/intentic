<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, computed, inject } from "vue";
import { agentDisplayTitle } from "../../fleet/agentStatus";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import { FINISHED_FOLD, inProcess, type TrayChild, trayOf } from "../view/childFold";
import { trayFold } from "@intentic/ui/motion";
import ChildGroupRow from "./ChildGroupRow.vue";
import ChildRow from "./ChildRow.vue";
import { CHILD_ROWS } from "./childRows";

// THE AGENTS A CARD STARTED, hung under it rather than standing beside it as cards of their own (childFold): the
// conversations it spawned and the subagents its runtime ran in-process alike. Each row's first glyph starts under the
// card's title, so the rows read as the card's before a word of them is read, and they get no chrome at all: no rule
// down the left, no border, no fill at rest, one line each. Top to bottom: a child asking what only the reader can
// give, wearing its ask; the working ones, always in sight; then one row per thing the stopped ones stopped on, since
// fifteen children refused by one provider are one fact about that provider, not fifteen; and the settled ones behind
// one quiet toggle, since an orchestrator's thirty finished helpers are its history, not its news. Draws nothing on a
// board that provides no trays (CHILD_ROWS), or for a card with nothing riding under it.
//
// OPEN ONLY UNDER THE CARD BEING LOOKED AT. Drawn under every card, the trays turned each lane into a list of lists, and
// every helper an unwatched card's runtime started or finished pushed a row in or out and shook every card below it.
// So a tray opens, folding out from under the card (@intentic/ui/motion, fold.ts), only under the card the reader is on (`focused`), under a card
// whose child is on screen (the ring must be on something drawn), and under every card while a filter is on (a result
// set must not hide its own matches). Every other card counts its family on itself instead (ChildCount), which moves no
// card's height. The one exception is a child asking what only the reader can give: that is news, not history, and a
// chat list's card, unlike the board's, carries no word of it, so its row stays in sight under any card.

const props = defineProps<{
    agent: FleetAgent;
    // The card is drawn at the live lanes' weight (AgentCard's `live`), whose identity tile sits a step further in.
    live?: boolean;
    // Hung from a chat list's card (RailCard) rather than the board's: its identity tile is smaller and sits further left.
    rail?: boolean;
    // The card this hangs from is the one the reader is on (its ring), which opens the tray.
    focused: boolean;
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
// Whether one of the rows is on screen: its chat in a pane, or its transcript in this card's column.
const childOnScreen = computed(
    () =>
        board !== undefined &&
        (children.value.some((child) => board.selected(child.id)) || subagents.value.some((session) => board.selected(session.id))),
);
const shown = computed(() => props.focused || childOnScreen.value || (board?.stateOf(props.agent).filtering ?? false));

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
// A shut tray with nothing in it draws nothing: not its frosted strip on a wallpaper (wallpapers.css), which on an empty
// box still painted a sliver under the card. Worn from the render that shuts the fold, so a shutting fold, pinned
// outside the flow (trayFold), has already left the column its final height.
const drawn = computed(() => shown.value || (tray.value?.asks.length ?? 0) > 0);
// Where the rows start: the card's title edge (its border, padding, identity tile and the gap after it) less a row's
// own `px-2`, so the glyph, not the hover wash, lines up with the title. RailCard: 1 + 12 + 24 + 8; AgentCard: 1 + 14
// (16 live) + 28 + 10.
const inset = computed(() => (props.rail ? `ml-9.25` : props.live ? `ml-11.75` : `ml-11.25`));
</script>

<template>
    <div
        v-if="board !== undefined && tray !== undefined"
        :role="drawn ? `group` : undefined"
        :aria-label="label"
        class="relative flex flex-col"
        :class="[inset, { 'child-tray': drawn }]"
    >
        <!-- A child asking the reader keeps its row under any card: the one row that is news whichever card is looked at. -->
        <div v-if="tray.asks.length > 0" class="flex flex-col pt-1">
            <ChildRow
                v-for="child in tray.asks"
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
        <!-- The rest folds open and shut (trayFold): the box takes its height at once and the rows slide out from under the card, on the compositor. -->
        <Transition :css="false" @enter="trayFold.enter" @leave="trayFold.leave">
            <div v-if="shown">
                <div class="flex flex-col" :class="tray.asks.length === 0 ? `pt-1` : ``">
                    <ChildRow
                        v-for="child in tray.lead"
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
            </div>
        </Transition>
    </div>
</template>
