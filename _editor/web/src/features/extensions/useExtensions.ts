import type { CapabilityContribution } from "@intentic/extension-manifest";
import {
    type CapabilityKind,
    type ExtensionUpdatePolicy,
    type InvalidWorkspaceExtension,
    ExtensionUpdateAppliedSchema,
    ExtensionUpdatePreviewSchema,
    type ExtensionSummary,
    ExtensionsListSchema,
    WorkspaceExtensionCreatedSchema,
} from "@intentic/sandbox-contract";
import { computed } from "vue";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { jsonBody } from "../sandbox/client/jsonBody";
import { EXTENSIONS } from "../../lib/queryKeys";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Installed extensions (capabilities resolved to manifests) for the Extensions tab. The extension host's boot does its
// own one-shot fetch of the same route (loader.ts); this query is for reactive rendering, not loading code.

const QUERY_KEY = EXTENSIONS.of();

// Preview of what an update would change (version, capability diff), read from a staged clone. Module-scoped, unlike
// the verbs below, since it never reads back into the query.
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
    // Workspace-extension directories that failed to enumerate, and why; the only feedback their author gets.
    const invalid = computed<InvalidWorkspaceExtension[]>(() => query.data.value?.invalid ?? []);
    // A disabled extension stays listed but wires nothing; read this list, not `extensions`, for contributions.
    const enabledExtensions = computed<ExtensionSummary[]>(() => extensions.value.filter((extension) => extension.enabled));
    // Flips one extension's switch and re-reads the list. The daemon converges its own half; the caller's
    // reloadExtensions() activates or retires it without a page reload.
    const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/enabled`, jsonBody(`POST`, { enabled }));
        await query.refetch();
    };
    // Authors a new extension in this workspace; the row exists before the caller's reloadExtensions() makes it run, so
    // a failed activation still has a row to report on.
    const create = async (publisher: string, name: string): Promise<{ id: string; dir: string }> => {
        const created = WorkspaceExtensionCreatedSchema.parse(await sandboxJson(`/extensions/workspace`, jsonBody(`POST`, { publisher, name })));
        await query.refetch();
        return created;
    };
    // One card's contribution from the enabled extensions, keyed by kind + id since an id is only unique within its
    // kind. Undefined until /extensions loads.
    const contributionOf = (kind: CapabilityKind, id: string): CapabilityContribution | undefined =>
        enabledExtensions.value
            .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
            .find((contribution) => contribution.kind === kind && contribution.id === id);
    // Update lifecycle verbs; each re-reads the list since each changes what a row says. Update and revert are
    // owner-gated daemon-side.
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
        // When the registry comparison last ran, the honesty line under the tab's update badges.
        updatesCheckedAt: computed(() => query.data.value?.updatesCheckedAt),
        // List has arrived or failed for good; gates decisions that must not fire against the empty pre-fetch state.
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        isLoading: query.isLoading,
        refetch: query.refetch,
    };
}
