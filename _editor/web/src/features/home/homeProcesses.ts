import { watch } from "vue";
import type { ProcessAction, ProcessReport } from "../../app/environments/processes/processReport";
import { type HeldProcess, holdProcess } from "../../models/processes/faceProcesses";
import { newSandbox, type NewSandboxRun, readNewSandbox } from "./newSandbox/newSandbox";

// HOME'S OWN RUNS, TOLD TO THE APP so This computer draws them too (processReport.ts): a new sandbox Home starts on a
// machine of ours, on a connected machine, or by a command, which only this page follows. The app's install on this
// computer is the app's to tell, so it is left out here. This computer's presses on it come back to the run: Try again,
// Dismiss.

/** The run as a report, or undefined while there is nothing of it to tell (no row yet, or the app runs it). */
const homeRunReport = (run: NewSandboxRun | undefined): ProcessReport | undefined => {
    const reading = readNewSandbox(run);
    const row = run?.here.add.created.value;
    const started = run?.here.add.started.value;
    if (reading === undefined || row === null || row === undefined || started === undefined || started.kind === `here`) {
        return undefined;
    }
    const base = { id: `sandbox-setup:${row.id}`, kind: `sandbox-setup`, origin: `workspace`, subject: row.name, sandboxId: row.id } as const;
    switch (reading.phase) {
        case `failed`:
            return { ...base, state: `failed`, actions: [`retry`, `dismiss`] };
        case `asking`:
            return { ...base, state: `waiting`, waitingFor: `answer`, line: reading.note };
        default:
            return { ...base, state: `running`, line: reading.note };
    }
};

const answer = (run: NewSandboxRun, act: ProcessAction): void => {
    if (act === `retry`) {
        run.retry();
    } else if (act === `dismiss`) {
        run.dismiss();
    }
};

/** Tells the app Home's run for as long as there is one, and lets go of it when it ends. Once, from the shell. */
export const tellHomeRuns = (): void => {
    let held: { readonly id: string; readonly process: HeldProcess } | undefined;
    watch(
        () => {
            const run = newSandbox.value;
            return { run, report: homeRunReport(run) };
        },
        ({ run, report }) => {
            if (held !== undefined && held.id !== report?.id) {
                held.process.release();
                held = undefined;
            }
            if (run === undefined || report === undefined) {
                return;
            }
            held ??= { id: report.id, process: holdProcess(report.id, (act) => answer(run, act)) };
            held.process.tell(report);
        },
    );
};
