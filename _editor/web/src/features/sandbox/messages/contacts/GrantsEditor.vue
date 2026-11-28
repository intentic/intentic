<script setup lang="ts">
import { LINK_TURNS_PER_HOUR_DEFAULT } from "@intentic/sandbox-contract/schemas/links";
import { S2S_GRANT_KINDS, type S2sGrantKind, type S2sGrants, type S2sGrantsUpdate, type S2sTaskGrant } from "@intentic/sandbox-contract/schemas/s2s";
import { InfoHint, Picker, type PickerOption, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { useRoles } from "../../../../models/sandbox/roles/useRoles";
import { grantLabel } from "../../../../models/messages/grantWords";

// WHAT A CONTACT MAY DO HERE, one switch per grant, each its label and its control, what it lets the contact do behind
// its (i). A task grant opens its own terms under it, the link terms under their own names: whether each task waits for
// a person here, how many turns an hour, and the role they wear. Every change goes out at once as the one field it
// changed (`change`); the caller writes it, or keeps it as a draft for an Accept. Operating is for a contact that is a
// sandbox as itself, never a person's route, as the daemon holds it.

const props = defineProps<{
    grants: S2sGrants;
    /** A person-scoped contact, which may never operate this sandbox. */
    personal?: boolean;
    disabled?: boolean;
}>();
const emit = defineEmits<{ change: [change: S2sGrantsUpdate] }>();

const t = useT();
const { roles } = useRoles();

const TURNS = { min: 1, max: 120 } as const;
const NO_ROLE = ``;
const roleOptions = computed<readonly PickerOption<string>[]>(() => [
    { value: NO_ROLE, label: t(`sandbox.messages.grants.noRole`) },
    ...roles.value.map((role) => ({ value: role.id, label: role.label ?? role.id })),
]);

const on = (kind: S2sGrantKind): boolean => (kind === `task` ? props.grants.task !== undefined : props.grants[kind]);
const held = (kind: S2sGrantKind): boolean => props.disabled === true || (kind === `operate` && props.personal === true);

// Each switch sends its own field; turning tasks on starts them asking a person first, at the links' hourly default.
const flip = (kind: S2sGrantKind, value: boolean): void => {
    if (kind === `task`) {
        emit(`change`, { task: value ? { approve: true, turnsPerHour: LINK_TURNS_PER_HOUR_DEFAULT } : null });
        return;
    }
    const change: S2sGrantsUpdate = {};
    change[kind] = value;
    emit(`change`, change);
};

const task = computed(() => props.grants.task);
const changeTask = (patch: Partial<S2sTaskGrant>): void => {
    const current = task.value;
    if (current === undefined) {
        return;
    }
    const next: S2sTaskGrant = { ...current, ...patch };
    if (patch.actsAs === NO_ROLE) {
        delete next.actsAs;
    }
    emit(`change`, { task: next });
};
// The number goes once it is left or Enter is pressed, never mid-typing, and only within its bounds.
const writeTurns = (event: Event): void => {
    const typed = event.target instanceof HTMLInputElement ? event.target.valueAsNumber : Number.NaN;
    if (Number.isInteger(typed) && typed >= TURNS.min && typed <= TURNS.max && typed !== task.value?.turnsPerHour) {
        changeTask({ turnsPerHour: typed });
    }
};
</script>

<template>
    <div class="flex flex-col divide-y divide-line-subtle" data-grants>
        <div v-for="kind in S2S_GRANT_KINDS" :key="kind" class="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
            <div class="flex items-center gap-1.5">
                <span class="text-sm text-content" :class="held(kind) ? `opacity-60` : ``">{{ grantLabel(kind).label }}</span>
                <InfoHint :label="grantLabel(kind).label">
                    <span class="block text-xs text-content">{{ grantLabel(kind).hint }}</span>
                    <span v-if="kind === `operate` && personal" class="mt-1 block text-xs text-muted">{{ t(`sandbox.messages.grants.operateSandboxOnly`) }}</span>
                </InfoHint>
                <ToggleSwitch
                    class="ui-switch-sm ml-auto"
                    :model-value="on(kind)"
                    :disabled="held(kind)"
                    :aria-label="grantLabel(kind).label"
                    :data-grant="kind"
                    @update:model-value="flip(kind, $event)"
                />
            </div>
            <!-- The task grant's own terms, under it while it is on. -->
            <div v-if="kind === `task` && task" class="flex flex-wrap items-center gap-x-4 gap-y-2 pl-3">
                <label class="flex items-center gap-2 text-xs text-content">
                    <ToggleSwitch class="ui-switch-sm" :model-value="task.approve" :disabled="disabled" @update:model-value="changeTask({ approve: $event })" />
                    {{ t(`sandbox.messages.grants.approve`) }}
                </label>
                <label class="flex items-center gap-2 text-xs text-content">
                    <input
                        :value="task.turnsPerHour"
                        type="number"
                        :min="TURNS.min"
                        :max="TURNS.max"
                        :disabled="disabled"
                        :class="ui.input({ size: `sm` }, `w-16`)"
                        @change="writeTurns"
                        @keydown.enter.prevent="writeTurns"
                    />
                    {{ t(`sandbox.messages.grants.turnsPerHour`) }}
                </label>
                <Picker
                    :model-value="task.actsAs ?? NO_ROLE"
                    :options="roleOptions"
                    :disabled="disabled"
                    variant="input"
                    :aria-label="t(`sandbox.messages.grants.actsAs`)"
                    :header="t(`sandbox.messages.grants.actsAs`)"
                    class="ui-field-sm w-44"
                    @update:model-value="changeTask({ actsAs: $event })"
                />
            </div>
        </div>
    </div>
</template>
