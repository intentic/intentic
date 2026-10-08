import { shallowRef } from "vue";
import { activeSandboxId } from "../../../../lib/activeSandbox";

// TURNING SYNC ON OUTLIVES THE ROW IT WAS PRESSED ON. Setting up a folder restarts this machine's agent, so the row goes
// offline and comes back while the press is still out, and the component holding the folder field is made again. Kept
// in the component, the folder the owner typed fell back to the suggestion halfway through and the pressed state
// vanished, so a setup that was working read as one that had done nothing (2026-10-08). Both live here instead, keyed by
// the sandbox this page serves, the machine, and the row's sandbox.

export interface PendingSetup {
    readonly folder: string;
    readonly mode: "sync" | "mirror";
    readonly startedAt: number;
}

// allow(module-state): typed folders, kept past the remount a setup's own agent restart causes
const drafts = shallowRef<Readonly<Record<string, string>>>({});
// allow(module-state): setups in flight, kept past the same remount
const pending = shallowRef<Readonly<Record<string, PendingSetup>>>({});

const rowKey = (machine: string, sandboxId: string): string => `${activeSandboxId.value ?? ``}\n${machine}\n${sandboxId}`;

export const draftFolder = (machine: string, sandboxId: string, environment: string): string | undefined =>
    drafts.value[`${rowKey(machine, sandboxId)}\n${environment}`];

export const setDraftFolder = (machine: string, sandboxId: string, environment: string, folder: string): void =>
    void (drafts.value = { ...drafts.value, [`${rowKey(machine, sandboxId)}\n${environment}`]: folder });

export const pendingSetup = (machine: string, sandboxId: string): PendingSetup | undefined => pending.value[rowKey(machine, sandboxId)];

/** Marks a setup in flight until the returned end is called. One that went through drops the row's typed folders, which
 * are set up now; one that was refused keeps them, to correct and press again. */
export const beginSetup = (machine: string, sandboxId: string, setup: Omit<PendingSetup, "startedAt">): ((succeeded: boolean) => void) => {
    const key = rowKey(machine, sandboxId);
    pending.value = { ...pending.value, [key]: { ...setup, startedAt: Date.now() } };
    return (succeeded): void => {
        const { [key]: _done, ...rest } = pending.value;
        pending.value = rest;
        if (succeeded) {
            drafts.value = Object.fromEntries(Object.entries(drafts.value).filter(([draft]) => !draft.startsWith(`${key}\n`)));
        }
    };
};

/** Test seam: module state would follow one test into the next. */
export const forgetSyncSetups = (): void => {
    drafts.value = {};
    pending.value = {};
};

/**
 * What the machine said when setup finished, as a reader under the row needs it. The answer is the CLI's own plain
 * output: progress narration (`intentic: …` and its indented continuations), the fleet it now syncs, and footnotes
 * naming commands to type. On this page the row already shows the folder and its state, and its buttons do what the
 * footnotes would, so what is left is the verdict and anything the machine had to say about this folder.
 */
export const setupSaid = (message: string): string =>
    message
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(`intentic:`) && !line.startsWith(`          `))
        .map((line) => line.trim())
        .filter((line) => line !== `` && !/^[a-z][a-z ]*: intentic-machine\b/.test(line))
        .join(`\n`);
