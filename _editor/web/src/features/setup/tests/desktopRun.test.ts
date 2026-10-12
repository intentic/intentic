import type { DesktopSetupReport } from "../../../app/environments/desktop";
import {
    appRunLive,
    appSilence,
    CHANGE_ONLY_QUIET_MS,
    downloadFigures,
    downloadMb,
    HEARTBEAT_GONE_MS,
    HEARTBEAT_QUIET_MS,
    minutesLeft,
    SLOW_DOWNLOAD_MS,
    slowDownload,
} from "../desktopRun";

// The desktop install as the page reads it (2026-10-12): an app from before heartbeats went a minute at a time without a
// word while its download outran its estimate, the page called that "no word from the app" after twenty seconds and
// told the reader to restart it, and the restart started a second install beside the first.

const heardAt = 1_000_000;
const pulling: DesktopSetupReport = { state: `running`, percent: 53, step: `pulling-image` };
const beating: DesktopSetupReport = { ...pulling, at: heardAt };

describe(`how long the app may go unheard`, () => {
    it(`is twenty seconds for an app that heartbeats, and a minute before it counts as gone`, () => {
        expect(appSilence(beating, heardAt, heardAt + HEARTBEAT_QUIET_MS)).toBe(`heard`);
        expect(appSilence(beating, heardAt, heardAt + HEARTBEAT_QUIET_MS + 1)).toBe(`quiet`);
        expect(appSilence(beating, heardAt, heardAt + HEARTBEAT_GONE_MS + 1)).toBe(`gone`);
    });

    // A download outrunning its estimate changes nothing in an older app's report for minutes at a time.
    it(`is three minutes for an app that reports only on a change, and never gone`, () => {
        expect(appSilence(pulling, heardAt, heardAt + 60_000)).toBe(`heard`);
        expect(appSilence(pulling, heardAt, heardAt + CHANGE_ONLY_QUIET_MS)).toBe(`heard`);
        expect(appSilence(pulling, heardAt, heardAt + CHANGE_ONLY_QUIET_MS + 1)).toBe(`quiet`);
        expect(appSilence(pulling, heardAt, heardAt + 60 * 60_000)).toBe(`quiet`);
    });

    it(`counts a wait on this PC's own setup only from an app that heartbeats through it`, () => {
        const parked: DesktopSetupReport = { state: `waiting`, percent: 0, waitingFor: `pcSetup` };
        expect(appSilence({ ...parked, at: heardAt }, heardAt, heardAt + HEARTBEAT_GONE_MS + 1)).toBe(`gone`);
        expect(appSilence(parked, heardAt, heardAt + 60 * 60_000)).toBe(`heard`);
    });

    // An older app says nothing while its card asks the reader something; that silence is the reader's, not the app's.
    it(`says nothing over a question on the app's card, a run that ended, or nothing heard`, () => {
        expect(appSilence({ state: `waiting`, percent: 2, waitingFor: `consent`, at: heardAt }, heardAt, heardAt + 10 * 60_000)).toBe(`heard`);
        expect(appSilence({ state: `failed`, percent: 40, at: heardAt }, heardAt, heardAt + 10 * 60_000)).toBe(`heard`);
        expect(appSilence(undefined, undefined, heardAt)).toBe(`heard`);
    });
});

describe(`a run the app still reports`, () => {
    it(`is one running or waiting that has not stopped heartbeating`, () => {
        expect(appRunLive(pulling, heardAt, heardAt + 30 * 60_000)).toBe(true);
        expect(appRunLive(beating, heardAt, heardAt + HEARTBEAT_QUIET_MS + 1)).toBe(true);
        expect(appRunLive({ state: `waiting`, percent: 10, waitingFor: `pcSetup`, at: heardAt }, heardAt, heardAt + 1)).toBe(true);
    });

    it(`is not one that stopped heartbeating, one that ended, or none`, () => {
        expect(appRunLive(beating, heardAt, heardAt + HEARTBEAT_GONE_MS + 1)).toBe(false);
        expect(appRunLive({ state: `failed`, percent: 40 }, heardAt, heardAt)).toBe(false);
        expect(appRunLive(undefined, undefined, heardAt)).toBe(false);
    });
});

describe(`the download, as figures`, () => {
    it(`reads the image in GB to one decimal, as the registry sizes it`, () => {
        expect(downloadFigures({ ...pulling, downloaded: 1_100_000_000, downloadTotal: 2_200_000_000 })).toEqual({ done: `1.1`, total: `2.2`, unit: `GB` });
    });

    it(`reads a download under a GB in whole MB`, () => {
        expect(downloadFigures({ ...pulling, downloaded: 120_400_000, downloadTotal: 443_000_000 })).toEqual({ done: `120`, total: `443`, unit: `MB` });
    });

    it(`never shows the count past the total, and says nothing without both`, () => {
        expect(downloadFigures({ ...pulling, downloaded: 2_300_000_000, downloadTotal: 2_200_000_000 })?.done).toBe(`2.2`);
        expect(downloadFigures({ ...pulling, downloaded: 5 })).toBeUndefined();
        expect(downloadFigures({ ...pulling, downloaded: 0, downloadTotal: 0 })).toBeUndefined();
    });

    it(`is told to the funnel in whole MB, and not at all where the app said nothing`, () => {
        expect(downloadMb({ ...pulling, downloaded: 1_149_600_000, downloadTotal: 2_200_000_000 })).toEqual({ downloadedMb: 1150, downloadTotalMb: 2200 });
        expect(downloadMb(pulling)).toEqual({});
        expect(downloadMb(undefined)).toEqual({});
    });

    it(`words the time left in minutes, under one as none, and leaves it to the app's own words without seconds`, () => {
        expect(minutesLeft({ ...pulling, remainingSeconds: 754 })).toBe(13);
        expect(minutesLeft({ ...pulling, remainingSeconds: 59 })).toBe(0);
        expect(minutesLeft({ ...pulling, remaining: `about 3 min left` })).toBeUndefined();
    });
});

describe(`a download too slow to wait for`, () => {
    it(`is one the app expects to take more than ten more minutes`, () => {
        expect(slowDownload({ ...beating, remainingSeconds: 601 }, heardAt, heardAt)).toBe(true);
        expect(slowDownload({ ...beating, remainingSeconds: 600 }, heardAt, heardAt + 60 * 60_000)).toBe(false);
    });

    it(`is, from an app that gives no estimate in seconds, one pulling for more than eight minutes`, () => {
        expect(slowDownload(beating, heardAt, heardAt + SLOW_DOWNLOAD_MS)).toBe(false);
        expect(slowDownload(beating, heardAt, heardAt + SLOW_DOWNLOAD_MS + 1)).toBe(true);
    });

    it(`is only ever the image's download, while the run is under way`, () => {
        expect(slowDownload({ ...beating, step: `installing-docker`, remainingSeconds: 2000 }, heardAt, heardAt)).toBe(false);
        expect(slowDownload({ ...beating, state: `failed`, remainingSeconds: 2000 }, heardAt, heardAt)).toBe(false);
        expect(slowDownload(undefined, heardAt, heardAt + 60 * 60_000)).toBe(false);
    });

    // An app from before the heartbeat ignores `intentic://setup-stop`: taking the offer there would leave its download going.
    it(`is never offered to an app that cannot be told to stop its download`, () => {
        expect(slowDownload({ ...pulling, remainingSeconds: 2000 }, heardAt, heardAt)).toBe(false);
        expect(slowDownload(pulling, heardAt, heardAt + 60 * 60_000)).toBe(false);
    });
});
