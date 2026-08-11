import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { extensionStatuses, loadedCommits } from "../../extension-host/loader";
import { type ExtensionFacet, facetsOf, searchTextOf } from "./extensionFacets";
import { backendState, type ExtensionState, extensionState } from "./extensionState";
import { useCapabilities } from "./useCapabilities";
import { useExtensions } from "./useExtensions";

/* THE EXTENSIONS TAB'S ROW MODEL — the join the tab used to do inline, five times per row.
 *
 * Three sources have to meet before a row can be drawn: the daemon's list (what is installed and switched on),
 * the extension host's statuses (what actually loaded in THIS browser), and the configured capabilities (which
 * connector cards would vanish if this extension went off). Deriving that per row inside the template meant
 * `statusOf()` and `dependents()` ran on every re-render of every row — and, worse, meant the tab could not
 * sort or group by a state it only computed while painting. It is one pass here instead, and the row component
 * becomes presentational. */

export interface ExtensionEntry {
    readonly extension: ExtensionSummary;
    /** Where it shows up, in the reader's words — see extensionFacets. */
    readonly facets: readonly ExtensionFacet[];
    readonly state: ExtensionState;
    /** The host's explanation of a non-nominal state: the engines mismatch, the activate() error, the drift. */
    readonly detail: string | undefined;
    /** Configured cli capabilities whose connector spec THIS extension contributes — they lose their card if it goes off. */
    readonly dependents: readonly CapabilitySummary[];
    /** Everything the filter box may match on, pre-lowercased. */
    readonly search: string;
}

export function useExtensionList() {
    const { extensions, invalid, setEnabled, create, checkUpdates, updatesCheckedAt, isLoading, error } = useExtensions();
    const { capabilities } = useCapabilities();

    /* Rows whose checkout moved on since this browser loaded their code — an update applied by the auto rung,
     * another member, or another tab. The daemon is already fully on the new version; only THIS browser's
     * loaded bundle lags, and re-running the host (the tab's ordinary reload) is what finishes it here. */
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
                /* The UI half's state, unless the BACKEND half has something worse to say — a row whose view
                 * renders fine while its backend failed to activate is a broken feature wearing a green row.
                 * The daemon only reports `backend` for an enabled extension that ships one, so this never
                 * overrides a disabled row's silence. */
                const uiState = extensionState(status);
                const backend = backendState(extension.backend);
                const escalated = backend !== undefined && !uiState.attention;
                /* Above BOTH halves sit the registry's verdicts, worst first: an advisory (its registry blocked
                 * it — the code itself is the problem, whatever state it loaded in) and an unhealthy update (it
                 * swapped fine and came up wrong). Each pins the row into "Needs attention", because each is a
                 * fact the owner must act on rather than a state that might resolve itself. */
                const registryState: ExtensionState | undefined =
                    extension.advisory !== undefined
                        ? { label: `blocked`, variant: `danger`, badge: true, attention: true }
                        : extension.health?.state === `unhealthy`
                          ? { label: extension.health.autoReverted === true ? `update rolled back` : `update unhealthy`, variant: `warning`, badge: true, attention: true }
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

    /* Extensions this app build is running that the daemon's list doesn't mention — the loader's `unlisted`
     * path, normally empty. They get their own group because they have no row to sit in: there is no listed
     * extension to hang the switch or the settings off. Rendering them is the whole point of the drift being a
     * state rather than a console line — the alternative is an extension that is demonstrably running and
     * nowhere in its own list. */
    const unlisted = computed(() => {
        const listed = new Set(extensions.value.map((extension) => extension.id));
        return extensionStatuses.value.filter((status) => !listed.has(status.id));
    });

    return { entries, invalid, unlisted, setEnabled, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded, isLoading, error };
}
