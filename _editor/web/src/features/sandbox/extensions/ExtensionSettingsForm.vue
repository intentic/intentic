<script setup lang="ts">
import type { SettingValue } from "@intentic/extension-api";
import type { SettingContribution } from "@intentic/extension-manifest";
import { ui, Picker } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { onMounted } from "vue";
import { extensionSettingsStore } from "../../extensions/useExtensionSettings";

// One extension's declared settings, rendered schema-driven by type (boolean, enum, string/number, secret). Values live
// in the shared per-extension store, so a running extension's api.settings sees an edit immediately. Its own component
// since it's the one form inside a list meant to be scanned, not read line by line.

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
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <div v-for="setting in settings" :key="setting.key" class="flex items-start justify-between gap-4">
            <div class="min-w-0 pt-1">
                <p class="text-xs text-content">{{ setting.title }}</p>
                <p v-if="setting.description" class="text-2xs text-muted">{{ setting.description }}</p>
                <!-- The env var name the agent's shell sees this value under; invisible everywhere else. -->
                <p v-if="setting.env" class="text-2xs text-subtle">
                    reaches the agent as <span class="font-mono">{{ setting.env }}</span>
                </p>
            </div>
            <!-- Write-only: the stored value never reaches the browser; typing a new one replaces it, and saving empty clears it. -->
            <input
                v-if="setting.secret === true"
                type="password"
                autocomplete="off"
                :class="ui.inputSm(`w-48 shrink-0`)"
                :placeholder="secretIsSet(setting) ? `•••••• (set)` : `Enter value`"
                :aria-label="setting.title"
                @change="(event) => setValue(setting, (event.target as HTMLInputElement).value)"
            />
            <!-- Compact, matching the row switch this form opens under: two switch sizes in one panel would read as two controls. -->
            <ToggleSwitch
                v-else-if="setting.type === `boolean`"
                class="ui-switch-sm"
                :model-value="valueOf(setting) === true"
                :aria-label="setting.title"
                @update:model-value="(value: boolean) => setValue(setting, value)"
            />
            <Picker
                v-else-if="setting.type === `enum`"
                class="w-48 shrink-0"
                :model-value="String(valueOf(setting) ?? ``) || undefined"
                :options="(setting.enum ?? []).map((option) => ({ value: option, label: option }))"
                placeholder="Choose…"
                :aria-label="setting.title"
                @update:model-value="(value: string | undefined) => value !== undefined && setValue(setting, value)"
            />
            <input
                v-else
                :class="ui.inputSm(`w-48 shrink-0`)"
                :type="setting.type === `number` ? `number` : `text`"
                :value="String(valueOf(setting) ?? ``)"
                :aria-label="setting.title"
                @change="
                    (event) =>
                        setValue(
                            setting,
                            setting.type === `number` ? Number((event.target as HTMLInputElement).value) : (event.target as HTMLInputElement).value,
                        )
                "
            />
        </div>
    </div>
</template>
