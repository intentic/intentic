<script setup lang="ts">
// Per-group "viewed" tick: reader place-keeping, not an approval gate. Two states only; partial progress shows as
// a count instead of a third glyph. Toggling acts on rows under the current filter, not the whole group.
import { ui } from "@intentic/ui";

const { name, total, viewed } = defineProps<{
    // Heading this belongs to (repo id or module name); named in the tooltip so a sweep states its target.
    name: string;
    // Rows under the current filter, not the whole group; a tick acts only on what is visible.
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
