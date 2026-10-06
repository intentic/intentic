import type { SetupReport } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { scrubDiagnostic } from "../../app/replayText";

/* The machine's setup report, read for step 3's card. */

// The connect flow's real phases (SetupReportSchema.stage), said the way the wait reads them. The pull
// carries its own expectation-setting because it is the one honest multi-minute stage. Built when read, so the words
// follow the language picked after boot.
const stageLabels = (): Record<SetupReport[`stage`], string> => ({
    preflight: t(`setup.setupReport.preflight`),
    "pulling-image": t(`setup.setupReport.pullingImage`),
    "creating-tunnel": t(`setup.setupReport.creatingTunnel`),
    "starting-sandbox": t(`setup.setupReport.startingSandbox`),
    "starting-connector": t(`setup.setupReport.startingConnector`),
    "waiting-health": t(`setup.setupReport.waitingHealth`),
    verifying: t(`setup.setupReport.verifying`),
    done: t(`setup.setupReport.done`),
});

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
    return { failures: null, stage: stageLabels()[report.stage] };
};

// Of the first failure's problem, what the failure event carries: the cause and docker's own last words fit in it.
const PROBLEM_CHARS = 600;

/**
 * What `sandbox_setup_failed` says about a run that stopped: the stage, every broken check, and the first one's own words,
 * scrubbed like a replay's diagnostics (app/replayText.ts), so a cause can be counted without watching a replay.
 */
export const setupFailedEvent = (report: SetupReport) => ({
    stage: report.stage,
    checks: report.failed.map((failure) => failure.check).join(`,`),
    problem: scrubDiagnostic(report.failed[0]?.problem ?? ``).slice(0, PROBLEM_CHARS),
});
