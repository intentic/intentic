import type { ProcessReport } from "@intentic/web/process-report";
import { ref, watch } from "vue";
import { dockerEndingLine } from "../../components/dockerWords";
import { answering, processOf, tellProcess } from "../../processes";
import { dockerReport, startDocker } from "../docker";
import { dismissEngineMove, engineMoveEnd, engineMoveError, engineMoving, onOurEngine } from "../engine/engine";
import { dockerStarting, info } from "../machine";

// WHAT THIS COMPUTER'S OWN WORK IS, AS PROCESSES (2026-10-26; src-tauri/src/processes.rs): a Docker start and a move of the
// sandboxes between engines, on both faces' rails while they run and once they have said how they ended, answered from
// either face. The main window runs them and tells them (useDevice.ts); Devices' cards still draw them in full. Nobody
// is brought to Devices for them: a launch that found the engine asleep starts it out of sight and opens the face the
// reader last used (lib.rs `opening`). _(2026-10-26) That launch opened Devices, then handed over to the workspace._

/** A Docker start as a process, or nothing while none runs or the last one brought the engine up. Pure. */
export const dockerProcessOf = (starting: boolean, ended: string | undefined): ProcessReport | undefined => {
    if (starting) {
        return processOf(`docker`, `engine`, `running`);
    }
    if (ended === undefined) {
        return undefined;
    }
    return { ...processOf(`docker`, `engine`, `failed`), failure: ended, actions: [`retry`, `dismiss`] };
};

/** A move between engines as a process, or nothing. Pure. */
export const moveProcessOf = (moving: boolean, ended: `moved` | `failed` | `busy` | undefined, error: string | undefined): ProcessReport | undefined => {
    if (moving) {
        return processOf(`engine-move`, `this`, `running`);
    }
    if (error !== undefined) {
        return { ...processOf(`engine-move`, `this`, `failed`), failure: error, actions: [`dismiss`] };
    }
    if (ended === undefined) {
        return undefined;
    }
    return { ...processOf(`engine-move`, `this`, ended === `moved` ? `done` : `failed`), actions: [`dismiss`] };
};

// A start that did not bring the engine up, in the card's own words; put away when the reader dismisses it.
const dockerDismissed = ref(false);
const dockerEnded = (): string | undefined => {
    const report = dockerReport.value;
    if (report === undefined || report.outcome === `ready` || dockerDismissed.value) {
        return undefined;
    }
    return dockerEndingLine(report.outcome, { ours: onOurEngine.value, windows: info.value?.os === `windows` });
};

const keepTold = (id: string, read: () => ProcessReport | undefined): void => {
    watch(read, (current) => tellProcess(id, current), { immediate: true });
};

let started = false;

/** This computer's own work told and answered from now on: the main window's, which runs it. Once. */
export const tellDeviceWork = (): void => {
    if (started) {
        return;
    }
    started = true;
    watch(dockerStarting, (starting) => {
        if (starting) {
            dockerDismissed.value = false;
        }
    });
    keepTold(`docker:engine`, () => dockerProcessOf(dockerStarting.value, dockerEnded()));
    keepTold(`engine-move:this`, () => moveProcessOf(engineMoving.value !== undefined, engineMoveEnd.value?.outcome, engineMoveError.value));
    answering(`docker`, async (act) => {
        if (act === `retry`) {
            await startDocker(`card`);
        } else if (act === `dismiss`) {
            dockerDismissed.value = true;
        }
    });
    answering(`engine-move`, (act) => {
        if (act === `dismiss`) {
            dismissEngineMove();
        }
    });
};
