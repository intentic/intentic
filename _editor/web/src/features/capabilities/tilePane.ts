import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { contributionDiscriminator } from "@intentic/extension-manifest";
import type { RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { computed, type Ref } from "vue";
import type { BackgroundProcessRow } from "../terminal/useBackgroundProcesses";
import { rebuildStep } from "./model/connections";
import { type ConnectionSources, liveState, tileRowFacts } from "./model/connectionRows";
import type { DeviceConnection } from "./model/deviceConnections";

// What the open tile lists beside its form: its connections' states and facts, the machines desktop sync alone reaches,
// the background processes serving it, the rebuild a singleton still waits on, the registry's counts and the
// recommendation behind the tile.

// The extension serving an instance's processes, resolved per instance since one tile's providers can differ.
export const servingExtension = (instance: CapabilitySummary, enabled: readonly ExtensionSummary[]): string | undefined => {
    if (instance.kind === `extension`) {
        return instance.id;
    }
    const provider = String(instance.config[contributionDiscriminator(instance.kind) ?? ``]);
    return enabled.find((extension) =>
        (extension.manifest.contributes?.capabilities ?? []).some(
            (contribution) => contribution.kind === instance.kind && contribution.id === provider,
        ),
    )?.id;
};

// The gateways serving a tile's connections; empty until something is connected, since an idle gateway on an
// unconfigured tile is noise, not health.
export const tileProcesses = (
    rows: readonly BackgroundProcessRow[],
    instances: readonly CapabilitySummary[],
    enabled: readonly ExtensionSummary[],
): BackgroundProcessRow[] => {
    const owners = new Set(instances.map((instance) => servingExtension(instance, enabled)).filter((id) => id !== undefined));
    return rows.filter((row) => row.extensionId !== undefined && owners.has(row.extensionId));
};

export interface TilePaneHost {
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    readonly instances: Readonly<Ref<readonly CapabilitySummary[]>>;
    readonly sources: Readonly<Ref<ConnectionSources>>;
    readonly syncOnly: Readonly<Ref<readonly DeviceConnection[]>>;
    readonly processRows: Readonly<Ref<readonly BackgroundProcessRow[]>>;
    readonly enabled: Readonly<Ref<readonly ExtensionSummary[]>>;
    // What the registry cache already holds; nothing until something has actually browsed it.
    readonly published: Readonly<Ref<readonly RegistryEntry[]>>;
    readonly recommendationFor: (tile: string) => CapabilityRecommendation | undefined;
}

export const useTilePane = ({ selected, instances, sources, syncOnly, processRows, enabled, published, recommendationFor }: TilePaneHost) => ({
    // This tile's share of the machines desktop sync alone reaches, listed after what is actually connected.
    selectedDevices: computed(() => (selected.value === undefined ? [] : syncOnly.value.filter((row) => row.entryId === selected.value?.id))),
    cardProcesses: computed(() => tileProcesses(processRows.value, instances.value, enabled.value)),
    rowState: (entry: CapabilityCatalogEntry, instance: CapabilitySummary) => liveState(entry, instance, sources.value),
    cardRowFacts: (instance: CapabilitySummary): string => tileRowFacts(selected.value?.kind, instance, sources.value),
    // The one step a row can't offer itself: a sandbox rebuild, done from the Sandbox screen.
    soleRebuildStep: (instance: CapabilitySummary): boolean => rebuildStep(selected.value?.kind, instance),
    publishedCount: computed(() => published.value.length),
    verifiedCount: computed(() => published.value.filter((entry) => entry.trust === `verified`).length),
    selectedRecommendation: computed(() => (selected.value === undefined ? undefined : recommendationFor(selected.value.id))),
});
