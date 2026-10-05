import { computed, ref } from "vue";
import {
    machineSandboxCheck,
    machineSandboxEndSession,
    machineSandboxRecreate,
    machineSandboxRetry,
    machineSandboxStart,
    machineSandboxStatus,
    onMachineSandbox,
    requirementOf,
    revealLog,
    type MachineFolder,
    type MachineSandbox,
    type Requirement,
    type SessionEnd,
} from "../desktop";

// THIS COMPUTER'S OWN SANDBOX, AS EVERY WINDOW SEES IT: the app makes and keeps it (src-tauri/src/machine_sandbox.rs),
// not this window, so this is only a reading of the app's record: asked once on opening, then every change heard. Every
// local window holds one, so the folder's card, its button, This device's section and the rail's tile all read the same.

/** The app's record, once it has been read; undefined before. */
export const machineSandbox = ref<MachineSandbox | undefined>(undefined);

// Only a newer record replaces the one held: the opening read can answer after a change it predates was heard. A change
// heard in the same second as the read is taken, since it was sent after the state the read could have seen.
const take = (record: MachineSandbox, heard: boolean): void => {
    const held = machineSandbox.value;
    if (held === undefined || record.updatedAt > held.updatedAt || (heard && record.updatedAt === held.updatedAt)) {
        machineSandbox.value = record;
    }
};

/** Takes `record` as heard from the app (exported for the tests, which play the app). */
export const heard = (record: MachineSandbox): void => take(record, true);

let started: Promise<void> | undefined;

/** Read the record and follow it, once per window. A failed read is the console's: the next change still arrives. */
export const startMachineSandbox = (): Promise<void> =>
    (started ??= (async () => {
        await onMachineSandbox(heard);
        try {
            take(await machineSandboxStatus(), false);
        } catch (error) {
            console.error(`[machine sandbox] its state could not be read:`, error);
        }
    })());

/** What a setup stopped on a question said this computer needs, for This device's requirements card. */
export const machineRequirements = computed<Requirement[]>(() =>
    (machineSandbox.value?.requirements ?? []).map(requirementOf).filter((requirement): requirement is Requirement => requirement !== undefined),
);

/** The folder at `path` on its way into it, by the path its windows are told. */
export const machineFolderOf = (record: MachineSandbox | undefined, path: string | undefined): MachineFolder | undefined =>
    path === undefined ? undefined : record?.folders.find((folder) => folder.path === path);

// Why the last press did nothing, said beside it.
export const machineActionError = ref<string | undefined>(undefined);

const pressed = async (action: () => Promise<void>): Promise<void> => {
    machineActionError.value = undefined;
    try {
        await action();
    } catch (error) {
        machineActionError.value = String(error);
    }
};

/** "Try again", or the requirements card's go-ahead (`consent`) and "Check again". */
export const retryMachine = (consent = false): Promise<void> => pressed(() => machineSandboxRetry(consent));
/** Look again now (Docker was just started). */
export const checkMachine = (): Promise<void> => pressed(() => machineSandboxCheck());
/** "Make a new one". */
export const recreateMachine = (): Promise<void> => pressed(() => machineSandboxRecreate());
// A start takes its minute: said while it runs, so a second press is not mistaken for nothing happening.
export const machineStarting = ref(false);
/** "Start", for a stopped container. */
export const startMachine = async (): Promise<void> => {
    if (machineStarting.value) {
        return;
    }
    machineStarting.value = true;
    try {
        await pressed(() => machineSandboxStart());
    } finally {
        machineStarting.value = false;
    }
};
/** The restart or sign-out its requirements ask of Windows. */
export const endMachineSession = (how: SessionEnd): Promise<void> => pressed(() => machineSandboxEndSession(how));
/** Its last setup's transcript, in the file manager. */
export const revealMachineLog = async (): Promise<void> => {
    const log = machineSandbox.value?.logPath;
    if (log !== undefined) {
        await pressed(() => revealLog(log));
    }
};
