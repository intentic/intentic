import { approveExtension } from "../capabilities/extension-inventory/extension-approvals.js";
import type { PendingExtension } from "../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../composition.js";
import { reconcileListenerProcesses, startAutoStartProcesses, whilePendingSettles } from "./extension-processes.js";

// A yes to workspace extensions waiting for one, at the powers each declares now, and what that yes lets run: the
// processes of the enabled ones now, the listener gateways and the backend host on the new set. The Approve press and a
// land that carried them (landed-extensions.ts) both come through here, so either way they run alike.
export const approveAndConverge = async (services: Services, extensions: readonly PendingExtension[]): Promise<void> => {
    if (extensions.length === 0) {
        return;
    }
    // Taking turns with the stop of pending extensions' processes (extension-processes.ts), which would otherwise read
    // them as pending and stop what this starts.
    await whilePendingSettles(async () => {
        for (const extension of extensions) {
            await approveExtension(services.config.historyRoot, extension.id, extension.manifest);
        }
        for (const extension of extensions) {
            if (extension.enabled) {
                await startAutoStartProcesses(services, extension);
            }
        }
    });
    void reconcileListenerProcesses(services);
    services.extensionBackend.restart();
};
