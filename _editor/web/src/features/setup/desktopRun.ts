import { formatFixed } from "@intentic/ui/format";
import type { DesktopSetupReport } from "../../app/environments/desktopSetupReport";

// The desktop app's run as this page reads it off the app's reports (desktopSetup.ts hears them): whether the app has
// gone quiet for longer than its kind of app ever does, how far the image download has got, and whether that download
// is too slow to wait for. Pure, so each threshold is a value a test pins.

const MB = 1_000_000;

/* HOW LONG THE APP MAY GO UNHEARD BEFORE THE PAGE SAYS SO. */

// An app that heartbeats (its reports carry `at`) re-sends its report at least every five seconds while it runs or
// waits: twenty seconds of nothing is four missed beats, and a minute of nothing is an app no longer running the setup.
export const HEARTBEAT_QUIET_MS = 20_000;
export const HEARTBEAT_GONE_MS = 60_000;
// An app from before heartbeats (v1.331.0 and older, still the one most people have) reports only when its report
// changes, and a download that outruns its estimate changes nothing for minutes at a time: a minute of quiet there is a
// normal pull. Past three minutes the page asks the reader to look at the window, and it never calls such an app gone,
// since no length of quiet tells a slow download from a closed app. Telling people to restart it was the harm
// (2026-10-12): the restarted app started a second install beside the first, which kept running unseen.
export const CHANGE_ONLY_QUIET_MS = 3 * 60_000;

/** `heard` nothing to say; `quiet` longer than this kind of app goes unheard; `gone` an app that stopped heartbeating. */
export type AppSilence = `heard` | `quiet` | `gone`;

const heartbeats = (report: DesktopSetupReport): boolean => report.at !== undefined;

// A run the app keeps talking about: one under way, or (where it heartbeats) one parked behind this PC's own setup. A
// question on its card is not, since an older app says nothing while the reader decides.
const reported = (report: DesktopSetupReport): boolean =>
    report.state === `running` || (report.state === `waiting` && report.waitingFor === `pcSetup` && heartbeats(report));

export const appSilence = (report: DesktopSetupReport | undefined, heardAt: number | undefined, now: number): AppSilence => {
    if (report === undefined || heardAt === undefined || !reported(report)) {
        return `heard`;
    }
    const silentFor = now - heardAt;
    if (heartbeats(report)) {
        if (silentFor > HEARTBEAT_GONE_MS) {
            return `gone`;
        }
        return silentFor > HEARTBEAT_QUIET_MS ? `quiet` : `heard`;
    }
    return silentFor > CHANGE_ONLY_QUIET_MS ? `quiet` : `heard`;
};

// Whether the app's own report still stands for a live run: running or waiting, and not an app that stopped
// heartbeating. A note asking for a re-run beside it would start a second install over the first.
export const appRunLive = (report: DesktopSetupReport | undefined, heardAt: number | undefined, now: number): boolean =>
    report !== undefined && (report.state === `running` || report.state === `waiting`) && appSilence(report, heardAt, now) !== `gone`;

/* THE DOWNLOAD, AS FIGURES. */

export interface DownloadFigures {
    readonly done: string;
    readonly total: string;
    /** Decimal units, as Docker counts its layers: 2.2 GB is the image's own size on the registry. */
    readonly unit: `GB` | `MB`;
}

// "1.1 of 2.2 GB", or nothing where the app did not say both. The count never shows past the total, which a last
// layer's own rounding can reach.
export const downloadFigures = (report: DesktopSetupReport): DownloadFigures | undefined => {
    const { downloaded, downloadTotal } = report;
    if (downloaded === undefined || downloadTotal === undefined || downloadTotal <= 0) {
        return undefined;
    }
    const done = Math.min(downloaded, downloadTotal);
    if (downloadTotal >= 1000 * MB) {
        return { done: formatFixed(done / (1000 * MB), 1), total: formatFixed(downloadTotal / (1000 * MB), 1), unit: `GB` };
    }
    return { done: formatFixed(Math.round(done / MB), 0), total: formatFixed(Math.round(downloadTotal / MB), 0), unit: `MB` };
};

/** A download's two counts, in whole MB, as the funnel is told them. */
export interface DownloadMb {
    downloadedMb?: number;
    downloadTotalMb?: number;
}

// How far a download had got, for the funnel: a stuck pull's replay asks exactly this. Nothing where the app said none.
export const downloadMb = (report: DesktopSetupReport | undefined): DownloadMb => {
    const counts: DownloadMb = {};
    if (report?.downloaded !== undefined) {
        counts.downloadedMb = Math.round(report.downloaded / MB);
    }
    if (report?.downloadTotal !== undefined) {
        counts.downloadTotalMb = Math.round(report.downloadTotal / MB);
    }
    return counts;
};

// Whole minutes left by the app's own estimate in seconds, 0 for under one; undefined where it gave none, and the
// page shows its `remaining` words instead.
export const minutesLeft = (report: DesktopSetupReport): number | undefined =>
    report.remainingSeconds === undefined ? undefined : report.remainingSeconds < 60 ? 0 : Math.round(report.remainingSeconds / 60);

/* A DOWNLOAD TOO SLOW TO WAIT FOR. */

// Past ten minutes still to go by the app's estimate, or, from an app that gives none in seconds, eight minutes into
// the pull: the reader is offered a machine of ours instead, and taking it stops the PC's download (Setup.vue).
export const SLOW_DOWNLOAD_LEFT_S = 600;
export const SLOW_DOWNLOAD_MS = 8 * 60_000;

// Only from an app that stamps its reports (`at`): it shipped with `intentic://setup-stop`, which the offer opens first.
// An older app ignores that link, so taking the offer there would leave its download going for a sandbox now ours, and
// the offer's "this stops the download on this PC" would be untrue. Those readers keep the page's own hosted link.
export const slowDownload = (report: DesktopSetupReport | undefined, stepSince: number | undefined, now: number): boolean => {
    if (report?.state !== `running` || report.step !== `pulling-image` || report.at === undefined) {
        return false;
    }
    if (report.remainingSeconds !== undefined) {
        return report.remainingSeconds > SLOW_DOWNLOAD_LEFT_S;
    }
    return stepSince !== undefined && now - stepSince > SLOW_DOWNLOAD_MS;
};
