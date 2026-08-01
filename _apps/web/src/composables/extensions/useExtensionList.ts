import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { extensionStatuses } from "../../extension-host/loader";
import { type ExtensionFacet, facetsOf, searchTextOf } from "./extensionFacets";
import { type ExtensionState, extensionState } from "./extensionState";
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
    const { extensions, setEnabled, isLoading, error } = useExtensions();
    const { capabilities } = useCapabilities();

    const entries = computed<ExtensionEntry[]>(() => {
        const statuses = new Map(extensionStatuses.value.map((status) => [status.id, status]));
        return extensions.value
            .map((extension) => {
                const status = statuses.get(extension.id);
                const facets = facetsOf(extension.manifest);
                const providers = new Set((extension.manifest.contributes?.connectors ?? []).map((connector) => connector.provider));
                return {
                    extension,
                    facets,
                    state: extensionState(status),
                    detail: status?.detail,
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

    return { entries, unlisted, setEnabled, isLoading, error };
}
