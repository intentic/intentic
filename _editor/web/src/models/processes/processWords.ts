import { t } from "@intentic/ui/i18n";
import type { ProcessAction, ProcessReport } from "../../app/environments/processes/processReport";

// A PROCESS IN THE PAGE'S OWN WORDS (processReport.ts says why a report carries ids rather than sentences): what it is,
// where it stands, and what each press does. The only words from the report itself are the owner's: a name the reader
// typed, the app's "Step 4 of 10", a requirement's label, a failure's reason.

/** What the run is, about what: "Setting up shop", "Preparing this computer". */
export const processTitle = (report: ProcessReport): string => {
    const name = report.subject ?? ``;
    switch (report.kind) {
        case `sandbox-setup`:
            return name === `` ? t(`processes.title.sandboxSetupUnnamed`) : t(`processes.title.sandboxSetup`, { name });
        case `pc-setup`:
            return t(`processes.title.pcSetup`);
        case `docker`:
            return t(`processes.title.docker`);
        case `folder-setup`:
            return t(`processes.title.folderSetup`, { name });
        case `sign-in`:
            return t(`processes.title.signIn`);
        case `recreate`:
            return t(`processes.title.recreate`, { name });
        case `fix`:
            return t(`processes.title.fix`, { name });
        case `sync`:
            return t(`processes.title.sync`, { name });
        case `repair`:
            return t(`processes.title.repair`);
        case `engine-move`:
            return t(`processes.title.engineMove`);
        case `first-task`:
            return t(`processes.title.firstTask`, { name });
    }
};

/** What a waiting run waits for, as one line. */
const waitLine = (report: ProcessReport): string => {
    switch (report.waitingFor) {
        case `consent`:
            return t(`processes.wait.consent`);
        case `restart`:
            return t(`processes.wait.restart`);
        case `signOut`:
            return t(`processes.wait.signOut`);
        case `pcSetup`:
            return t(`processes.wait.pcSetup`);
        case `browser`:
            return t(`processes.wait.browser`);
        default:
            return t(`processes.wait.answer`);
    }
};

/** Where it stands, one line: the tile's note and the page's subtitle. */
export const processNote = (report: ProcessReport): string => {
    switch (report.state) {
        case `waiting`:
            return waitLine(report);
        case `failed`:
            return t(`processes.state.failed`);
        case `stopped`:
            return t(`processes.state.stopped`);
        case `done`:
            return t(`processes.state.done`);
        case `running`: {
            const percent = report.percent === undefined ? undefined : Math.round(report.percent);
            if (report.line !== undefined) {
                return percent === undefined ? report.line : `${report.line} · ${String(percent)}%`;
            }
            return percent === undefined || percent <= 0 ? t(`processes.state.running`) : t(`processes.state.runningPercent`, { percent });
        }
    }
};

/** A press's words. `open` names what it opens where the report says. */
export const processActionLabel = (act: ProcessAction, report?: ProcessReport): string => {
    switch (act) {
        case `consent`:
            return t(`processes.action.consent`);
        case `stop`:
            return t(`processes.action.stop`);
        case `retry`:
            return t(`processes.action.retry`);
        case `dismiss`:
            return t(`processes.action.dismiss`);
        case `restart-now`:
            return t(`processes.action.restartNow`);
        case `restart-in-10`:
            return t(`processes.action.restartIn10`);
        case `restart-later`:
            return t(`processes.action.restartLater`);
        case `sign-out`:
            return t(`processes.action.signOut`);
        case `use-hosted`:
            return t(`processes.action.useHosted`);
        case `fresh-code`:
            return t(`processes.action.freshCode`);
        case `open`:
            return report?.subject === undefined ? t(`processes.action.open`) : t(`processes.action.openNamed`, { name: report.subject });
        case `sign-in-again`:
            return t(`processes.action.signInAgain`);
        case `cancel`:
            return t(`processes.action.cancel`);
        case `allow`:
            return t(`processes.action.allow`);
        case `deny`:
            return t(`processes.action.deny`);
    }
};

/** Presses that end or leave the run rather than move it on: drawn quieter than the main one. */
export const quietAction = (act: ProcessAction): boolean => act === `dismiss` || act === `cancel` || act === `stop` || act === `restart-later` || act === `deny`;
