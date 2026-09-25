import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-manifest";
import type {
    CapabilityKind,
    ExtensionUpdatePolicy,
    InvalidWorkspaceExtension,
    ExtensionSummary,
    PendingWorkspaceExtension,
} from "@intentic/sandbox-contract";
import { computed } from "vue";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// Installed extensions (capabilities resolved to manifests) for the Extensions tab. The extension host's boot does its
// own one-shot fetch of the same route (loader.ts); this query is for reactive rendering, not loading code.

// Preview of what an update would change (version, capability diff), read from a staged clone. Module-scoped, unlike
// the verbs below, since it never reads back into the query.
const previewUpdate = (id: string, ref?: string) => sandboxRpc.extensions.updatePreview({ id, ...(ref !== undefined ? { ref } : {}) });

// What removing one would destroy, read on demand rather than carried on the list: it joins the configured capability
// entries and the stored settings, neither of which the list route knows about. Module-scoped like previewUpdate, for
// the same reason: it never reads back into the query.
export const removalPlan = (id: string) => sandboxRpc.extensions.removalPlan({ id });

export function useExtensions() {
    const { query, error } = useSandboxQuery(rpcQuery(`extensions.list`));
    const extensions = computed<ExtensionSummary[]>(() => query.data.value?.extensions ?? []);
    // Workspace-extension directories that failed to enumerate, and why; the only feedback their author gets.
    const invalid = computed<InvalidWorkspaceExtension[]>(() => query.data.value?.invalid ?? []);
    // Workspace extensions waiting for the owner's approval: listed apart, and never loaded by the host.
    const pending = computed<PendingWorkspaceExtension[]>(() => query.data.value?.pending ?? []);
    // A disabled extension stays listed but wires nothing; read this list, not `extensions`, for contributions.
    const enabledExtensions = computed<ExtensionSummary[]>(() => extensions.value.filter((extension) => extension.enabled));
    // Flips one extension's switch and re-reads the list. The daemon converges its own half; the caller's
    // reloadExtensions() activates or retires it without a page reload.
    const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
        await sandboxRpc.extensions.setEnabled({ id, enabled });
        await query.refetch();
    };
    // The owner's yes for the powers they were shown (`digest`); the daemon refuses one that changed since. The caller's
    // reloadExtensions() then loads what the approval let in.
    const approve = async (id: string, digest: string): Promise<void> => {
        await sandboxRpc.extensions.approve({ id, digest });
        await query.refetch();
    };
    // Authors a new extension in this workspace; the row exists before the caller's reloadExtensions() makes it run, so
    // a failed activation still has a row to report on.
    const create = async (publisher: string, name: string): Promise<{ id: string; dir: string }> => {
        const created = await sandboxRpc.extensions.create({ publisher, name });
        await query.refetch();
        return created;
    };
    // Uninstalls it and the connections configured from its cards. Only this list is re-read here: removal also empties
    // caches this composable has no business knowing about, and useExtensionList, which already joins extensions and
    // capabilities, is where that happens. Nothing in this file may reach for the query client — BackgroundProcesses
    // mounts this composable outside the query plugin, and useQueryClient() throws there.
    const remove = async (id: string) => {
        const removed = await sandboxRpc.extensions.remove({ id });
        await query.refetch();
        return removed;
    };
    // One card's contribution from the enabled extensions, keyed by kind + id since an id is only unique within its
    // kind. Undefined until /extensions loads.
    const contributionOf = (kind: CapabilityKind, id: string): CapabilityContribution | undefined =>
        enabledExtensions.value
            .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
            .find((contribution) => contribution.kind === kind && contribution.id === id);
    // The manifest of the enabled extension declaring that card: what else the extension does for it, such as serving
    // its cards tools (`contributes.tools` with `perCard`), which the card itself does not say.
    const manifestOf = (kind: CapabilityKind, id: string): ExtensionManifest | undefined =>
        enabledExtensions.value.find((extension) =>
            (extension.manifest.contributes?.capabilities ?? []).some((contribution) => contribution.kind === kind && contribution.id === id),
        )?.manifest;
    // Update lifecycle verbs; each re-reads the list since each changes what a row says. Update and revert are
    // owner-gated daemon-side.
    const checkUpdates = async (): Promise<void> => {
        await sandboxRpc.extensions.checkUpdates();
        await query.refetch();
    };
    const applyUpdate = async (id: string, ref?: string) => {
        const applied = await sandboxRpc.extensions.applyUpdate({ id, ...(ref !== undefined ? { ref } : {}) });
        await query.refetch();
        return applied;
    };
    const revertUpdate = async (id: string) => {
        const reverted = await sandboxRpc.extensions.revert({ id });
        await query.refetch();
        return reverted;
    };
    const setUpdatePolicy = async (id: string, patch: Partial<ExtensionUpdatePolicy>): Promise<void> => {
        await sandboxRpc.extensions.setUpdatePolicy({ id, ...patch });
        await query.refetch();
    };
    return {
        extensions,
        invalid,
        pending,
        enabled: enabledExtensions,
        setEnabled,
        approve,
        create,
        remove,
        contributionOf,
        manifestOf,
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
