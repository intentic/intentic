import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { useExtensions } from "../../extensions/useExtensions";

// The update verbs an open extension row offers, each finished the way the row's switch is: once the daemon has swapped
// the code, the host reloads so this browser runs what is now installed. One module for the offer and the policy
// section both, so neither reaches into the extension host on its own.
export function useExtensionUpdates() {
    const { previewUpdate, applyUpdate, revertUpdate, setUpdatePolicy } = useExtensions();

    const apply = async (id: string, ref?: string) => {
        const applied = await applyUpdate(id, ref);
        await reloadExtensions();
        return applied;
    };

    const revert = async (id: string): Promise<void> => {
        await revertUpdate(id);
        await reloadExtensions();
    };

    return { previewUpdate, apply, revert, setUpdatePolicy };
}
