<script setup lang="ts">
import { S2S_CLAIM_VALUE_MAX } from "@intentic/sandbox-contract/schemas/s2s";
import { Picker, type PickerOption, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import type { ClaimField } from "../../models/messages/attestations";
import { claimChoices, claimLabel } from "../../models/messages/claimWords";

// THE CLAIMS OF A VOUCH, as a person fills them in: each claim its label and its control, nothing more. What the subject
// is and how it was checked are chosen from the words every reader shares; a country, a name or an organisation is typed;
// over 18 is a switch. A claim a request named that has no field of its own is typed under its own name. Left empty or
// off, a claim is not made.

const fields = defineModel<ClaimField[]>({ required: true });
const { disabled = false } = defineProps<{ disabled?: boolean }>();

const t = useT();
const NOT_CLAIMED = ``;
const optionsOf = (key: string): readonly PickerOption<string>[] => [
    { value: NOT_CLAIMED, label: t(`sandbox.messages.claims.notClaimed`) },
    ...claimChoices(key).map((choice) => ({ value: choice.value, label: choice.label })),
];
</script>

<template>
    <div class="flex flex-col gap-2" data-claims-fields>
        <label v-for="field in fields" :key="field.key" class="flex items-center gap-3" :data-claim-field="field.key">
            <span class="w-28 shrink-0 text-xs text-muted">{{ claimLabel(field.key) }}</span>
            <ToggleSwitch v-if="field.kind === `yesNo`" v-model="field.checked" class="ui-switch-sm" :disabled="disabled" :aria-label="claimLabel(field.key)" />
            <Picker
                v-else-if="claimChoices(field.key).length > 0"
                v-model="field.text"
                :options="optionsOf(field.key)"
                :disabled="disabled"
                variant="input"
                :aria-label="claimLabel(field.key)"
                :header="claimLabel(field.key)"
                class="ui-field-sm w-56"
            />
            <input
                v-else
                v-model="field.text"
                type="text"
                autocomplete="off"
                :maxlength="S2S_CLAIM_VALUE_MAX"
                :disabled="disabled"
                :aria-label="claimLabel(field.key)"
                :class="ui.input({ size: `sm` }, `w-56`)"
            />
        </label>
    </div>
</template>
