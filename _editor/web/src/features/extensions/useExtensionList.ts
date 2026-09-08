import type { CapabilitySummary } from "@intentic/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { extensionStatuses, loadedCommits } from "../../extension-host/loader";
import { type ExtensionFacet, facetsOf, searchTextOf } from "./extensionFacets";
import { backendState, type ExtensionState, extensionState } from "./extensionState";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "./useExtensions";

// Extensions tab's row model: joins the daemon's list, the extension host's per-browser statuses, and configured
// capabilities into one row, computed once instead of per render inside the row component.

export interface ExtensionEntry {
    readonly extension: ExtensionSummary;
    /** Where it shows up, in reader-facing words. */
    readonly facets: readonly ExtensionFacet[];
    readonly state: ExtensionState;
    /** The host's explanation of a non-nominal state: the engines mismatch, the activate() error, the drift. */
    readonly detail: string | undefined;
    /** Configured cli capabilities whose connector spec this extension contributes; lose their card if it goes off. */
    readonly dependents: readonly CapabilitySummary[];
    /** Everything the filter box may match on, pre-lowercased. */
    readonly search: string;
}

export function useExtensionList() {
    const { extensions, invalid, setEnabled, create, checkUpdates, updatesCheckedAt, isLoading, error } = useExtensions();
    const { capabilities } = useCapabilities();

    // Rows whose loaded bundle lags the daemon's already-updated checkout; a host reload here picks it up.
    const updatedSinceLoaded = computed(() =>
        extensions.value.filter((extension) => {
            const loaded = loadedCommits.value.get(extension.id);
            return extension.source === `installed` && extension.enabled && loaded !== undefined && loaded !== extension.commit;
        }),
    );

    const entries = computed<ExtensionEntry[]>(() => {
        const statuses = new Map(extensionStatuses.value.map((status) => [status.id, status]));
        return extensions.value
            .map((extension) => {
                const status = statuses.get(extension.id);
                const facets = facetsOf(extension.manifest);
                const providers = new Set((extension.manifest.contributes?.capabilities ?? []).map((contribution) => contribution.id));
                // UI state, escalated to the backend's if the backend failed while the UI still reads fine.
                const uiState = extensionState(status);
                const backend = backendState(extension.backend);
                const escalated = backend !== undefined && !uiState.attention;
                // A blocked advisory or unhealthy update outranks both halves, always pinning the row to attention.
                const registryState: ExtensionState | undefined =
                    extension.advisory !== undefined
                        ? { label: `blocked`, variant: `danger`, badge: true, attention: true }
                        : extension.health?.state === `unhealthy`
                          ? {
                                label: extension.health.autoReverted === true ? `update rolled back` : `update unhealthy`,
                                variant: `warning`,
                                badge: true,
                                attention: true,
                            }
                          : undefined;
                const registryDetail =
                    extension.advisory !== undefined
                        ? `Blocked by its registry: ${extension.advisory.reason}`
                        : extension.health?.state === `unhealthy`
                          ? extension.health.detail
                          : undefined;
                return {
                    extension,
                    facets,
                    state: registryState ?? (escalated ? backend : uiState),
                    detail: registryDetail ?? (escalated ? extension.backend?.detail : undefined) ?? status?.detail ?? extension.backend?.detail,
                    dependents: capabilities.value.filter(
                        (capability) => capability.kind === `cli` && providers.has(String(capability.config[`provider`] ?? ``)),
                    ),
                    search: searchTextOf(extension.manifest, facets),
                };
            })
            .toSorted((left, right) => left.extension.id.localeCompare(right.extension.id));
    });

    // Extensions running but absent from the daemon's list (loader's unlisted path); shown in a group of their own.
    const unlisted = computed(() => {
        const listed = new Set(extensions.value.map((extension) => extension.id));
        return extensionStatuses.value.filter((status) => !listed.has(status.id));
    });

    return { entries, invalid, unlisted, setEnabled, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded, isLoading, error };
}
