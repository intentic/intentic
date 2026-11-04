import { type Progress, remainingMsOf } from "@intentic/sandbox-run/setup-progress";
import { formatBytes } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import type { ProgressStatus } from "./stagedSteps";

// A RUN THAT ANNOUNCES ITS PHASES (`intentic: [<phase>] …`, read by sandbox-run's setup-progress engine), AS THE READER
// SEES IT: what <StagedProgress> takes beside the plan. Shared by every run read that way — a sandbox set up on a
// computer (features/setup/progress) and a runner added to one (features/sandbox/devices/runners) — so the two say
// their bytes, their time left and their ending in the same words. Pure; each caller ticks the engine to `now` first.

export interface SetupRunView {
    readonly status: ProgressStatus;
    /** The step under way, or the one the run stopped on; the first step before ic has named one. */
    readonly stage: string;
    /** How far along, 0 to 1, never falling, and 1 only once the run said it finished. */
    readonly measured: number;
    /** What the running step is on this second: the image's bytes while they come, else ic's own sentence. */
    readonly detail: string | undefined;
    /** "about 3 minutes left", or nothing while there is nothing honest to say. */
    readonly remaining: string | undefined;
}

const remainingWords = (ms: number | undefined): string | undefined => {
    if (ms === undefined) {
        return undefined;
    }
    if (ms < 60_000) {
        return t(`setup.setupRunProgress.lessThanMinute`);
    }
    const minutes = Math.round(ms / 60_000);
    return t(`setup.setupRunProgress.aboutMinutes`, { count: minutes }, minutes);
};

const detailOf = (progress: Progress): string | undefined => {
    const download = progress.download;
    if (download !== undefined) {
        return download.completeAt === undefined
            ? t(`setup.setupRunProgress.downloadedOf`, { done: formatBytes(download.done), total: formatBytes(download.total) })
            : t(`setup.setupRunProgress.loadingImage`);
    }
    return progress.detail === `` ? undefined : progress.detail;
};

/** The run as the reader sees it at `now` (`progress` already ticked to it). */
export const setupRunView = (progress: Progress, now: number): SetupRunView => ({
    status: progress.ended === `ok` ? `done` : progress.ended === `failed` ? `stopped` : `running`,
    stage: progress.plan[Math.max(progress.index, 0)]?.phase ?? ``,
    measured: progress.percent / 100,
    detail: progress.ended === undefined ? detailOf(progress) : undefined,
    remaining: remainingWords(remainingMsOf(progress, now)),
});
