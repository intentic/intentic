import {
    advance as advanceShared,
    type DownloadFacts,
    downloadOf,
    type PlanInput,
    type Progress as SharedProgress,
    remainingMsOf,
    setupSteps,
    type SetupStep,
    stepFraction,
    stepShare,
    stepStateOf,
} from "@intentic/sandbox-run/setup-progress";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { RunEvent } from "./desktop";

// THIS APP'S WORDS FOR A SETUP'S PROGRESS. The reading of the run (the plan, its weights, the lines that move it, the
// estimate) is sandbox-run's setup-progress.ts, shared with the web's press on a connected machine; this file names
// each step for the checklist and says the estimate in this app's catalog.

export {
    approach,
    type PlanInput,
    parseDownload,
    parseLayer,
    startProgress,
    tick,
} from "@intentic/sandbox-run/setup-progress";

export interface PlanStep extends SetupStep {
    /**
     * The checklist row, what this step is, in the reader's terms rather than the script's. A function, not a string:
     * a plan outlives the language it was drawn in (a run resumed after a restart is planned before the reader's
     * catalog has loaded), so it is translated each time it is drawn, never once when the plan is made.
     */
    readonly label: () => string;
}

export type Progress = SharedProgress<PlanStep>;

/** Fold one of this app's run events into the progress (the shared `advance`, typed to the app's own events). */
export const advance = (state: Progress, event: RunEvent, now: number): Progress => advanceShared(state, event, now);

// Each step's checklist row, by phase. Windows says what its first check looks at, and sets Docker up rather than
// installing it, since that is WSL and the engine as much as Docker.
const labelOf = (phase: string, windows: boolean): (() => string) => {
    switch (phase) {
        case `fetching-ic`:
            return () => t(`desktop.setupPlan.fetchInstaller`);
        case `checking-docker`:
            return () => (windows ? t(`desktop.setupPlan.checkDockerNeeds`) : t(`desktop.setupPlan.checkDocker`));
        case `installing-docker`:
            return () => (windows ? t(`desktop.setupPlan.setUpDocker`) : t(`desktop.setupPlan.installDocker`));
        case `preflight`:
            return () => t(`desktop.setupPlan.checkDevice`);
        case `claiming-code`:
            return () => t(`desktop.setupPlan.redeemSetupCode`);
        case `starting-sandbox`:
            return () => t(`desktop.setupPlan.startSandbox`);
        case `waiting-health`:
            return () => t(`desktop.setupPlan.waitToComeUp`);
        case `desktop-sync`:
            return () => t(`desktop.setupPlan.setUpFolderSync`);
        case `verifying`:
            return () => t(`desktop.setupPlan.checkAnswers`);
        case `connecting-machine`:
            return () => t(`desktop.setupPlan.connectDevice`);
        default:
            return () => phase;
    }
};

/** The shared plan for this machine, each step named for the checklist. */
export const setupPlan = (input: PlanInput): readonly PlanStep[] => {
    const windows = input.os === `windows`;
    return setupSteps(input).map((step) => ({
        ...step,
        label:
            step.phase === `pulling-image`
                ? () => (input.imageReady === true ? t(`desktop.setupPlan.useSandboxImage`) : t(`desktop.setupPlan.downloadSandboxImage`))
                : labelOf(step.phase, windows),
    }));
};

export interface StepView {
    readonly phase: string;
    readonly label: string;
    readonly state: `done` | `running` | `waiting` | `stopped`;
    /** Only on the running row: what the script is saying about it right now. */
    readonly detail: string | undefined;
    /** This step's share of the whole plan (0..1), so the bar can be drawn in the plan's own proportions. */
    readonly share: number;
}

/** The pull's bytes as the view reports them, while ic reports them. */
export type DownloadView = DownloadFacts;

export interface ProgressView {
    readonly steps: readonly StepView[];
    readonly percent: number;
    /** "Step 4 of 9", the position, for the reader who wants the count rather than the bar. */
    readonly position: string | undefined;
    /** "about 3 min left", or undefined when there is nothing honest to say yet. */
    readonly remaining: string | undefined;
    /** The same estimate in milliseconds, for a page that words it in its own language (the web's local/projectWords.ts). */
    readonly remainingMs: number | undefined;
    /** How far through the running step (0..1): ic's bytes or docker's layers during the pull, the clock else. */
    readonly stepProgress: number;
    /** The pull's bytes, while the running step is the pull and ic reports them. */
    readonly download: DownloadView | undefined;
}

const remainingOf = (state: Progress, now: number): string | undefined => {
    const left = remainingMsOf(state, now);
    if (left === undefined) {
        return undefined;
    }
    if (left < 60_000) {
        return t(`desktop.setupPlan.lessThanMinute`);
    }
    const minutes = Math.round(left / 60_000);
    return t(`desktop.setupPlan.aboutMinutes`, { count: minutes }, minutes);
};

// The running row's line: the script's own sentence, except while ic counts the pull's bytes, which say more.
const runningDetail = (state: Progress): string => {
    const download = state.download;
    if (download === undefined) {
        return state.detail;
    }
    return download.completeAt === undefined
        ? t(`desktop.setupPlan.downloadedOf`, { done: formatBytes(download.done), total: formatBytes(download.total) })
        : t(`desktop.setupPlan.loadingImage`);
};

export const progressView = (state: Progress, now: number): ProgressView => ({
    steps: state.plan.map((step, at) => ({
        phase: step.phase,
        label: step.label(),
        state: stepStateOf(state, at),
        detail: at === state.index && state.ended === undefined ? runningDetail(state) : undefined,
        share: stepShare(state, at),
    })),
    percent: Math.round(state.percent),
    position: state.index < 0 || state.ended !== undefined ? undefined : t(`desktop.setupPlan.stepOf`, { index: state.index + 1, total: state.plan.length }),
    remaining: remainingOf(state, now),
    remainingMs: remainingMsOf(state, now),
    stepProgress: state.index < 0 ? 0 : state.ended === `ok` ? 1 : stepFraction(state, now),
    download: downloadOf(state),
});
