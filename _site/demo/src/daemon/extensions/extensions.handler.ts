import { STATE_DIR } from "@intentic/constants";
import { demoExtensions, setExtensionEnabled } from "./extensionList";
import { pushWorkspaceChanged } from "../broadcast";
import { processStatus, startProcess, stopAllOf, stopProcess } from "./extensionProcesses";
import { clearDev, readinessOf, recordUsage, removalPlanOf, removeExtension, saveSettings, settingsOf, withDev } from "./extensionRecords";
import { applyUpdate, checkUpdates, previewUpdate, revertUpdate, setUpdatePolicy, updatesCheckedAt, withUpdates } from "./extensionUpdates";
import { approveExtension, createExtension, pendingExtensions } from "./extensionWorkspace";
import { type Doors, okAfter } from "../doors";

// The Extensions tab's routes, each over the stores beside this file: the update lifecycle (extensionUpdates.ts), the
// workspace's own extensions (extensionWorkspace.ts), settings, usage and removal (extensionRecords.ts), and the
// processes extensions declare (extensionProcesses.ts).
export const extensionsDoors = {
    // `invalid` and `pending` are required by the contract; omitting either fails the whole list to parse.
    list: () => ({ extensions: withDev(withUpdates()), invalid: [], pending: pendingExtensions(), updatesCheckedAt: updatesCheckedAt() }),
    setEnabled: ({ id, enabled }) =>
        okAfter(() => {
            setExtensionEnabled(id, enabled);
            // Switching one off stops its processes at once, as the daemon's switch does.
            if (!enabled && demoExtensions().some((extension) => extension.id === id)) {
                stopAllOf(id);
            }
            pushWorkspaceChanged(`${STATE_DIR}/config/extension-enablement.json`);
        }),
    // Loaded before an extension's activate(), so `api.settings.get` is synchronous; missing here means the
    // extension never activates.
    settings: ({ id }) => settingsOf(id),
    setSettings: ({ id, settings }) => saveSettings(id, settings),
    create: ({ publisher, name }) => createExtension(publisher, name),
    approve: ({ id, digest }) => approveExtension(id, digest),
    removalPlan: ({ id }) => removalPlanOf(id),
    remove: ({ id }) => removeExtension(id),
    recordUsage: ({ reports }) => recordUsage(reports),
    readiness: ({ id }) => readinessOf(id),
    checkUpdates: () => checkUpdates(),
    updatePreview: ({ id }) => previewUpdate(id),
    applyUpdate: ({ id, ref }) => applyUpdate(id, ref),
    revert: ({ id }) => revertUpdate(id),
    setUpdatePolicy: ({ id, ...patch }) => setUpdatePolicy(id, patch),
    processStatus: ({ id, name }) => processStatus(id, name),
    processStart: ({ id, name }) => startProcess(id, name),
    processStop: ({ id, name }) => stopProcess(id, name),
    devClear: ({ id }) => clearDev(id),
} satisfies Doors<`extensions`>;
