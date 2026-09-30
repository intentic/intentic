<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { type ComponentPublicInstance, computed, inject, ref } from "vue";
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
//
// OPEN ONLY UNDER THE CARD BEING LOOKED AT. Drawn under every card, the trays turned each lane into a list of lists, and
// every helper an unwatched card's runtime started or finished pushed a row in or out and shook every card below it.
// So a tray opens, fading in and leaving at once, only under the card the reader is on (`focused`), under a card
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
// Where the rail drops from: the middle of the card's identity tile, whichever card it hangs from.
// THE FOLD. Grid rows (0fr to 1fr) re-resolved the track from its content every frame, and a CSS transition's clock
// starts on the frame the class lands, which is the same frame the chat switches cards: the switch ate the first
// frames and the fold arrived half done, then stuttered. So the height is measured once and animated in pixels, with
// the start held two frames, past the switch's render, and the box contains its own layout and paint so a frame
// reflows the rows' box, not the rows.
const EASE = `cubic-bezier(0.4, 0, 0.2, 1)`;
const afterPaint = (run: () => void): void => {
    requestAnimationFrame(() => requestAnimationFrame(run));
};
const reduced = (): boolean => window.matchMedia(`(prefers-reduced-motion: reduce)`).matches;
const animateHeight = (el: Element, to: (box: HTMLElement) => number, duration: number, done: () => void): void => {
    // A page without the Web Animations API (a test DOM) folds at once.
    if (!(el instanceof HTMLElement) || !(`animate` in el)) {
        done();
        return;
    }
    const opening = to(el) > 0;
    const from = opening ? 0 : el.offsetHeight;
    const target = opening ? el.scrollHeight : 0;
    el.style.overflow = `hidden`;
    el.style.contain = `layout paint`;
    el.style.height = `${from}px`;
    el.style.opacity = opening ? `0` : `1`;
    afterPaint(() => {
        const frames = reduced()
            ? [{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }]
            : [
                  { height: `${from}px`, opacity: opening ? 0 : 1 },
                  { height: `${target}px`, opacity: opening ? 1 : 0 },
              ];
        const run = el.animate(frames, { duration, easing: EASE, fill: `forwards` });
        run.addEventListener(`finish`, () => {
            el.style.cssText = ``;
            run.cancel();
            done();
        });
    });
};
// A shut tray with nothing in it is not drawn at all, not drawn zero tall: its rail's border still painted a sliver
// under the card. `folding` keeps it drawn while the fold closes.
const folding = ref(false);
const fold = {
    enter: (el: Element, done: () => void): void => animateHeight(el, (box) => box.scrollHeight || 1, 260, done),
    leave: (el: Element, done: () => void): void => {
        folding.value = true;
        animateHeight(el, () => 0, 220, () => {
            folding.value = false;
            done();
        });
    },
};
const inset = computed(() => (props.rail ? `ml-6` : props.live ? `ml-7.5` : `ml-7`));
</script>

<template>
    <div
        v-if="board !== undefined && tray !== undefined"
        :role="shown || tray.asks.length > 0 ? `group` : undefined"
        :aria-label="label"
        class="child-tray flex flex-col border-l border-line pl-1"
        :class="[inset, { hidden: !shown && !folding && tray.asks.length === 0 }]"
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
        <!-- The rest folds open and shut (useFold): measured pixel heights on the Web Animations clock, started a frame late. -->
        <Transition :css="false" @enter="fold.enter" @leave="fold.leave">
            <div v-if="shown">
                <div>
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
            </div>
        </Transition>
    </div>
</template>
