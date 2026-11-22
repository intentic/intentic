import { t } from "@intentic/ui/i18n";
import type { DesktopSetupReport } from "../../../app/environments/desktopSetupReport";
import type { ProgressStatus, ProgressStep } from "../../../components/progress/stagedSteps";
import { minutesLeft } from "../../setup/desktopRun";
import type { WaitStepView } from "../../setup/hostedWait";

// HOW FAR THE NEW SANDBOX HAS GOT, THE SAME FEW FACTS WHICHEVER WAY IT RUNS (2026-11-22). Only the app's install on this
// computer used to say a percent, so a sandbox made on a connected machine or on a machine of ours wore a bare spinner on
// its tile, a hover that said "Setting up…" for minutes, and nothing at all on This computer's page for it. Each lane's
// own reading is folded here into one gauge: how full, the step it is on and its place among the steps, and the time left
// where the lane can say it. The tile, the cluster under a sandbox's switcher, the page and the report This computer
// draws all read this one. Pure, so each lane's reading is pinned by value (newSandboxGauge.test.ts).

export interface NewSandboxGauge {
    /** How full, 0 to 1, where the run counts itself; undefined where it cannot say. */
    readonly share: number | undefined;
    /** The step it is on, in this page's words, or in the app's own. */
    readonly step?: string | undefined;
    /** That step's place among them, from 1, and how many there are, where the lane knows its plan. */
    readonly index?: number | undefined;
    readonly count?: number | undefined;
    /** The app's own words for its place ("Step 4 of 10"), shown as they came, where it gives them. */
    readonly position?: string | undefined;
    /** "about 3 minutes left", where the lane has an honest figure. */
    readonly remaining?: string | undefined;
    /** When the run began, ms since the epoch, where the lane noted it. */
    readonly startedAt?: number | undefined;
}

const clamp = (share: number): number => Math.min(1, Math.max(0, share));
// Full only once the run said it finished: a last step counted through before its exit is not done yet.
const UNFINISHED = 0.99;
const running = (share: number): number => Math.min(UNFINISHED, clamp(share));

/** The app's install on this computer, as its report tells it: its own percent and its own words. */
// Only while it runs: a wait (its go-ahead, a restart, this PC's own setup first) has no bar of this run's to draw.
// The time left in this page's words where the app gave it in seconds, as the app's own card on the page says it
// (DesktopSetupProgress.vue), else the app's words as they came.
const desktopLeft = (report: DesktopSetupReport): string | undefined => {
    const minutes = minutesLeft(report);
    if (minutes === undefined) {
        return report.remaining;
    }
    return minutes === 0 ? t(`setup.desktopSetupProgress.lessThanMinuteLeft`) : t(`setup.desktopSetupProgress.minutesLeft`, { count: minutes }, minutes);
};

export const desktopGauge = (report: DesktopSetupReport): NewSandboxGauge => ({
    share: report.state === `done` ? 1 : report.state === `running` ? running(report.percent / 100) : undefined,
    position: report.position,
    remaining: report.state === `running` ? desktopLeft(report) : undefined,
});

/** A run on a connected machine, as its lines read (features/setup/progress): the engine's measure and the step it names. */
export const machineGauge = (run: {
    readonly steps: readonly ProgressStep[];
    readonly stage: string;
    readonly measured: number;
    readonly status: ProgressStatus;
    readonly remaining: string | undefined;
    readonly startedAt: number;
}): NewSandboxGauge => {
    const at = run.steps.findIndex((step) => step.key === run.stage);
    return {
        share: run.status === `done` ? 1 : running(run.measured),
        step: run.steps[at]?.label,
        index: at === -1 ? undefined : at + 1,
        count: run.steps.length,
        remaining: run.status === `running` ? run.remaining : undefined,
        startedAt: run.startedAt,
    };
};

/** A machine of ours starting, by the steps its wait reads off it (hostedWait.ts): each passed step full, the one under
 *  way half, since nothing in it is counted. */
export const hostedGauge = (steps: readonly WaitStepView[]): NewSandboxGauge => {
    const done = steps.filter((step) => step.state === `done`).length;
    const active = steps.findIndex((step) => step.state === `active`);
    return {
        share: steps.length === 0 ? undefined : running((done + (active === -1 ? 0 : 0.5)) / steps.length),
        step: active === -1 ? undefined : steps[active]?.label,
        index: active === -1 ? undefined : active + 1,
        count: steps.length,
    };
};

/** The share as a whole percent for a line or a report; undefined where there is none to say. */
export const gaugePercent = (gauge: NewSandboxGauge | undefined): number | undefined =>
    gauge?.share === undefined ? undefined : Math.round(gauge.share * 100);

/** Its place among the steps in words ("Step 4 of 9"): the app's own where it gave them, else this page's; undefined where
 *  the lane knows no plan. */
export const gaugePosition = (gauge: NewSandboxGauge | undefined): string | undefined => {
    if (gauge?.position !== undefined) {
        return gauge.position;
    }
    return gauge?.index === undefined || gauge.count === undefined ? undefined : t(`home.newSandbox.stepOf`, { index: gauge.index, count: gauge.count });
};
