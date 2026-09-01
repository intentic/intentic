<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useChangeWeight } from "../composables/workspace/changeWeight";

/* THE READING-ORDER TOGGLE the review lists share: path order (git's, the default) or most-added first. The rule
 * and the reasoning are in changeWeight.ts; what this file is, is the one place the control is WORDED, so the
 * agent review's bar, the workspace sidebar's action row and its mobile equivalent cannot end up offering the
 * same preference in three slightly different sentences.
 *
 * A lit toggle rather than a two-option control: the panels' own switches (Restore points, the explorer's
 * filter) say a state that way, and a segmented Path|Size would spend twice the width to say the same thing in
 * a sidebar that is already 270px.
 *
 * IT SAYS "ADDED", NOT "BIGGEST", because that is what it does, and the difference is visible the first time a
 * changeset deletes a vendored bundle: a label promising the biggest change first, over a list that puts a
 * 40-line new module above a 1,300-line deletion, is a control the reader stops trusting. The tooltip carries
 * the SCOPE, the other half a reader cannot see: the ask is applied inside each package rather than flattening
 * the list, so one long sorted run is not what they should be expecting. */

const { shell = ``, glyph = `text-2xs` } = defineProps<{
    // The button's own sizing, per bar: the phone's rows are thumb-sized, the desktop's are not.
    shell?: string;
    glyph?: string;
}>();

const { largestFirst } = useChangeWeight();
const toggle = (): void => {
    largestFirst.value = !largestFirst.value;
};
</script>

<template>
    <button
        type="button"
        :class="ui.iconButton(shell, largestFirst ? `bg-overlay text-content` : ``)"
        :aria-pressed="largestFirst"
        aria-label="Sort most added first"
        v-tooltip.bottom="
            largestFirst ? `Most added first, within each package: click for path order` : `Sort by how much each file added`
        "
        @click="toggle"
    >
        <Icon name="sort-desc" :class="glyph" />
    </button>
</template>
