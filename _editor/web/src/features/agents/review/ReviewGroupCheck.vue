<script setup lang="ts">
// Per-group "viewed" tick: reader place-keeping, not an approval gate. Two states only; partial progress shows as
// a count instead of a third glyph. Toggling acts on rows under the current filter, not the whole group.
import { ui, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

const t = useT();
const { mobile } = useDevice();

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
                { size: mobile ? `lg` : `sm` },
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
        v-tooltip.right="{
            title: viewed === total ? t(`agents.reviewGroupCheck.unmarkAll`) : t(`agents.reviewGroupCheck.markAll`),
            rows: [
                { label: t(`shared.files`), value: total },
                { label: t(`agents.reviewGroupCheck.group`), value: name },
            ],
        }"
        :aria-label="
            viewed === total
                ? t(`agents.reviewGroupCheck.unmarkAllFilesIn`, { total, name })
                : t(`agents.reviewGroupCheck.markAllFilesIn`, { total, name })
        "
    >
        <Icon :name="viewed === total ? 'check-square' : 'check'" class="text-2xs" />
    </button>
</template>
