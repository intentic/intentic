<script setup lang="ts">
import type { SettingContribution, SettingValue } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { cmp, Picker, Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { watch } from "vue";
import { extensionSettingsStore } from "../../composables/extensions/useExtensionSettings";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { type ExtensionHostStatus, extensionStatuses } from "../../extension-host/loader";

/* The Sandbox hub's "Extensions" tab: every installed extension (the extension-kind capabilities) with its
 * host status — active, agent-only, incompatible engines, or a contained load error — and its declared
 * settings rendered schema-driven from the manifest's contributes.settings (boolean → toggle, enum → select,
 * string/number → input). Values live in the shared per-extension store, so a running extension's
 * api.settings sees an edit here immediately. Install/remove happens on the Capabilities page like every
 * other capability; this tab is the management surface. */

const { extensions, isLoading, error } = useExtensions();

// Settings load lazily per listed extension (the store is shared with the extension host, which already
// loaded stores for UI extensions it activated).
watch(
    extensions,
    (list) => {
        for (const extension of list) {
            if ((extension.manifest.contributes?.settings ?? []).length > 0) {
                const store = extensionSettingsStore(extension.id);
                if (store.values.value === undefined) {
                    void store.load();
                }
            }
        }
    },
    { immediate: true },
);

const statusOf = (id: string): ExtensionHostStatus | undefined => extensionStatuses.value.find((status) => status.id === id);
// No host status = installed after the host booted (or the host hasn't booted yet) — a reload loads it.
const badge = (id: string): { variant: StatusVariant; label: string } => {
    const status = statusOf(id);
    if (status === undefined) {
        return { variant: `neutral`, label: `reload to load` };
    }
    const variants: Record<ExtensionHostStatus["state"], StatusVariant> = {
        active: `success`,
        "agent-only": `neutral`,
        incompatible: `warning`,
        error: `danger`,
    };
    return { variant: variants[status.state], label: status.state };
};

const valueOf = (extension: ExtensionSummary, setting: SettingContribution): SettingValue | undefined =>
    extensionSettingsStore(extension.id).values.value?.[setting.key] ?? setting.default;

const setValue = (extension: ExtensionSummary, setting: SettingContribution, value: SettingValue): void => {
    const store = extensionSettingsStore(extension.id);
    void store.save({ ...store.values.value, [setting.key]: value });
};

// A secret setting's value is never sent to the browser — the tab only knows whether one is stored.
const secretIsSet = (extension: ExtensionSummary, setting: SettingContribution): boolean =>
    extensionSettingsStore(extension.id).secretsSet.value.includes(setting.key);

// Contribution counts for the summary line — the same declarations the install approval showed.
const contributionSummary = (extension: ExtensionSummary): string => {
    const contributes = extension.manifest.contributes;
    const parts = [
        ...((contributes?.views ?? []).length > 0 ? [`${contributes?.views?.length} view(s)`] : []),
        ...((contributes?.commands ?? []).length > 0 ? [`${contributes?.commands?.length} command(s)`] : []),
        ...((contributes?.processes ?? []).length > 0 ? [`${contributes?.processes?.length} process(es)`] : []),
        ...(contributes?.agent !== undefined ? [`agent skills`] : []),
    ];
    return parts.length > 0 ? parts.join(` · `) : `no contributions`;
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <p v-if="error" :class="cmp.alertDanger()">{{ error }}</p>
        <RowGroup label="Extensions">
            <div v-if="!isLoading && extensions.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                No extensions installed. Add one from the Capabilities page — install is owner-only and pins an exact commit.
            </div>
            <Row v-for="extension in extensions" :key="extension.id">
                <template #title>
                    <span class="truncate">{{ extensionIdOf(extension.manifest) }}</span>
                </template>
                <template #description>
                    v{{ extension.manifest.version }} · {{ extension.commit.slice(0, 12) }} · {{ contributionSummary(extension) }}
                    <span v-if="statusOf(extension.id)?.detail" class="mt-1 block text-2xs text-danger">{{ statusOf(extension.id)?.detail }}</span>
                </template>
                <template #control>
                    <StatusBadge :variant="badge(extension.id).variant" :label="badge(extension.id).label" />
                </template>
                <template v-if="(extension.manifest.contributes?.settings ?? []).length > 0" #below>
                    <div class="flex flex-col gap-2">
                        <div
                            v-for="setting in extension.manifest.contributes?.settings"
                            :key="setting.key"
                            class="flex items-center justify-between gap-3"
                        >
                            <div class="min-w-0">
                                <p class="text-sm text-content">{{ setting.title }}</p>
                                <p v-if="setting.description" class="text-2xs text-muted">{{ setting.description }}</p>
                            </div>
                            <!-- Secret settings: write-only. The stored value never reaches the browser; typing a new
                                 one replaces it, clearing the box and saving clears it. -->
                            <input
                                v-if="setting.secret === true"
                                type="password"
                                autocomplete="off"
                                :class="cmp.input(`w-44 shrink-0`)"
                                :placeholder="secretIsSet(extension, setting) ? `•••••• (set)` : `Enter value`"
                                @change="(event) => setValue(extension, setting, (event.target as HTMLInputElement).value)"
                            />
                            <ToggleSwitch
                                v-else-if="setting.type === `boolean`"
                                :model-value="valueOf(extension, setting) === true"
                                @update:model-value="(value: boolean) => setValue(extension, setting, value)"
                            />
                            <Picker
                                v-else-if="setting.type === `enum`"
                                class="w-44 shrink-0"
                                :model-value="String(valueOf(extension, setting) ?? ``) || undefined"
                                :options="(setting.enum ?? []).map((option) => ({ value: option, label: option }))"
                                placeholder="Choose…"
                                :aria-label="setting.title"
                                @update:model-value="(value: string | undefined) => value !== undefined && setValue(extension, setting, value)"
                            />
                            <input
                                v-else
                                :class="cmp.input(`w-44 shrink-0`)"
                                :type="setting.type === `number` ? `number` : `text`"
                                :value="String(valueOf(extension, setting) ?? ``)"
                                @change="
                                    (event) =>
                                        setValue(
                                            extension,
                                            setting,
                                            setting.type === `number`
                                                ? Number((event.target as HTMLInputElement).value)
                                                : (event.target as HTMLInputElement).value,
                                        )
                                "
                            />
                        </div>
                    </div>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
