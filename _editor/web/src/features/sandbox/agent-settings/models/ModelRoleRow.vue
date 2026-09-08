<script setup lang="ts">
import type { ModelRoleSpec } from "@intentic/sandbox-contract";
import { type IconName, Row, StatusBadge, useDevice } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import Checkbox from "primevue/checkbox";
import { computed } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";

// One job's row (name, mark, tick, ordered model list), componentized since eighteen of these are drawn from the
// catalog. The lead glyph and the selection tick share one slot, swapping on hover, focus or selection rather than
// sitting side by side; the whole row is a `<label>`, so `#below` must stop clicks from ticking the job by accident.

const { role, icon, list, selected, disabled, loaded } = defineProps<{
    role: ModelRoleSpec;
    // Crosses the wire as an open string; checked, not asserted, and falls back if this build's icon set lacks it.
    icon: string;
    list: PinnedList;
    selected: boolean;
    /** The row's controls are inert: settings not read yet, or this job's feature switched off elsewhere. */
    disabled: boolean;
    // Whether settings have landed; the chip claims what this job will do, so it can't draw before that's true.
    loaded: boolean;
}>();

const emit = defineEmits<{ select: [boolean]; open: [number | undefined, HTMLElement] }>();

const glyph = computed<IconName>(() => (isIconName(icon) ? icon : `sparkles`));
const pinned = computed<boolean>(() => list.entries.value.length > 0);

// Two reasons a row can't be selected: mobile (no box, only the glyph) or disabled, since bulk actions would write
// models into a job whose own Add button is already refused.
const { mobile } = useDevice();
const selectable = computed<boolean>(() => !mobile.value && !disabled);

// Two static class lists, not a reactive flag: pointer state is CSS-only, and Tailwind's scanner needs the classes
// spelled out, not interpolated. Empty on phone, where there's no box to swap to.
const glyphClass = computed<string>(() => {
    if (!selectable.value) {
        return ``;
    }
    return selected ? `opacity-0` : `group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0`;
});
const boxClass = computed<string>(() =>
    selected ? `opacity-100` : `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100`,
);

// Empty means something different per job kind: a one-shot doesn't run at all, a whole session opens on the chat's own
// model. Both are normal, so the chip stays neutral, not a warning.
const chip = computed<{ readonly label: string; readonly hint: string } | undefined>(() => {
    if (!loaded || pinned.value) {
        return undefined;
    }
    return role.kind === `helper`
        ? { label: `off`, hint: `Not set: this job does not run, and no model is chosen for you. Add a model to switch it on.` }
        : {
              label: `chat default`,
              hint: `Nothing is pinned, so this runs on whatever your chat is set to and keeps following it as you change it. Add a model to pin this job to a tier of its own.`,
          };
});
</script>

<template>
    <!--
        Spine follows what's below: a pinned list, or the note slot; neither means nothing draws. `#below` needs the indent the old checkbox column
        gave for free, now that the mark swap replaced it.
    -->
    <Row :as="selectable ? `label` : `div`" :selected="selected" :spine="pinned || $slots[`note`] !== undefined" :description="role.blurb">
        <!--
            Sized from the tier's own `mark`, not a literal number, so the lead column matches every row at every density; the tick centers on the
            glyph rather than sitting beside it.
        -->
        <template #lead="{ mark, iconClass }">
            <span class="relative flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                <Icon :name="glyph" aria-hidden="true" class="text-muted transition-opacity" :class="[iconClass, glyphClass]" />
                <Checkbox
                    v-if="selectable"
                    :model-value="selected"
                    binary
                    size="small"
                    class="absolute transition-opacity"
                    :class="boxClass"
                    :aria-label="`Select ${role.label.toLowerCase()}`"
                    @update:model-value="(value: unknown) => emit(`select`, value === true)"
                />
            </span>
        </template>

        <!--
            flex-wrap: a long job label may push the chip to its own line before pushing off the row. The chip sits snug against the name rather than
            below it, so it doesn't read as a heading for the description.
        -->
        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="min-w-0">{{ role.label }}</span>
                <StatusBadge v-if="chip !== undefined" v-tooltip.top="chip.hint" variant="neutral" size="xs" :label="chip.label" />
            </span>
        </template>

        <template #control>
            <AddModelButton
                :label="`Add a model for ${role.label.toLowerCase()}`"
                :disabled="disabled"
                @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
            />
        </template>

        <!--
            The row is a `<label>`: without this, pressing a control under the headline (re-point, reorder, remove) would also tick the job. `<Row>`
            does the same for `#control`; `#below` is the caller's to guard.
        -->
        <template v-if="pinned || $slots[`note`]" #below>
            <div class="flex flex-col gap-2" @click.stop>
                <!-- Each entry shows its tier beside the model; `noteThinking` flags one-shots, where reasoning adds latency. -->
                <ModelPinList
                    v-if="pinned"
                    :entries="list.entries.value"
                    :note-thinking="role.kind === `helper`"
                    @promote="list.promote"
                    @remove="list.remove"
                    @edit="(index: number, anchor: HTMLElement) => emit(`open`, index, anchor)"
                />
                <!-- Whatever this job owes its reader; opt-in, since only one row in eighteen needs it. -->
                <slot name="note" />
            </div>
        </template>
    </Row>
</template>
