import { computed, watch } from "vue";
import { answering, tellProcess } from "../../processes";
import {
    closeSetup,
    endSession,
    expired,
    freshCode,
    installRequirements,
    pending,
    report,
    requirements,
    requirementsShown,
    runSetup,
    setUpElsewhere,
    setupError,
    stopSetup,
} from "../setup";
import { finishedSetup, handedToHosted, setupProcessOf } from "./setupProcess";
import { running } from "../runs";

// THE SETUP AS A PROCESS (setupProcess.ts): setup.ts's run told to the app's one list as it changes, on both faces'
// rails, and answered from either face. Started by the main window, the one that runs setups (useDevice.ts).

const process = computed(
    () =>
        setupProcessOf({
            args: pending.value,
            report: report.value,
            requirements: requirements.value,
            requirementsShown: requirementsShown.value,
            expired: expired.value,
            failure: setupError.value,
        }) ?? finishedSetup.value,
);

let started = false;

/** The setup told and answered from now on. Once. */
export const tellSetups = (): void => {
    if (started) {
        return;
    }
    started = true;
    let toldAs: string | undefined;
    watch(
        process,
        (current) => {
            const id = current?.id ?? toldAs;
            if (id !== undefined && !handedToHosted.has(id)) {
                tellProcess(id, current);
            }
            toldAs = current?.id;
        },
        { immediate: true },
    );
    answering(`sandbox-setup`, async (act) => {
        switch (act) {
            case `consent`:
                return await installRequirements();
            case `stop`:
                return await stopSetup();
            case `retry`:
                return await runSetup(`retry`);
            case `restart-now`:
                return await endSession(`restart`);
            case `sign-out`:
                return await endSession(`signout`);
            case `fresh-code`:
                return await freshCode();
            case `use-hosted`:
                return await setUpElsewhere(running.value ? `stopped` : `requirements`);
            case `dismiss`:
                finishedSetup.value = undefined;
                closeSetup();
                return;
            default:
                return;
        }
    });
};
