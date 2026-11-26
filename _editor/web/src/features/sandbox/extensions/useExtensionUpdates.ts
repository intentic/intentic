import type { ExtensionUpdatePolicy } from "@intentic/sandbox-contract/schemas/extension-updates";
import { useSandboxScope } from "../../../client/sandbox/scope/useSandboxScope";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { useExtensions } from "../../../models/extensions/useExtensions";

// The update verbs an open extension row offers, each finished the way the row's switch is: once the daemon has swapped
// the code, the host reloads so this browser runs what is now installed. One module for the offer and the policy
// section both, so neither reaches into the extension host on its own.
export function useExtensionUpdates() {
    const { previewUpdate, applyUpdate, revertUpdate, setUpdatePolicy, refetch } = useExtensions();
    const scope = useSandboxScope();

    const apply = async (id: string, ref?: string) => {
        const applied = await applyUpdate(id, ref);
        await reloadExtensions();
        return applied;
    };

    const revert = async (id: string): Promise<void> => {
        await revertUpdate(id);
        await reloadExtensions();
    };

    // The sandbox's answer for every install without its own. The daemon takes what already waits by itself, so the list
    // is read again now and once more when that lands (its workspaceChanged push).
    const setUpdateDefaults = async (updates: ExtensionUpdatePolicy[`updates`]): Promise<void> => {
        await scope.rpc.extensions.setUpdateDefaults({ updates });
        await refetch();
    };

    return { previewUpdate, apply, revert, setUpdatePolicy, setUpdateDefaults };
}
