<script setup lang="ts">
import type { SettingContribution, SettingValue } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { cmp, Picker, Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { extensionSettingsStore } from "../../composables/extensions/useExtensionSettings";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { errorMessage } from "../../composables/useAsyncAction";
import { type ExtensionHostStatus, extensionStatuses } from "../../extension-host/loader";
import { reloadExtensions } from "../../extension-host/useExtensionHost";

/* The Sandbox hub's "Extensions" tab: EVERY first-party and installed extension — the ones compiled into this
 * bundle, the ones baked into the sandbox image, and the git-installed capabilities — each with its host status
 * (active, agent-only, off, incompatible engines, a contained load error, or a version drift between image and
 * app), an on/off switch, and its declared settings rendered schema-driven from the manifest's
 * contributes.settings (boolean → toggle, enum → select, string/number → input). Values live in the shared
 * per-extension store, so a running extension's api.settings sees an edit here immediately. Install/remove
 * happens on the Capabilities page like every other capability; this tab is the management surface. */

const { extensions, setEnabled, isLoading, error } = useExtensions();
const { capabilities } = useCapabilities();
const pending = ref<string | undefined>(undefined);
const toggleError = ref<string | undefined>(undefined);

// Flip the switch, then converge the shell: the daemon has already stopped/started the extension's processes
// and dropped its contributions from every subsequent read, and reloadExtensions activates or retires it here
// without a page reload.
const toggle = async (extension: ExtensionSummary, enabled: boolean): Promise<void> => {
    pending.value = extension.id;
    toggleError.value = undefined;
    try {
        await setEnabled(extension.id, enabled);
        await reloadExtensions();
    } catch (failure) {
        toggleError.value = errorMessage(failure, `Could not ${enabled ? `enable` : `disable`} ${extensionIdOf(extension.manifest)}.`);
    } finally {
        pending.value = undefined;
    }
};

/* What switching an extension off does NOT reach right away. Views, viewers, commands, processes, connectors,
 * listeners and settings all converge before the toggle returns; these three can't, so the row says so rather
 * than leaving the owner to discover it. */
const DEFERRED: Record<string, string> = {
    agent: `its agent skills/hooks/MCP servers apply from the next turn`,
    bin: `its CLIs leave the agent's PATH from the next turn`,
    environment: `its image fragment only changes on the next environment rebuild`,
};

const deferredNotes = (extension: ExtensionSummary): string[] =>
    Object.keys(extension.manifest.contributes ?? {}).flatMap((kind) => DEFERRED[kind] ?? []);

// The configured cli capabilities that exist because THIS extension contributes their connector spec. Switching
// it off leaves their config in capabilities.json untouched but takes their card off the Capabilities page —
// worth naming on the row, since the card vanishing elsewhere is otherwise unexplained.
const dependents = (extension: ExtensionSummary): CapabilitySummary[] => {
    const providers = new Set((extension.manifest.contributes?.connectors ?? []).map((connector) => connector.provider));
    return capabilities.value.filter((capability) => capability.kind === `cli` && providers.has(String(capability.config[`provider`] ?? ``)));
};

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

/* Extensions this app build is running that the daemon's list doesn't mention — the loader's `unlisted` path,
 * normally empty. They get their own group because they have no row to sit in: there is no listed extension to
 * hang the switch or the settings off. Rendering them is the whole point of the drift being a state rather than
 * a console line — the alternative is an extension that is demonstrably running and nowhere in its own list. */
const unlisted = computed(() => {
    const listed = new Set(extensions.value.map((extension) => extension.id));
    return extensionStatuses.value.filter((status) => !listed.has(status.id));
});
// No host status = installed after the host booted (or the host hasn't booted yet) — a reload loads it.
const badge = (id: string): { variant: StatusVariant; label: string } => {
    const status = statusOf(id);
    if (status === undefined) {
        return { variant: `neutral`, label: `reload to load` };
    }
    const variants: Record<ExtensionHostStatus["state"], StatusVariant> = {
        active: `success`,
        "agent-only": `neutral`,
        disabled: `neutral`,
        incompatible: `warning`,
        // Both drift states: the image and this app build disagree about what exists. Not the extension's fault
        // and not fatal, but never something to render as if all were well.
        missing: `warning`,
        unlisted: `warning`,
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

/* Contribution counts for the summary line — the same declarations the install approval showed.
 *
 * DERIVED by walking the manifest's `contributes`, not by naming the kinds: the enumerated version listed four
 * of them and silently omitted viewers, settings, connectors, listener, environment and bin, so every kind added
 * since had to be remembered here and none was. Walking makes the line complete by construction — a new
 * contribution point in the schema shows up the moment an extension declares it. Arrays carry their count,
 * singletons (agent, environment, listener, bin) just their name. */
const contributionSummary = (extension: ExtensionSummary): string => {
    const parts = Object.entries(extension.manifest.contributes ?? {}).flatMap(([kind, value]) => {
        if (Array.isArray(value)) {
            return value.length > 0 ? [`${kind} (${value.length})`] : [];
        }
        return [kind];
    });
    return parts.length > 0 ? parts.join(` · `) : `no contributions`;
};
</script>

<template>
    <div class="flex flex-col gap-2.5">
        <p v-if="error" :class="cmp.alertDanger()">{{ error }}</p>
        <p v-if="toggleError" :class="cmp.alertDanger()">{{ toggleError }}</p>
        <RowGroup label="Extensions">
            <div v-if="!isLoading && extensions.length === 0" class="px-4 py-6 text-center text-xs text-muted">
                No extensions installed. Add one from the Capabilities page — install is owner-only and pins an exact commit.
            </div>
            <Row v-for="extension in extensions" :key="extension.id" :class="extension.enabled ? undefined : `opacity-60`">
                <template #title>
                    <span class="truncate">{{ extensionIdOf(extension.manifest) }}</span>
                </template>
                <template #description>
                    v{{ extension.manifest.version }} · {{ extension.commit.slice(0, 12) }} · {{ contributionSummary(extension) }}
                    <span
                        v-if="statusOf(extension.id)?.detail"
                        class="mt-1 block text-2xs"
                        :class="badge(extension.id).variant === `danger` ? `text-danger` : `text-warning`"
                        >{{ statusOf(extension.id)?.detail }}</span
                    >
                    <!-- Stated before the flip, not discovered after it: the contributions a switch can't reach
                         until the next agent turn or the next image rebuild. -->
                    <span v-for="note in deferredNotes(extension)" :key="note" class="mt-1 block text-2xs text-muted">Off: {{ note }}.</span>
                    <span v-if="extension.enabled && dependents(extension).length > 0" class="mt-1 block text-2xs text-muted">
                        Off: {{ dependents(extension).length }} configured connector{{ dependents(extension).length === 1 ? `` : `s` }} ({{
                            dependents(extension)
                                .map((capability) => capability.id)
                                .join(`, `)
                        }}) keep their config but lose their Capabilities card.
                    </span>
                </template>
                <template #control>
                    <div class="flex items-center gap-3">
                        <StatusBadge :variant="badge(extension.id).variant" :label="badge(extension.id).label" />
                        <ToggleSwitch
                            :model-value="extension.enabled"
                            :disabled="pending === extension.id"
                            :aria-label="`Enable ${extensionIdOf(extension.manifest)}`"
                            @update:model-value="(value: boolean) => toggle(extension, value)"
                        />
                    </div>
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
        <!-- Only ever populated when the sandbox image and this app build disagree; see `unlisted` above. -->
        <RowGroup v-if="unlisted.length > 0" label="Running but not listed">
            <Row v-for="status in unlisted" :key="status.id">
                <template #title>
                    <span class="truncate">{{ status.extensionId }}</span>
                </template>
                <template #description>
                    compiled into this app build
                    <span v-if="status.detail" class="mt-1 block text-2xs text-warning">{{ status.detail }}</span>
                </template>
                <template #control>
                    <StatusBadge :variant="status.state === `error` ? `danger` : `warning`" :label="status.state" />
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
