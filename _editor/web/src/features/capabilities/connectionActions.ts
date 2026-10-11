import { t } from "@intentic/ui/i18n";
import type { NoticeModel } from "@intentic/ui";
import { computed, ref } from "vue";
import { useOperations } from "../../workbench/operations/operations";
import { revokeSyncDevice } from "../sandbox/devices/useDevices";
import type { DeviceConnection } from "./model/deviceConnections";

// What a connection's row confirms before it acts: removing a connection, renaming one, and cutting off a machine that
// only syncs. Each question holds its subject for exactly as long as its dialog is open; the act it confirms is the
// connection's, in the operations ledger, so a reader who leaves mid-removal comes back to the dialog's subject still
// working, and to the refusal if it was refused.

export interface ActionsHost {
    readonly remove: { readonly mutateAsync: (id: string) => Promise<unknown> };
    readonly rename: { readonly mutateAsync: (input: { id: string; to: string }) => Promise<unknown> };
    // Re-reads the daemon's device list, which a disconnect changes whether or not it threw.
    readonly refetchFleet: () => void;
}

const SCOPE = `capabilities/connections`;
const REMOVE = (id: string): string => `remove/${id}`;
const RENAME = (id: string): string => `rename/${id}`;
const DISCONNECT = (machine: string): string => `disconnect/${machine}`;

export const useConnectionActions = ({ remove, rename, refetchFleet }: ActionsHost) => {
    const ops = useOperations(SCOPE);
    // The connection awaiting a confirmed removal; undefined while the dialog is closed.
    const confirmRemoveId = ref<string>();
    // Renaming has no other path (every other field is saved over the same name); a refusal stays in the dialog's field.
    const renameId = ref<string>();
    // A synced machine holds no capability: disconnecting ends its enrollment, and every other door it holds goes too.
    const disconnecting = ref<DeviceConnection>();
    const runningAt = (sub: string | undefined): boolean => sub !== undefined && ops.at(sub)?.state === `running`;

    // A removal or a disconnect refused is the page's notice: the newest one, as the page said only the latest before.
    const failure = computed<NoticeModel | undefined>(() => {
        const refused = ops.all.value.filter((operation) => operation.state === `failed` && !operation.key.startsWith(`${SCOPE}/rename/`));
        return refused.at(-1)?.failure;
    });

    return {
        confirmRemoveId,
        renameId,
        // The rename dialog's own refusal, for the connection it is open on.
        renameError: computed(() => (renameId.value === undefined ? undefined : ops.at(RENAME(renameId.value))?.failure)),
        renaming: computed(() => runningAt(renameId.value === undefined ? undefined : RENAME(renameId.value))),
        removing: computed(() => runningAt(confirmRemoveId.value === undefined ? undefined : REMOVE(confirmRemoveId.value))),
        disconnecting,
        disconnectingDevice: computed(() => runningAt(disconnecting.value === undefined ? undefined : DISCONNECT(disconnecting.value.machine))),
        failure,
        // The dialog closes whether or not the removal took; a refusal is the page's notice.
        confirmRemove: async (): Promise<void> => {
            const id = confirmRemoveId.value;
            if (id === undefined) {
                return;
            }
            ops.dismiss(REMOVE(id));
            await ops.run(REMOVE(id), {
                what: t(`capabilities.connectionActions.removing`, { name: id }),
                failed: t(`capabilities.connectionActions.couldNotRemove`),
                task: async () => {
                    await remove.mutateAsync(id);
                },
            });
            confirmRemoveId.value = undefined;
        },
        askRename: (id: string): void => {
            ops.dismiss(RENAME(id));
            renameId.value = id;
        },
        confirmRename: async (to: string): Promise<void> => {
            const id = renameId.value;
            if (id === undefined) {
                return;
            }
            ops.dismiss(RENAME(id));
            const ended = await ops.run(RENAME(id), {
                what: t(`capabilities.connectionActions.renaming`, { name: id, to }),
                failed: t(`capabilities.connectionActions.couldNotRename`),
                task: async () => {
                    await rename.mutateAsync({ id, to });
                },
            });
            if (ended?.state === `done` && renameId.value === id) {
                renameId.value = undefined;
            }
        },
        confirmDisconnectDevice: async (): Promise<void> => {
            const device = disconnecting.value;
            if (device === undefined) {
                return;
            }
            ops.dismiss(DISCONNECT(device.machine));
            await ops.run(DISCONNECT(device.machine), {
                what: t(`capabilities.connectionActions.disconnecting`, { machine: device.title }),
                failed: t(`capabilities.connectionActions.couldNotDisconnect`),
                task: async () => {
                    try {
                        await revokeSyncDevice(device.machine);
                    } finally {
                        // Refetched whether or not the call threw: the row is losing its enrollment either way.
                        refetchFleet();
                    }
                },
            });
            if (disconnecting.value?.machine === device.machine) {
                disconnecting.value = undefined;
            }
        },
    };
};
