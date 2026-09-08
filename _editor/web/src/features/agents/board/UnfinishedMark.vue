<script setup lang="ts">
import { computed } from "vue";
import type { UnfinishedWork } from "@intentic/sandbox-contract";
import { relativeTime } from "../../chat/models/catalog";

// Work the last turn left open on an otherwise-resting card (AgentSummary.unfinished); the other marks report a turn
// still waiting, this one reports a turn that's already over but stopped short.
// Both readings are the turn's own measured facts (unfinishedOf), never a model's judgment, so this can only be out of
// date, not wrong.
// Told apart from the sibling unsent mark by form (a ring, not a fill), not hue: warning and link are too close in the
// palette at chip size, and the gap shrinks further on a non-default accent.

const props = defineProps<{
    // What the last turn left open, as the daemon measured it at that turn's finish.
    work: UnfinishedWork;
    // Host's tick, for the hover's age: this mark's props are static once the turn ends, so without a live tick it
    // would freeze at build time.
    // Optional, since a still surface renders a correct age anyway.
    now?: number;
}>();

// Noun agrees with the total, not the count left: '1 of 4 steps', but '1 of 1 step'.
const steps = computed<string | undefined>(() => {
    const open = props.work.steps;
    if (open === undefined) {
        return undefined;
    }
    return `${open.open} of ${open.total} ${open.total === 1 ? `step` : `steps`} unfinished`;
});

// Everything the card's face doesn't already say; each half drops instead of faking one the turn had nothing to report.
// Two sentences, since they're separate evidence: the agent's own checklist, and a check that ran on the tree it left.
const hint = computed<string>(() => {
    // Clause, age, then the thing itself, matching the unsent chip's hover shape.
    // A comma clause, not '2h ago', since relativeTime answers 'just now' inside the first minute.
    const age = relativeTime(props.work.at, props.now);
    const left = steps.value;
    const next = props.work.steps?.next;
    const said = left === undefined ? [] : [`Stopped with ${left}, ${age}${next === undefined ? `` : `: ${next}`}`];
    const check = props.work.check;
    if (check !== undefined) {
        // Age said once, not repeated: a second mention would read as a different moment, not the same ending.
        said.push(left === undefined ? `Its own check was still failing, ${age}: ${check}` : `Its own check was still failing too: ${check}`);
    }
    return said.join(`. `);
});
</script>

<template>
    <!--
        `w-fit`, like the unsent chip: the board stacks blocks in a column, where a flex child would stretch and a full-width chip would read as a
        banner.
        Ring drawn inside (`ring-inset`), not as a border, so this chip and the filled one above stay the same 18px height on one baseline in the
        dense row.
    -->
    <span
        v-tooltip.bottom="hint"
        :aria-label="hint"
        class="flex w-fit shrink-0 items-center gap-1 rounded-full bg-warning/8 py-px pl-1.5 pr-2.5 text-2xs font-semibold text-warning ring-1 ring-inset ring-warning/35"
    >
        <Icon name="list-check" class="shrink-0 text-2xs" />
        Unfinished
    </span>
</template>
