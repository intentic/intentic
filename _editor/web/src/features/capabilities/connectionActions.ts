import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { type Ref, ref } from "vue";
import { revokeSyncDevice } from "../sandbox/devices/useDevices";
import type { DeviceConnection } from "./model/deviceConnections";

// What a connection's row confirms before it acts: removing a connection, renaming one, and cutting off a machine that
// only syncs. Each holds its subject for exactly as long as its dialog is open.

export interface ActionsHost {
    readonly remove: { readonly mutateAsync: (id: string) => Promise<unknown> };
    readonly rename: { readonly mutateAsync: (input: { id: string; to: string }) => Promise<unknown> };
    // Re-reads the daemon's device list, which a disconnect changes whether or not it threw.
    readonly refetchFleet: () => void;
    readonly error: Ref<NoticeModel | null>;
}

export const useConnectionActions = ({ remove, rename, refetchFleet, error }: ActionsHost) => {
    // The connection awaiting a confirmed removal; undefined while the dialog is closed.
    const confirmRemoveId = ref<string>();
    // Renaming has no other path (every other field is saved over the same name); a refusal stays in the dialog's field.
    const renameId = ref<string>();
    const renameError = ref<NoticeModel>();
    // A synced machine holds no capability: disconnecting ends its enrollment, and every other door it holds goes too.
    const disconnecting = ref<DeviceConnection>();
    const disconnectingDevice = ref(false);

    return {
        confirmRemoveId,
        renameId,
        renameError,
        disconnecting,
        disconnectingDevice,
        // The dialog closes whether or not the removal took; a refusal is the page's notice.
        confirmRemove: async (): Promise<void> => {
            const id = confirmRemoveId.value;
            if (id === undefined) {
                return;
            }
            error.value = null;
            try {
                await remove.mutateAsync(id);
            } catch (err) {
                error.value = noticeFrom(err, `Could not remove the capability.`);
            }
            confirmRemoveId.value = undefined;
        },
        askRename: (id: string): void => {
            renameError.value = undefined;
            renameId.value = id;
        },
        confirmRename: async (to: string): Promise<void> => {
            const id = renameId.value;
            if (id === undefined) {
                return;
            }
            renameError.value = undefined;
            try {
                await rename.mutateAsync({ id, to });
            } catch (err) {
                renameError.value = noticeFrom(err, `Could not rename that connection.`);
                return;
            }
            renameId.value = undefined;
        },
        confirmDisconnectDevice: async (): Promise<void> => {
            const device = disconnecting.value;
            if (device === undefined) {
                return;
            }
            disconnectingDevice.value = true;
            error.value = null;
            try {
                await revokeSyncDevice(device.machine);
            } catch (err) {
                error.value = noticeFrom(err, `Could not disconnect that machine.`);
            } finally {
                disconnectingDevice.value = false;
                disconnecting.value = undefined;
                // Refetched whether or not the call threw: the row is losing its enrollment either way.
                refetchFleet();
            }
        },
    };
};
