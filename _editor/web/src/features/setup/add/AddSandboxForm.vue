<!-- THE ADD SANDBOX FORM: a name and where it runs, one press (useAddSandbox.ts). Drawn by the dialog (AddSandboxDialog.vue)
     and by Home's new sandbox in place (features/home/newSandbox/HomeNewSandbox.vue); each puts its own buttons in the
     slot or its footer. Enter in the name field submits, through `submit` rather than straight to the run, so each place
     takes the press its own way. -->
<script setup lang="ts">
import { Notice, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { AddSandboxHere } from "./useAddSandboxHere";

const { add } = defineProps<{ add: AddSandboxHere[`add`] }>();
// The press, as each place takes it: the dialog creates, Home's page also puts up the new sandbox's tile first.
const emit = defineEmits<{ submit: [] }>();

const t = useT();
const { name, problem, pick, options, loaded, creating, error } = add;
const nothingOffered = computed(() => loaded.value && options.value.length === 0);
</script>

<template>
    <form class="flex flex-col gap-4" data-add-sandbox @submit.prevent="emit(`submit`)">
        <label class="ui-field">
            <span class="ui-field-label">{{ t(`shared.name`) }}</span>
            <input v-model="name" autofocus :maxlength="80" :class="[ui.input(), problem ? `ui-field-error-box` : ``]" data-add-sandbox-name />
            <span v-if="problem" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ problem }}
            </span>
        </label>

        <div class="flex flex-col gap-1.5">
            <span class="ui-field-label">{{ t(`setup.setupOnMachine.runsOn`) }}</span>
            <p v-if="!loaded" class="flex items-center gap-2 text-xs text-muted">
                <Icon name="spinner" spin class="text-xs" />
                {{ t(`setup.addSandbox.lookingForMachines`) }}
            </p>
            <p v-else-if="nothingOffered" class="text-xs text-muted">{{ t(`setup.addSandbox.nothingInOnePress`) }}</p>
            <fieldset v-else :disabled="creating" class="min-w-0">
                <!-- Drawn only with something on offer, so a pick always stands. -->
                <SegmentedControl
                    :model-value="pick ?? ``"
                    :options="options"
                    :wrap="true"
                    :aria-label="t(`setup.setup.whereSandboxRuns`)"
                    @update:model-value="(value: string) => (pick = value)"
                />
            </fieldset>
        </div>

        <Notice v-if="error" :of="error" />
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true"></button>
        <slot />
    </form>
</template>
