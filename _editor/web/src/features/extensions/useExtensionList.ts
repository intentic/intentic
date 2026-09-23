import type { CapabilitySummary } from "@intentic/api-contract";
import { contributedEntryOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed } from "vue";
import { ENVIRONMENT, rpcKey } from "../../lib/queryKeys";
import { extensionStatuses, loadedCommits } from "../../extension-host/loader";
import { type ExtensionFacet, facetsOf, searchTextOf } from "./extensionFacets";
import { backendState, type ExtensionState, extensionState } from "./extensionState";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { useExtensions } from "./useExtensions";
import { t } from "@intentic/ui/i18n";

// Extensions tab's row model: joins the daemon's list, the extension host's per-browser statuses, and configured
// capabilities into one row, computed once instead of per render inside the row component.

export interface ExtensionEntry {
    readonly extension: ExtensionSummary;
    /** Where it shows up, in reader-facing words. */
    readonly facets: readonly ExtensionFacet[];
    readonly state: ExtensionState;
    /** The host's explanation of a non-nominal state: the engines mismatch, the activate() error, the drift. */
    readonly detail: string | undefined;
    /** Configured connections added from this extension's cards: they lose their card if it goes off, and go with it if it is removed. */
    readonly dependents: readonly CapabilitySummary[];
    /** Everything the filter box may match on, pre-lowercased. */
    readonly search: string;
}

export function useExtensionList() {
    const queryClient = useQueryClient();
    const { extensions, invalid, pending, setEnabled, approve, create, remove, checkUpdates, updatesCheckedAt, isLoading, error } = useExtensions();
    const { capabilities } = useCapabilities();

    // Removal empties three caches beyond the extension list: the capability grid loses the entries added from its
    // cards, the secrets inventory loses the credentials those held, and the image overlay loses whatever layer it
    // baked. It lives here rather than in useExtensions because this is the composable that already joins the two
    // lists — and because useExtensions is mounted in places that have no query client at all.
    const removeExtension = async (id: string) => {
        const removed = await remove(id);
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: rpcKey(`capabilities.list`) }),
            queryClient.invalidateQueries({ queryKey: rpcKey(`secrets.inventory`) }),
            queryClient.invalidateQueries({ queryKey: ENVIRONMENT.of() }),
        ]);
        return removed;
    };

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
                const contributions = extension.manifest.contributes?.capabilities ?? [];
                // UI state, escalated to the backend's if the backend failed while the UI still reads fine.
                const uiState = extensionState(status);
                const backend = backendState(extension.backend);
                const escalated = backend !== undefined && !uiState.attention;
                // A blocked advisory or unhealthy update outranks both halves, always pinning the row to attention.
                const registryState: ExtensionState | undefined =
                    extension.advisory !== undefined
                        ? { label: t(`shared.blocked`), variant: `danger`, badge: true, attention: true }
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
                    // Every contributed kind, not just cli: a browser account or an enrolled machine added from one of
                    // this extension's cards depends on it exactly as much, and loses more when it goes.
                    dependents: capabilities.value.filter((capability) => contributedEntryOf(contributions, capability) !== undefined),
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

    return {
        entries,
        invalid,
        pending,
        unlisted,
        setEnabled,
        approve,
        create,
        remove: removeExtension,
        checkUpdates,
        updatesCheckedAt,
        updatedSinceLoaded,
        isLoading,
        error,
    };
}
