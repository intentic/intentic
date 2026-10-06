<script setup lang="ts">
import type { ModelRoleBlock, ModelRoleSpec } from "@intentic/sandbox-contract";
import { Row, StatusBadge, type Tip } from "@intentic/ui";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import { blockLabel, roleLabel } from "./roleWords";
import { useT } from "@intentic/ui/i18n";

// Collapsed, one-row view of a job block (vs. <ModelRoleRow>'s per-job Advanced view); not a separate setting, it
// writes the same list into every role of the block as one patch. When jobs disagree it shows their intersection and
// flags "differs" rather than hiding the gap; `roles` is handed in since availability varies per job.

const t = useT();

const { block, roles, list, differs, disabled, loaded } = defineProps<{
    /** Block being collapsed; its heading names the Add button and its id words the empty chip. */
    block: ModelRoleBlock;
    /** Jobs this row actually writes: the block's, minus any that can't run right now. */
    roles: readonly ModelRoleSpec[];
    /** The shared list over those jobs: reads what all of them hold, writes all of them. */
    list: PinnedList;
    /** Whether the block's jobs hold different lists (this row is then showing less than the full setting). */
    differs: boolean;
    /** Inert while the settings have not been read. */
    disabled: boolean;
    // Whether settings have landed; the chip claims what these jobs will do, so it can't draw before that's true.
    loaded: boolean;
}>();

const emit = defineEmits<{ open: [number | undefined, HTMLElement] }>();

const pinned = computed<boolean>(() => list.entries.value.length > 0);

// Count is the point (how many jobs one press writes), so it's in the title, not a separate badge.
const title = computed<string>(() => t(`sandbox.modelGroupRow.oneListForAllJobs`, { count: roles.length }, roles.length));

// Names which jobs, since a row writing several settings owes their names.
const jobs = computed<string>(() => roles.map((role) => roleLabel(role)).join(`, `));

// Three states; "jobs differ" outranks the others, since "off" would misstate jobs that do hold models of their own.
// Empty-state wordings mirror <ModelRoleRow>'s, said for the whole block.
const chip = computed<{ readonly label: string; readonly hint: Tip } | undefined>(() => {
    if (!loaded) {
        return undefined;
    }
    if (differs) {
        return {
            label: t(`sandbox.modelGroupRow.jobsDiffer`),
            hint: { title: t(`sandbox.modelGroupRow.overlapOnly`), note: t(`sandbox.modelGroupRow.editsSetEveryJob`) },
        };
    }
    if (pinned.value) {
        return undefined;
    }
    return block.id === `helper`
        ? { label: t(`sandbox.modelGroupRow.off`), hint: { title: t(`sandbox.words.notSet`), note: t(`sandbox.words.addModelToEnable`) } }
        : {
              label: t(`sandbox.words.chatDefault`),
              hint: { title: t(`sandbox.words.followsChat`), note: t(`sandbox.words.addModelToPin`) },
          };
});
</script>

<template>
    <!-- Not selectable like the job rows: this row is the whole group, so `#below` needs no click guarding. -->
    <Row :spine="pinned || $slots[`note`] !== undefined" :description="jobs">
        <!-- Sized from the tier's own `mark`, not a literal number, so the text column doesn't shift between views. -->
        <template #lead="{ mark, iconClass }">
            <span class="flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                <Icon name="boxes" aria-hidden="true" class="text-muted" :class="iconClass" />
            </span>
        </template>

        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="min-w-0">{{ title }}</span>
                <StatusBadge v-if="chip !== undefined" v-tooltip.top="chip.hint" variant="neutral" size="xs" :label="chip.label" />
            </span>
        </template>

        <template #control>
            <!-- Named for the group: the accessible name is what distinguishes this button from the per-job ones. -->
            <AddModelButton
                :label="t(`sandbox.modelGroupRow.addModelEveryJob`, { toLowerCase: blockLabel(block).toLowerCase() })"
                :disabled="disabled"
                @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
            />
        </template>

        <template v-if="pinned || $slots[`note`]" #below>
            <div class="flex flex-col gap-2">
                <!-- Same list and gestures as the per-job rows; each write lands the whole order into every job in the block. -->
                <ModelPinList
                    v-if="pinned"
                    :entries="list.entries.value"
                    :note-thinking="block.id === `helper`"
                    @promote="list.promote"
                    @remove="list.remove"
                    @edit="(index: number, anchor: HTMLElement) => emit(`open`, index, anchor)"
                />
                <!-- Whatever the page left out of this row (e.g. a job excluded from the count), in the page's own words. -->
                <slot name="note" />
            </div>
        </template>
    </Row>
</template>
