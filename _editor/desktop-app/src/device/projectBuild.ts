import type { LocalFolderSandbox, LocalMachineSandbox, LocalMachineState } from "@intentic/web/local-host";
import type { MachineSandbox, MachineStanding } from "../desktop";
import { machineFolderOf } from "./machineSandbox";

// THIS COMPUTER'S SANDBOX AND A FOLDER ON ITS WAY INTO IT, AS THE WINDOW'S CARD AND BUTTON DRAW THEM (the web's
// local/LocalMachineCard.vue, local/LocalFiles.vue): the app's record (machine_sandbox.rs, device/machineSandbox.ts),
// read into the few facts the shell takes. Pure, so what each state comes to is tested by value.

/** Where it stands, in the shell's shape: what the record leaves out is said as undefined. */
export const machineStateOf = (standing: MachineStanding): LocalMachineState => {
    switch (standing.state) {
        case `creating`:
            return { state: `creating`, phase: standing.phase, step: standing.step, percent: standing.percent };
        case `needsDocker`:
            return { state: `needsDocker`, reason: standing.reason };
        case `waiting`:
            return { state: `waiting`, for: standing.for };
        case `failed`:
            return { state: `failed`, reason: standing.reason };
        default:
            return { state: standing.state };
    }
};

/** The record as every window's card draws it; nothing before the app has said. */
export const machineOf = (record: MachineSandbox | undefined): LocalMachineSandbox | undefined =>
    record === undefined
        ? undefined
        : {
              ...machineStateOf(record),
              name: record.name,
              waiting: record.folders.filter((folder) => folder.state === `queued`).length,
              hasLog: record.logPath !== undefined,
          };

/** The folder this window shows (its face's `path`) on its way into this computer's sandbox; nothing when it is not. */
export const folderOf = (record: MachineSandbox | undefined, path: string | undefined): LocalFolderSandbox | undefined => {
    const folder = machineFolderOf(record, path);
    return folder === undefined ? undefined : { name: folder.name, state: folder.state, reason: folder.reason, status: folder.status };
};

/** The workspace's address for a folder's sandbox, opened on the folder (the app's project.rs `project_path`). */
export const projectPathOf = (args: { readonly sandboxId: string | undefined; readonly project: string | undefined }): string | undefined => {
    if (args.sandboxId === undefined || args.sandboxId === ``) {
        return undefined;
    }
    const query = new URLSearchParams({ sandbox: args.sandboxId });
    if (args.project !== undefined && args.project !== ``) {
        query.set(`project`, args.project);
    }
    return `/?${query.toString()}`;
};
