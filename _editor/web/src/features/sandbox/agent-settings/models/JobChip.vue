<script setup lang="ts">
import { MODEL_ROLES, type ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import { type IconName, ui } from "@intentic/ui";
import { isIconName } from "@intentic/ui/icons";
import { computed, inject } from "vue";
import { JOB_STATE } from "./jobState";
import { roleLabel } from "./roleWords";
import { useT } from "@intentic/ui/i18n";

// One job, where it sits on the page: dragged by mouse or pen to another setup, pressed (or tapped, or Enter) for its
// panel. What it says beside its name is what no model list could show: switched off elsewhere, or carrying guidance.

const t = useT();

const { role, disabled, active } = defineProps<{ role: ModelRole; disabled: boolean; active: boolean }>();
const emit = defineEmits<{ grab: [PointerEvent, HTMLElement]; open: [HTMLElement] }>();

const state = inject(JOB_STATE);
const icon = computed<IconName>(() => {
    const named = MODEL_ROLES.find((spec) => spec.id === role)?.icon ?? ``;
    return isIconName(named) ? named : `sparkles`;
});
const note = computed(() => state?.note(role));
</script>

<template>
    <button
        type="button"
        :class="ui.chip({ on: active }, `cursor-grab touch-manipulation select-none gap-1 px-2 py-1 active:cursor-grabbing`, note?.dim === true && `opacity-60`)"
        :disabled="disabled"
        aria-haspopup="dialog"
        :aria-expanded="active"
        :aria-description="t(`sandbox.agentModels.chipHint`)"
        @pointerdown="emit(`grab`, $event, $event.currentTarget as HTMLElement)"
        @click="emit(`open`, $event.currentTarget as HTMLElement)"
    >
        <Icon :name="icon" class="text-2xs" aria-hidden="true" />
        <span>{{ roleLabel({ id: role }) }}</span>
        <span v-if="note !== undefined" class="text-subtle">· {{ note.text }}</span>
    </button>
</template>
