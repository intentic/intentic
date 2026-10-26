<script setup lang="ts">
import type { SettingValue } from "@intentic/extension-api";
import type { SettingContribution } from "@intentic/extension-manifest";
import { ui, Picker } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { onMounted } from "vue";
import { extensionSettingsStore } from "../../extensions/useExtensionSettings";
import { useT } from "@intentic/ui/i18n";

// One extension's declared settings, rendered schema-driven by type (boolean, enum, string/number, secret). Values live
// in the shared per-extension store, so a running extension's api.settings sees an edit immediately.
//
// Each setting reads as a title with its control at the end of the same line and its description underneath at the
// form's full width: a description beside a control was squeezed into a column a few words wide. An enum whose choices
// each carry a line of their own (`enumDescriptions`) is listed choice by choice, since what picking one means is the
// thing being decided and a dropdown hides it until opened.

const t = useT();

const { extensionId, settings } = defineProps<{ extensionId: string; settings: readonly SettingContribution[] }>();

const store = () => extensionSettingsStore(extensionId);

// Mounts only inside an open row, so this is the lazy load: no round-trip per settings-bearing extension until opened.
// Guarded since an active UI extension's host may have already loaded this store.
onMounted(() => {
    if (store().values.value === undefined) {
        void store().load();
    }
});

const valueOf = (setting: SettingContribution): SettingValue | undefined => store().values.value?.[setting.key] ?? setting.default;

const setValue = (setting: SettingContribution, value: SettingValue): void => {
    void store().save({ ...store().values.value, [setting.key]: value });
};

// A secret setting's value is never sent to the browser: the form only knows whether one is stored.
const secretIsSet = (setting: SettingContribution): boolean => store().secretsSet.value.includes(setting.key);

// The choices by name, with their lines where the manifest gave them; a choice without a name shows its value.
const choicesOf = (setting: SettingContribution): { value: string; label: string; description: string | undefined }[] =>
    (setting.enum ?? []).map((value, index) => ({
        value,
        label: setting.enumItemLabels?.[index] ?? value,
        description: setting.enumDescriptions?.[index] || undefined,
    }));
const listed = (setting: SettingContribution): boolean => setting.type === `enum` && (setting.enumDescriptions?.length ?? 0) > 0;
const radioName = (setting: SettingContribution): string => `${extensionId}:${setting.key}`;
</script>

<template>
    <div class="flex flex-col gap-6">
        <div v-for="setting in settings" :key="setting.key" class="flex flex-col gap-1">
            <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <p class="min-w-0 flex-1 text-sm font-medium text-content">{{ setting.title }}</p>
                <!-- Write-only: the stored value never reaches the browser; typing a new one replaces it, and saving empty clears it. -->
                <input
                    v-if="setting.secret === true"
                    type="password"
                    autocomplete="off"
                    :class="ui.input({ size: `sm` }, `w-56 shrink-0`)"
                    :placeholder="secretIsSet(setting) ? t(`sandbox.extensionSettingsForm.set`) : t(`sandbox.extensionSettingsForm.enterValue`)"
                    :aria-label="setting.title"
                    @change="(event) => setValue(setting, (event.target as HTMLInputElement).value)"
                />
                <!-- Compact, matching the switch at the head of the page: two switch sizes on one page read as two kinds of control. -->
                <ToggleSwitch
                    v-else-if="setting.type === `boolean`"
                    class="ui-switch-sm shrink-0"
                    :model-value="valueOf(setting) === true"
                    :aria-label="setting.title"
                    @update:model-value="(value: boolean) => setValue(setting, value)"
                />
                <Picker
                    v-else-if="setting.type === `enum` && !listed(setting)"
                    class="w-56 shrink-0"
                    :model-value="String(valueOf(setting) ?? ``) || undefined"
                    :options="choicesOf(setting).map(({ value, label }) => ({ value, label }))"
                    :placeholder="t(`sandbox.extensionSettingsForm.choose`)"
                    :aria-label="setting.title"
                    @update:model-value="(value: string | undefined) => value !== undefined && setValue(setting, value)"
                />
                <input
                    v-else-if="setting.type !== `enum`"
                    :class="ui.input({ size: `sm` }, `w-56 shrink-0`)"
                    :type="setting.type === `number` ? `number` : `text`"
                    :value="String(valueOf(setting) ?? ``)"
                    :aria-label="setting.title"
                    @change="
                        (event) =>
                            setValue(
                                setting,
                                setting.type === `number`
                                    ? Number((event.target as HTMLInputElement).value)
                                    : (event.target as HTMLInputElement).value,
                            )
                    "
                />
            </div>

            <p v-if="setting.description && !listed(setting)" class="max-w-prose text-xs leading-relaxed text-muted">{{ setting.description }}</p>

            <!-- Each choice is the whole row to press, its line under its name; the picked one is marked by its dot and weight. -->
            <div v-if="listed(setting)" role="radiogroup" :aria-label="setting.title" class="-mx-2 mt-1 flex flex-col">
                <label
                    v-for="choice in choicesOf(setting)"
                    :key="choice.value"
                    class="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-content/5"
                >
                    <input
                        type="radio"
                        class="mt-1 shrink-0 accent-primary-600"
                        :name="radioName(setting)"
                        :value="choice.value"
                        :checked="String(valueOf(setting) ?? ``) === choice.value"
                        @change="setValue(setting, choice.value)"
                    />
                    <span class="min-w-0">
                        <span
                            class="block text-sm"
                            :class="String(valueOf(setting) ?? ``) === choice.value ? `font-medium text-content` : `text-muted`"
                            >{{ choice.label }}</span
                        >
                        <span v-if="choice.description" class="block max-w-prose text-xs leading-relaxed text-subtle">{{ choice.description }}</span>
                    </span>
                </label>
            </div>

            <!-- Under a list of choices, what holds whichever is picked reads as its footnote. -->
            <p v-if="setting.description && listed(setting)" class="mt-1 max-w-prose text-xs leading-relaxed text-subtle">
                {{ setting.description }}
            </p>

            <!-- The env var name the agent's shell sees this value under; invisible everywhere else. -->
            <p v-if="setting.env" class="text-2xs text-subtle">
                {{ t(`sandbox.extensionSettingsForm.reachesAgent`) }} <span class="font-mono">{{ setting.env }}</span>
            </p>
        </div>
    </div>
</template>
