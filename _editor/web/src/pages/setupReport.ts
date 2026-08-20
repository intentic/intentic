import type { SetupReport } from "@intentic-app/api-contract";

/* The machine's setup report, read for step 3's card. One decision, kept pure beside the page (the
 * setupCompose.ts pattern): a report is either a DIAGNOSIS, failures the card renders verbatim, problem and
 * fix per check, or NARRATION, the healthy run's current stage in the user's words. Never both: a spinner
 * narrating progress beside "here is what broke" is the page contradicting itself. */

// The connect flow's real phases (SetupReportSchema.stage), said the way the wait reads them. The pull
// carries its own expectation-setting because it is the one honest multi-minute stage.
const STAGE_LABELS: Record<SetupReport[`stage`], string> = {
    preflight: `checking the machine`,
    "pulling-image": `pulling the sandbox image (the first time takes a few minutes)`,
    "creating-tunnel": `creating its tunnel`,
    "starting-sandbox": `starting the sandbox`,
    "starting-connector": `starting the tunnel connector`,
    "waiting-health": `waiting for it to come up`,
    verifying: `verifying it is reachable end to end`,
    done: `finishing up`,
};

export interface SetupReportView {
    // The run stopped: every broken check, verbatim. Null while the run is healthy (or there is no report).
    readonly failures: SetupReport[`failed`] | null;
    // The healthy run's live stage. Undefined when failed or when there is no report, the card then falls
    // back to its canned line.
    readonly stage: string | undefined;
}

export const setupReportView = (report: SetupReport | null): SetupReportView => {
    if (report === null) {
        return { failures: null, stage: undefined };
    }
    if (report.failed.length > 0) {
        return { failures: report.failed, stage: undefined };
    }
    return { failures: null, stage: STAGE_LABELS[report.stage] };
};
