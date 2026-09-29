<script setup lang="ts">
import type { ModelRoleSpec } from "@intentic/sandbox-contract";
import { type IconName, Row, StatusBadge, type Tip, useDevice } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import Checkbox from "primevue/checkbox";
import { computed, useId } from "vue";
import AddModelButton from "./AddModelButton.vue";
import type { PinnedList } from "./modelPinList";
import ModelPinList from "./ModelPinList.vue";
import { useT } from "@intentic/ui/i18n";

// One job's row (name, mark, tick, ordered model list), componentized since eighteen of these are drawn from the
// catalog. The lead glyph and the selection tick share one slot, swapping on hover, focus or selection rather than
// sitting side by side. Only the tick and the job's name select the row: the row was once a whole `<label>`, and a
// press on its description or note ticked a checkbox nobody could see ("1 selected" on and off under nine presses on
// the safety judge's note). No `.stop` carves that out, since a label's activation is its default action.

const t = useT();

const { role, icon, list, selected, disabled, loaded, badge } = defineProps<{
    role: ModelRoleSpec;
    // Crosses the wire as an open string; checked, not asserted, and falls back if this build's icon set lacks it.
    icon: string;
    list: PinnedList;
    selected: boolean;
    /** The row's controls are inert: settings not read yet, or this job's feature switched off elsewhere. */
    disabled: boolean;
    // Whether settings have landed; the chip claims what this job will do, so it can't draw before that's true.
    loaded: boolean;
    /** A job carrying state its model list cannot show; drawn beside the row's own chip, never instead of it. */
    badge?: { readonly label: string; readonly hint: Tip };
}>();

const emit = defineEmits<{ select: [boolean]; open: [number | undefined, HTMLElement] }>();

const glyph = computed<IconName>(() => (isIconName(icon) ? icon : `sparkles`));
const pinned = computed<boolean>(() => list.entries.value.length > 0);

// Two reasons a row can't be selected: mobile (no box, only the glyph) or disabled, since bulk actions would write
// models into a job whose own Add button is already refused.
const { mobile } = useDevice();
const selectable = computed<boolean>(() => !mobile.value && !disabled);
// What the job's name, as a `<label>`, points at: the tick alone, never the row around it.
const tickId = useId();

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
const chip = computed<{ readonly label: string; readonly hint: Tip } | undefined>(() => {
    if (!loaded || pinned.value) {
        return undefined;
    }
    return role.kind === `helper`
        ? { label: t(`sandbox.modelRoleRow.off`), hint: { title: t(`sandbox.words.notSet`), note: t(`sandbox.words.addModelToEnable`) } }
        : {
              label: t(`sandbox.words.chatDefault`),
              hint: { title: t(`sandbox.words.followsChat`), note: t(`sandbox.words.addModelToPin`) },
          };
});
</script>

<template>
    <!-- Spine follows what's below: a pinned list, or the note slot; neither means nothing draws. -->
    <Row :selected="selected" :spine="pinned || $slots[`note`] !== undefined" :description="role.blurb">
        <!-- The lead size comes from the row tier so density stays consistent. -->
        <template #lead="{ mark, iconClass }">
            <span class="relative flex shrink-0 items-center justify-center" :style="{ width: `${mark}px`, height: `${mark}px` }">
                <Icon :name="glyph" aria-hidden="true" class="text-muted transition-opacity" :class="[iconClass, glyphClass]" />
                <Checkbox
                    v-if="selectable"
                    :model-value="selected"
                    :input-id="tickId"
                    binary
                    size="small"
                    class="absolute transition-opacity"
                    :class="boxClass"
                    :aria-label="t(`sandbox.modelRoleRow.select`, { toLowerCase: role.label.toLowerCase() })"
                    @update:model-value="(value: unknown) => emit(`select`, value === true)"
                />
            </span>
        </template>

        <!-- flex-wrap: a long job label may push the chip to its own line before pushing off the row. -->
        <template #title>
            <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <label v-if="selectable" :for="tickId" class="min-w-0 cursor-pointer">{{ role.label }}</label>
                <span v-else class="min-w-0">{{ role.label }}</span>
                <StatusBadge v-if="chip !== undefined" v-tooltip.top="chip.hint" variant="neutral" size="xs" :label="chip.label" />
                <StatusBadge v-if="badge !== undefined" v-tooltip.top="badge.hint" variant="neutral" size="xs" :label="badge.label" />
            </span>
        </template>

        <!-- A job's own control, ahead of the one every job has: the Add button stays the row's last word. -->
        <template #control>
            <div class="flex items-center gap-1.5">
                <slot name="control" />
                <AddModelButton
                    :label="t(`sandbox.modelRoleRow.addModel`, { toLowerCase: role.label.toLowerCase() })"
                    :disabled="disabled"
                    @open="(anchor: HTMLElement) => emit(`open`, undefined, anchor)"
                />
            </div>
        </template>

        <template v-if="pinned || $slots[`note`]" #below>
            <div class="flex flex-col gap-2">
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
