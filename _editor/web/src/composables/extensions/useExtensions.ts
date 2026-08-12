import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { CapabilityKind, ExtensionUpdatePolicy, InvalidWorkspaceExtension } from "@intentic/sandbox-contract";
import {
    ExtensionUpdateAppliedSchema,
    ExtensionUpdatePreviewSchema,
    type ExtensionSummary,
    ExtensionsListSchema,
    WorkspaceExtensionCreatedSchema,
} from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { EXTENSIONS } from "../queryKeys";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* The installed extensions (extension-kind capabilities resolved to their manifests) for the UI — the Sandbox
 * hub's Extensions tab. The extension host's boot does its own one-shot fetch of the same route (loader.ts);
 * this query exists for reactive rendering, not for loading code. */

const QUERY_KEY = EXTENSIONS.of();

// What a click would approve — the version story and the mechanical powers diff, read from a staged clone.
// Module-scoped (unlike the verbs below) because it reads nothing back into the query.
const previewUpdate = async (id: string, ref?: string) =>
    ExtensionUpdatePreviewSchema.parse(
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/update/preview`, jsonBody(`POST`, ref !== undefined ? { ref } : {})),
    );

export function useExtensions() {
    const { query, error } = useSandboxQuery({
        queryKey: QUERY_KEY,
        queryFn: async () => ExtensionsListSchema.parse(await sandboxJson(`/extensions`)),
    });
    const extensions = computed<ExtensionSummary[]>(() => query.data.value?.extensions ?? []);
    // Workspace-extension directories that failed to enumerate, and why — their author's only feedback, since
    // nothing install-shaped ever rejected them. Rendered by the Extensions tab beside the rows that did load.
    const invalid = computed<InvalidWorkspaceExtension[]>(() => query.data.value?.invalid ?? []);
    // What actually contributes right now. A disabled extension stays LISTED (that is what keeps its switch
    // reachable) but the daemon wires none of its contributions up, so anything derived from a contribution —
    // the /capabilities cards above all — must read this list, not `extensions`. Reading the wrong one is how a
    // card for a switched-off extension stayed on the grid and failed at the daemon with an unknown provider.
    const enabledExtensions = computed<ExtensionSummary[]>(() => extensions.value.filter((extension) => extension.enabled));
    // Flip one extension's switch and re-read the list. The daemon converges its own half (declared processes
    // stop/start, connectors and listener providers drop out of every subsequent read); the shell's half is the
    // caller's reloadExtensions(), which activates or retires the extension without a page reload.
    const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/enabled`, jsonBody(`POST`, { enabled }));
        await query.refetch();
    };
    // Author a new extension in this workspace. The daemon writes a running one and this re-reads the list, so
    // the row exists before the caller's reloadExtensions() makes it run — which is the order that lets a failed
    // activation still have a row to report itself on.
    const create = async (publisher: string, name: string): Promise<{ id: string; dir: string }> => {
        const created = WorkspaceExtensionCreatedSchema.parse(await sandboxJson(`/extensions/workspace`, jsonBody(`POST`, { publisher, name })));
        await query.refetch();
        return created;
    };
    // One card's contribution from the enabled extensions' contributes.capabilities — the data capabilityEffects
    // derives a card's secret/image effects from. Keyed by kind + id because an id is only unique within a kind.
    // Undefined until /extensions loads.
    const contributionOf = (kind: CapabilityKind, id: string): CapabilityContribution | undefined =>
        enabledExtensions.value
            .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
            .find((contribution) => contribution.kind === kind && contribution.id === id);
    // ---- the update lifecycle's verbs, each re-reading the list because each changes what a row says. The
    // daemon owns the transaction (stage → validate → quiesce → swap → restart → health-watch); these are its
    // buttons. Update and revert are owner-gated daemon-side, so a member's press gets the daemon's sentence.
    const checkUpdates = async (): Promise<void> => {
        await sandboxJson(`/extensions/updates/check`, jsonBody(`POST`, {}));
        await query.refetch();
    };
    const applyUpdate = async (id: string, ref?: string) => {
        const applied = ExtensionUpdateAppliedSchema.parse(
            await sandboxJson(`/extensions/${encodeURIComponent(id)}/update`, jsonBody(`POST`, ref !== undefined ? { ref } : {})),
        );
        await query.refetch();
        return applied;
    };
    const revertUpdate = async (id: string) => {
        const reverted = ExtensionUpdateAppliedSchema.parse(await sandboxJson(`/extensions/${encodeURIComponent(id)}/revert`, jsonBody(`POST`, {})));
        await query.refetch();
        return reverted;
    };
    const setUpdatePolicy = async (id: string, patch: Partial<ExtensionUpdatePolicy>): Promise<void> => {
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/update-policy`, jsonBody(`POST`, patch));
        await query.refetch();
    };
    return {
        extensions,
        invalid,
        enabled: enabledExtensions,
        setEnabled,
        create,
        contributionOf,
        checkUpdates,
        previewUpdate,
        applyUpdate,
        revertUpdate,
        setUpdatePolicy,
        // When the registry comparison last ran — the honesty line under the tab's update badges.
        updatesCheckedAt: computed(() => query.data.value?.updatesCheckedAt),
        // The list has actually arrived (or definitively failed) — gates decisions that must not fire against
        // the empty pre-fetch state, like bouncing an unknown /capabilities/<card> slug back to the grid.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
