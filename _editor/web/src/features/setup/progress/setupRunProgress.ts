import { type SetupStep, setupSteps } from "@intentic/sandbox-run/setup-progress";
import { t } from "@intentic/ui/i18n";
import type { ProgressStep } from "../../../components/progress/stagedSteps";

// A SANDBOX BEING SET UP ON A COMPUTER, AS THE READER SEES IT: the run's own lines read by the same engine the desktop
// app reads its install with (sandbox-run's setup-progress.ts), said in this page's words, and drawn by the card every
// long run on a machine is drawn with (<StagedProgress>: its steps, a bar sized by them, the log one press away). Pure,
// so every state is tested by value (setupRunProgress.test.ts); useSetupRunProgress.ts feeds it the lines and the clock.

/**
 * The plan of a press on a computer that is already connected: it runs `ic sandbox connect` itself, so there is no
 * installer to fetch, and the computer already runs Docker or the Intentic engine, or it would not have been offered
 * (setupDoors). Nothing of a folder is synced by that press. An unknown image reads as a download, the honest side.
 */
export const machinePlan = (): readonly SetupStep[] =>
    setupSteps({ dockerReady: true, syncing: false, os: `linux` }).filter((step) => step.phase !== `fetching-ic`);

// The step's row in this page's words, by the phase ic prints.
const stepLabel = (phase: string): string => {
    switch (phase) {
        case `fetching-ic`:
            return t(`setup.setupRunProgress.step.fetchingIc`);
        case `checking-docker`:
            return t(`setup.setupRunProgress.step.checkingDocker`);
        case `installing-docker`:
            return t(`setup.setupRunProgress.step.installingDocker`);
        case `preflight`:
            return t(`setup.setupRunProgress.step.preflight`);
        case `claiming-code`:
            return t(`setup.setupRunProgress.step.claimingCode`);
        case `pulling-image`:
            return t(`setup.setupRunProgress.step.pullingImage`);
        case `starting-sandbox`:
            return t(`setup.setupRunProgress.step.startingSandbox`);
        case `waiting-health`:
            return t(`setup.setupRunProgress.step.waitingHealth`);
        case `desktop-sync`:
            return t(`setup.setupRunProgress.step.desktopSync`);
        case `verifying`:
            return t(`setup.setupRunProgress.step.verifying`);
        case `connecting-machine`:
            return t(`setup.setupRunProgress.step.connectingMachine`);
        default:
            return phase;
    }
};

/** The plan as <StagedProgress> draws it: each step named, and sized by its share of the whole. */
export const stagedPlan = (plan: readonly SetupStep[]): readonly ProgressStep[] => {
    const whole = Math.max(
        plan.reduce((sum, step) => sum + step.weight, 0),
        1,
    );
    return plan.map((step) => ({ key: step.phase, label: stepLabel(step.phase), note: ``, weight: step.weight / whole }));
};

/**
 * The lines of `next` that were not in `prev`: the run's log only ever grows at its end, but it is a window of its last
 * few hundred lines, so once full it slides rather than grows. `undefined` when `next` is not a continuation of `prev`
 * at all (a new run), whose lines are then read from the start.
 */
export const appendedLines = (prev: readonly string[], next: readonly string[]): readonly string[] | undefined => {
    const last = prev.at(-1);
    if (last === undefined) {
        return next;
    }
    if (next.length >= prev.length && next[0] === prev[0] && next[prev.length - 1] === last) {
        return next.slice(prev.length);
    }
    const at = next.lastIndexOf(last);
    return at < 0 ? undefined : next.slice(at + 1);
};
