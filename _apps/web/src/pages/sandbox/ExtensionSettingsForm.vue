<script setup lang="ts">
import type { SettingContribution, SettingValue } from "@intentic/extension-api";
import { cmp, Picker } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { onMounted } from "vue";
import { extensionSettingsStore } from "../../composables/extensions/useExtensionSettings";

/* One extension's declared settings (contributes.settings), rendered schema-driven: boolean → toggle, enum →
 * select, string/number → input, secret → write-only password box. Values live in the shared per-extension
 * store, so a running extension's api.settings sees an edit here immediately.
 *
 * It is its own component because it is the one part of the Extensions tab that is a FORM. The tab around it is
 * a list to be scanned; a form is read line by line, and mixing the two is what made every settings-bearing row
 * three times the height of its neighbours before the rows learned to expand. */

const { extensionId, settings } = defineProps<{ extensionId: string; settings: readonly SettingContribution[] }>();

const store = () => extensionSettingsStore(extensionId);

// This component only mounts inside an OPEN row, so mounting is the lazy load: opening the tab no longer costs
// one daemon round-trip per settings-bearing extension. The store is shared with the extension host, which has
// already loaded it for any UI extension it activated — hence the guard rather than an unconditional fetch.
onMounted(() => {
    if (store().values.value === undefined) {
        void store().load();
    }
});

const valueOf = (setting: SettingContribution): SettingValue | undefined => store().values.value?.[setting.key] ?? setting.default;

const setValue = (setting: SettingContribution, value: SettingValue): void => {
    void store().save({ ...store().values.value, [setting.key]: value });
};

// A secret setting's value is never sent to the browser — the form only knows whether one is stored.
const secretIsSet = (setting: SettingContribution): boolean => store().secretsSet.value.includes(setting.key);
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <div v-for="setting in settings" :key="setting.key" class="flex items-start justify-between gap-4">
            <div class="min-w-0 pt-1">
                <p class="text-xs text-content">{{ setting.title }}</p>
                <p v-if="setting.description" class="text-2xs text-muted">{{ setting.description }}</p>
                <!-- The setting the agent's shell will see under this name — the reason a value here reaches a
                     CLI tool at all, and invisible everywhere else. -->
                <p v-if="setting.env" class="text-2xs text-subtle">
                    reaches the agent as <span class="font-mono">{{ setting.env }}</span>
                </p>
            </div>
            <!-- Secret settings: write-only. The stored value never reaches the browser; typing a new one
                 replaces it, clearing the box and saving clears it. -->
            <input
                v-if="setting.secret === true"
                type="password"
                autocomplete="off"
                :class="cmp.input(`w-48 shrink-0 py-1 text-xs`)"
                :placeholder="secretIsSet(setting) ? `•••••• (set)` : `Enter value`"
                :aria-label="setting.title"
                @change="(event) => setValue(setting, (event.target as HTMLInputElement).value)"
            />
            <!-- Compact, like the row switch this form opens under: two sizes of the same control in one
                 panel reads as two kinds of control. -->
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
                :class="cmp.input(`w-48 shrink-0 py-1 text-xs`)"
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
