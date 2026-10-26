<!-- Who an automation's wakes act as, by the persona's own face and name, picked where it is shown. -->
<script setup lang="ts">
import type { Automation, AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Picker } from "@intentic/extension-ui";
import { computed, reactive, watch } from "vue";
import { usePersonaOptions } from "../persona/personaOptions";
import PropertyRow from "./PropertyRow.vue";
import { useAutomationPatch } from "./useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

// The picker's own model, held here so a refused save can be put back to what is stored rather than left showing a
// choice the daemon never took. Blank is the built-in No accounts.
const choice = reactive({ actsAs: props.automation.actsAs ?? ``, senderRules: [] });
watch(
    () => props.automation.actsAs,
    (stored) => {
        choice.actsAs = stored ?? ``;
    },
);

const visitorChat = computed(() => props.automation.trigger.kind === `listener` && props.automation.trigger.provider === `webchat`);
// The same choices the full editor offers, built-ins first and a gone card greyed (personaOptions.ts).
const { personaOptions } = usePersonaOptions(choice, visitorChat);
const options = computed(() => [{ options: personaOptions.value }]);

const { patch, error } = useAutomationPatch(computed(() => props.automation));
const pick = async (id: string | undefined): Promise<void> => {
    const next = id ?? ``;
    if (next === (props.automation.actsAs ?? ``)) {
        return;
    }
    choice.actsAs = next;
    const saved = await patch((stored) => {
        const changed: Automation = { ...stored, actsAs: next };
        if (next === ``) {
            delete changed.actsAs;
        }
        return changed;
    });
    if (!saved) {
        choice.actsAs = props.automation.actsAs ?? ``;
    }
};
</script>

<template>
    <PropertyRow :label="t(`personaProperty.runsAs`)">
        <!-- Ghost, not a field: at rest it is the persona's face and name, and only the pointer finds the control in it. -->
        <Picker
            :model-value="choice.actsAs"
            :options="options"
            variant="ghost"
            :aria-label="t(`personaProperty.runsAs`)"
            :header="t(`personaProperty.runsAs`)"
            class="-mx-2 self-start text-sm"
            @update:model-value="pick"
        />
        <span v-if="error" class="text-xs break-words text-danger">{{ error }}</span>
    </PropertyRow>
</template>
