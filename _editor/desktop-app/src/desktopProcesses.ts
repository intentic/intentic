import type { ProcessAction, ProcessReport } from "@intentic/web/process-report";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// Typed surface over the app's process list (src-tauri/src/processes.rs) and a new sandbox made from a local window
// (src-tauri/src/new_sandbox.rs), beside desktop.ts's.

/* THE APP'S PROCESSES, ONE LIST FOR BOTH FACES (src-tauri/src/processes.rs; the web's processReport.ts). This window
   reports the runs it drives, hears the whole list, and passes the reader's answers on; the main window also hears the
   answers to its own runs, from whichever face gave them. */
export const processReport = (report: ProcessReport): Promise<void> => invoke(`process_report`, { report });
export const processClear = (id: string): Promise<void> => invoke(`process_clear`, { id });
export const processesList = (): Promise<ProcessReport[]> => invoke(`processes_list`);
export const processAct = (id: string, act: ProcessAction, need?: string): Promise<void> => invoke(`process_act`, { id, act, need: need ?? null });
export const onProcesses = (handler: (reports: readonly ProcessReport[]) => void): Promise<UnlistenFn> =>
    listen<readonly ProcessReport[]>(`desktop://processes`, (event) => handler(event.payload));
/** An answer to one of this window's runs: `need` names the need it answers, where it answers one. */
export interface ProcessActEvent {
    readonly id: string;
    readonly act: ProcessAction;
    readonly need?: string | null;
}
export const onProcessAct = (handler: (asked: ProcessActEvent) => void): Promise<UnlistenFn> =>
    listen<ProcessActEvent>(`desktop://process-act`, (event) => handler(event.payload));

/* A NEW SANDBOX FROM A LOCAL WINDOW (src-tauri/src/new_sandbox.rs; the web's localProcessHost.ts). */
export interface NewSandboxOffers {
    readonly here: boolean;
    readonly hosted: boolean;
    readonly hostedProblem?: string;
}
export const newSandboxOffers = (): Promise<NewSandboxOffers> => invoke(`new_sandbox_offers`);
export const newSandboxCreate = (name: string, on: `here` | `hosted`): Promise<{ readonly sandboxId: string }> => invoke(`new_sandbox_create`, { name, on });
/** A machine of ours for a sandbox this computer was setting up: started for the same row, followed as its process. */
export const newSandboxHosted = (sandboxId: string, name: string): Promise<void> => invoke(`new_sandbox_hosted`, { sandboxId, name });
