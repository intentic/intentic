<script setup lang="ts">
import { computed } from "vue";
import type { UnfinishedWork } from "@intentic/sandbox-contract";
import { relativeTime } from "../composables/chat/catalog";

/* WORK THE LAST TURN LEFT OPEN (AgentSummary.unfinished), on a card that is otherwise resting.
 *
 * The other marks on a session card report a turn that is WAITING: a question, a permission, a plan, and every
 * one of them is a live agent standing there until somebody answers. This one is the opposite and that is why
 * it is worth drawing at all — nobody is waiting, the turn is over, and the work stopped short anyway. Such a
 * card reads `idle` beside a dozen that finished what they were asked, so the board's own account of it was
 * "done", and finding out otherwise meant opening the session and reading to the end of it.
 *
 * NOTHING HERE IS A JUDGEMENT. Both readings are the turn's own (agents-registry's unfinishedOf): items still
 * on the checklist the agent itself wrote, and the workspace's own end-of-turn check going red on the way out.
 * No model is asked anything, so the mark cannot be wrong about what it says — only out of date, which the next
 * turn fixes by measuring again.
 *
 * IT IS THE UNSENT MARK'S SIBLING, deliberately: the same size, the same place on the card, the same rule that
 * the face names the state and the hover carries what the reader decides on. They sit together because they are
 * the two things a settled board can owe somebody — a message they never sent, and a job the agent never
 * finished.
 *
 * SO IT IS TOLD APART BY ITS FORM, NOT BY ITS HUE, and that is the one thing here that was decided by looking
 * at the board rather than at the code. The obvious answer was colour: the unsent chip is `text-link` and this
 * one `text-warning`, which reads as two clearly different things — in the palette, where they are 33° of hue
 * apart at the same lightness (measured: `oklch(75% .123 55)` against `oklch(74% .16 88)`). On an 18px chip of
 * 11px type they are the same warm chip twice, and a card wearing BOTH looked like it was wearing one of them
 * twice over. Worse, the gap is not even fixed: `link` follows the accent the user picks, which SHIPS at hue
 * 55, so the two are at their closest in the default theme and would open right up on a blue accent — a
 * distinction that depends on a preference is not one the board can rely on.
 *
 * A ring instead of a fill is legible at any accent, because it is a difference in weight rather than in
 * colour: the solid chip beside it stays the louder of the two, which is the right order (a message only this
 * window is holding outranks work sitting safely on a branch). The amber stays, and says what it always says —
 * something here did not go the way it should have.
 *
 * THE COUNT IS ON THE HOVER RATHER THAN THE FACE. "3 of 7" is the most useful thing here and the least
 * readable: seven cards down a lane, seven fractions in seven chips is a column of arithmetic nobody performs.
 * The face says the one thing that decides whether to look, and the hover says everything that decides what to
 * do about it — which steps are left, which check went red, and how long ago, because a job broken off ten
 * minutes ago and one abandoned on Tuesday call for different things. */

const props = defineProps<{
    // What the last turn left open, as the daemon measured it at that turn's finish.
    work: UnfinishedWork;
    /* The host's tick (AgentsView's `now`), for the age in the hover: this mark's props are as still as the
     * finished turn is, so with nothing to re-render on it would keep answering with the age it was built
     * with. Optional, because a surface with no clock still renders a correct age every time it does render. */
    now?: number;
}>();

// "3 of 7 steps unfinished". The noun agrees with the TOTAL, which is what it counts: one item left out of
// four is "1 of 4 steps", and only a one-item list is "1 of 1 step".
const steps = computed<string | undefined>(() => {
    const open = props.work.steps;
    if (open === undefined) {
        return undefined;
    }
    return `${open.open} of ${open.total} ${open.total === 1 ? `step` : `steps`} unfinished`;
});

/* The whole of what the card does not already say, in the house's clause-comma-clause voice. Each half is
 * dropped rather than faked when the turn had nothing to report about it, and the two are separate sentences
 * because they are separate evidence: an agent's own list, and a check that ran on the tree it left. */
const hint = computed<string>(() => {
    // Clause, age, then the thing itself, the shape the unsent chip's hover uses ("Not sent, 12m: …"): the age
    // is a comma clause rather than "2h ago" because `relativeTime` answers "just now" inside the first minute.
    const age = relativeTime(props.work.at, props.now);
    const left = steps.value;
    const next = props.work.steps?.next;
    const said = left === undefined ? [] : [`Stopped with ${left}, ${age}${next === undefined ? `` : `: ${next}`}`];
    const check = props.work.check;
    if (check !== undefined) {
        // The age is said once. Repeated on the second sentence it would read as a second, different moment,
        // when both are readings of the same ending.
        said.push(left === undefined ? `Its own check was still failing, ${age}: ${check}` : `Its own check was still failing too: ${check}`);
    }
    return said.join(`. `);
});
</script>

<template>
    <!-- `w-fit` for the reason the unsent chip carries one: the board stacks a card's blocks in a column, where
         a flex child would stretch across the cross axis and a chip that took the width would read as a banner.
         The ring is drawn INSIDE the box (`ring-inset`) rather than as a border, so this chip and the filled one
         above it are the same 18px tall and their words sit on one baseline in the dense row form. -->
    <span
        v-tooltip.bottom="hint"
        :aria-label="hint"
        class="flex w-fit shrink-0 items-center gap-1 rounded-full bg-warning/8 py-px pl-1.5 pr-2.5 text-2xs font-semibold text-warning ring-1 ring-inset ring-warning/35"
    >
        <Icon name="list-check" class="shrink-0 text-2xs" />
        Unfinished
    </span>
</template>
