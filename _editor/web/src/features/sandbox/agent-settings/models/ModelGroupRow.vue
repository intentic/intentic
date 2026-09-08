<script setup lang="ts">
import type { ModelRoleBlock, ModelRoleSpec } from "@intentic/sandbox-contract";
import { Row, StatusBadge } from "@intentic/ui";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";

// Collapsed, one-row view of a job block (vs. <ModelRoleRow>'s per-job Advanced view); not a separate setting, it
// writes the same list into every role of the block as one patch. When jobs disagree it shows their intersection and
// flags "differs" rather than hiding the gap; `roles` is handed in since availability varies per job.

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
const title = computed<string>(() => `One list for all ${roles.length} jobs`);

// Names which jobs, since a row writing several settings owes their names.
const jobs = computed<string>(() => roles.map((role) => role.label).join(`, `));

// Three states; "jobs differ" outranks the others, since "off" would misstate jobs that do hold models of their own.
// Empty-state wordings mirror <ModelRoleRow>'s, said for the whole block.
const chip = computed<{ readonly label: string; readonly hint: string } | undefined>(() => {
    if (!loaded) {
        return undefined;
    }
    if (differs) {
        return {
            label: `jobs differ`,
            hint: `These jobs do not all hold the same models. Listed here is what every one of them has; a change made here gives them all exactly this list. Switch to Advanced to see them apart.`,
        };
    }
    if (pinned.value) {
        return undefined;
    }
    return block.id === `helper`
        ? { label: `off`, hint: `Not set: none of these jobs runs, and no model is chosen for you. Add a model to switch them on.` }
        : {
              label: `chat default`,
              hint: `Nothing is pinned, so these run on whatever your chat is set to and keep following it as you change it. Add a model to pin them to a tier of their own.`,
          };
});
</script>

<template>
    <!-- Not selectable like the job rows: this row is the whole group, so `#below` needs no click guarding. -->
    <Row :spine="pinned || $slots[`note`] !== undefined" :description="jobs">
        <!--
            Sized from the tier's own `mark`, not a literal number, so the text column doesn't shift between views. `boxes` is the plural glyph for a
            set of jobs.
        -->
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
                :label="`Add a model for every ${block.label.toLowerCase()} job`"
                :disabled="disabled"
                @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
            />
        </template>

        <template v-if="pinned || $slots[`note`]" #below>
            <div class="flex flex-col gap-2">
                <!--
                    Same list and gestures as the per-job rows; each write lands the whole order into every job in the block. `noteThinking` is set
                    for one-shots, where reasoning adds latency to a job meant to land immediately.
                -->
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
