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

// Why the last press did nothing, said beside This device's buttons.
export const machineActionError = ref<string | undefined>(undefined);

// One press: why it did nothing is said beside This device's buttons, and handed on with the rejection, so a press made
// somewhere else (a folder window's card) says it where it was made.
const attempt = async (action: () => Promise<void>): Promise<void> => {
    machineActionError.value = undefined;
    try {
        await action();
    } catch (error) {
        // The app's refusal is already a sentence for the reader (machine_sandbox.rs); a thrown Error carries it whole.
        const said = error instanceof Error ? error.message : String(error);
        machineActionError.value = said;
        throw new Error(said, { cause: error });
    }
};

// A start takes its minute: said while it runs, so a second press is not mistaken for nothing happening.
export const machineStarting = ref(false);

/**
 * THE PRESSES THEMSELVES, each rejecting with the app's sentence: what a folder window's card calls (host.ts `act`), as
 * the shell's contract asks of every verb (localHost.ts `LocalHost`). Until 2026-10-12 the card called the quiet forms
 * below, and a Start, a Try again or a Set it up again that the app refused changed nothing on the card at all.
 */
export const machineVerbs = {
    /** "Try again", or the requirements card's go-ahead (`consent`) and "Check again". */
    retry: (consent = false): Promise<void> => attempt(() => machineSandboxRetry(consent)),
    /** Look again now (Docker was just started). */
    check: (): Promise<void> => attempt(() => machineSandboxCheck()),
    /** "Set it up again" (machine_sandbox.rs `recreated`). */
    recreate: (): Promise<void> => attempt(() => machineSandboxRecreate()),
    /** "Start", for a stopped container: a press while one runs is that same start. */
    start: async (): Promise<void> => {
        if (machineStarting.value) {
            return;
        }
        machineStarting.value = true;
        try {
            await attempt(() => machineSandboxStart());
        } finally {
            machineStarting.value = false;
        }
    },
    /** The restart or sign-out its requirements ask of Windows. */
    endSession: (how: SessionEnd): Promise<void> => attempt(() => machineSandboxEndSession(how)),
    /** Its last setup's transcript, in the file manager. */
    log: async (): Promise<void> => {
        const log = machineSandbox.value?.logPath;
        if (log !== undefined) {
            await attempt(() => revealLog(log));
        }
    },
};

// This device's own buttons, where the sentence beside them (machineActionError) is the whole answer.
// allow(silent-catch): `attempt` has already said it beside the button that was pressed; nothing else waits on it.
const quietly = (press: Promise<void>): Promise<void> => press.catch(() => undefined);

/** "Try again", or the requirements card's go-ahead (`consent`) and "Check again". */
export const retryMachine = (consent = false): Promise<void> => quietly(machineVerbs.retry(consent));
/** Look again now (Docker was just started). */
export const checkMachine = (): Promise<void> => quietly(machineVerbs.check());
/** "Set it up again" (machine_sandbox.rs `recreated`). */
export const recreateMachine = (): Promise<void> => quietly(machineVerbs.recreate());
/** "Start", for a stopped container. */
export const startMachine = (): Promise<void> => quietly(machineVerbs.start());
/** The restart or sign-out its requirements ask of Windows. */
export const endMachineSession = (how: SessionEnd): Promise<void> => quietly(machineVerbs.endSession(how));
/** Its last setup's transcript, in the file manager. */
export const revealMachineLog = (): Promise<void> => quietly(machineVerbs.log());
