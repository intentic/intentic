<script setup lang="ts">
/* A heading's tick: the review's per-file "viewed" mark at the scope of a whole group (a repo, or a package
 * once the list is grouped by module).
 *
 * WHY A GROUP MAY BE TICKED AT ALL. This mark is the reader's place-keeping, not an approval signature:
 * nothing in the product gates on it, no one but the reviewer ever sees it, and a reload clears it. So the
 * honest unit is whatever the reviewer decided to stop looking at, and that is routinely a package. Three
 * files into a generated client, or a fixture directory, the answer for the remaining nine is already known,
 * and the only options without this are twelve clicks or a counter that stays permanently short. A progress
 * readout nobody can finish is one nobody reads. (If "viewed" ever becomes a GATE: land withheld until the
 * pass completes, or a mark someone else relies on, revisit this: a bulk tick over a gate is a rubber stamp.)
 *
 * The row's own two glyphs, so this reads as that control at a larger scope rather than a new one. There is no
 * third, indeterminate glyph: partial progress is stated as a fraction on the heading's count instead, because
 * "3/12" is the thing the reviewer actually wants to know and a half-filled box isn't.
 *
 * The scope is stated in the tooltip, with its count, because this is the one control here that acts on files
 * the pointer isn't on, and the count is what tells a stray click apart from an intended sweep. */
import { ui } from "@intentic/ui";

const { name, total, viewed } = defineProps<{
    // The heading this belongs to: a repo id or a module name, named in the tooltip so a sweep says what it
    // will sweep.
    name: string;
    // Rows UNDER THE CURRENT FILTER, not in the group as a whole: what you see is what a tick acts on, so
    // standing in Code cannot silently tick a package's tests off too.
    total: number;
    viewed: number;
}>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
    <button
        type="button"
        :class="
            ui.iconButton(
                `h-5 w-6 rounded max-md:h-8 max-md:w-9`,
                viewed === total
                    ? `text-success`
                    : viewed > 0
                      ? ``
                      : // Untouched groups keep it on hover, like the rows below them, a list nobody has started
                        // reading should be a list of files, not a column of empty boxes. Once a group carries
                        // progress the mark is a READOUT ('this package is done'), and hiding a readout until
                        // hover hides the answer.
                        `opacity-0 focus-visible:opacity-100 group-hover/head:opacity-100 max-md:opacity-100`,
            )
        "
        @click="emit('toggle')"
        v-tooltip.right="viewed === total ? `Unmark all ${total} in ${name}` : `Mark all ${total} in ${name} as reviewed`"
        :aria-label="viewed === total ? `Unmark all ${total} files in ${name} as reviewed` : `Mark all ${total} files in ${name} as reviewed`"
    >
        <Icon :name="viewed === total ? 'check-square' : 'check'" class="text-2xs" />
    </button>
</template>
