import type { Ref } from "vue";
import type { ProcessAction, ProcessReport } from "./processReport";

// What a local window is handed about the app's processes and a new sandbox made from it (localHost.ts `processes`,
// `newSandbox`; the app's src/host.ts fills them in).

/* THE APP'S PROCESSES, as a local window draws and answers them (the app's processes.rs, src/processes.ts). */
export interface LocalProcessesHost {
    /** Every process the app knows of, its own and the workspace's, newest report each. */
    readonly list: Readonly<Ref<readonly ProcessReport[]>>;
    /** An answer to one, as the workspace's `intentic://process-act` gives it: on the run, or on one of its needs. */
    act(id: string, act: ProcessAction, need?: string): Promise<void>;
}

/** Where a new sandbox made from this window can run, read now: this computer, and a machine of ours while one can start. */
export interface LocalNewSandboxOffers {
    readonly here: boolean;
    readonly hosted: boolean;
    /** Why a machine of ours cannot start now, in the platform's words, when it is offered at all. */
    readonly hostedProblem?: string;
}

/* A NEW SANDBOX FROM THIS COMPUTER (2026-10-26): Devices' "Set one up" and the switcher's "Add a sandbox" make it here, in
   this window, rather than sending the reader to the workspace to do it. The app makes the row, and runs it on this
   computer or starts a machine of ours for it; from then it is a process (`sandbox-setup:<id>`) on both faces' rails. */
export interface LocalNewSandboxHost {
    offers(): Promise<LocalNewSandboxOffers>;
    /** Makes the sandbox under `name` and starts it where picked. Rejects with the platform's words. */
    create(name: string, on: `here` | `hosted`): Promise<{ readonly sandboxId: string }>;
}
