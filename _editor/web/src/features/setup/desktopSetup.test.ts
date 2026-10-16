// DOM: the app's reports arrive as a window event.
import "@intentic/testing/dom";
import { freshImport, mocked } from "@intentic/testing/bun";

jest.mock("../../app/analytics", () => ({ track: jest.fn(), replaySessionId: () => undefined, noteTurnCompleted: jest.fn() }));

const load = async () => {
    const { track } = await import(`../../app/analytics`);
    const setup = await freshImport<typeof import("./desktopSetup")>("./desktopSetup", import.meta.url);
    return { track, ...setup.useDesktopSetup() };
};
const say = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(`intentic-desktop-setup`, { detail }));
};

beforeEach(() => {
    jest.clearAllMocks();
});

describe(`the app's setup, as this page hears it`, () => {
    // The restart is the next thing to do whether or not the app's card is still up: the page fell back to "Still
    // nothing" the moment it was put away, and the reader left.
    it(`keeps a restart the run stopped on after the app's card is put away, and drops it once the setup moves`, async () => {
        const { report, parked } = await load();
        say({ state: `waiting`, percent: 10, waitingFor: `restart`, requirements: [`pending-restart`] });
        expect(parked.value).toBe(`restart`);
        say({ state: `closed`, percent: 0 });
        expect(report.value).toBeUndefined();
        expect(parked.value).toBe(`restart`);
        say({ state: `running`, percent: 12 });
        expect(parked.value).toBeUndefined();
    });

    it(`does not park on a question the reader answers on the app's card`, async () => {
        const { parked } = await load();
        say({ state: `waiting`, percent: 2, waitingFor: `consent`, requirements: [`docker-desktop`] });
        expect(parked.value).toBeUndefined();
    });

    // The replay's timeline holds what the app's window said, once per change rather than once per tick.
    it(`tells the funnel each change of state once, not each tick of the bar`, async () => {
        const { track } = await load();
        say({ state: `running`, percent: 3, step: `installing-docker` });
        say({ state: `running`, percent: 4, step: `installing-docker` });
        say({ state: `waiting`, percent: 10, waitingFor: `signOut`, requirements: [`docker-users`] });
        // Every earlier test's fresh module still listens on the same window, so the calls are judged by kind, not count.
        const told = mocked(track)
            .mock.calls.filter(([event]) => event === `desktop_setup_report`)
            .map(([, properties]) => properties);
        expect(told).toContainEqual({ state: `running`, percent: 3, step: `installing-docker` });
        expect(told).toContainEqual({ state: `waiting`, percent: 10, waitingFor: `signOut`, requirements: [`docker-users`] });
        expect(told).not.toContainEqual({ state: `running`, percent: 4, step: `installing-docker` });
    });

    // A heartbeat re-sends the same report every few seconds: one event for the state, carrying the download in MB.
    it(`tells the funnel a download in MB, and nothing more for heartbeats that change nothing`, async () => {
        const { track } = await load();
        const beat = { state: `running`, percent: 53, step: `pulling-image`, downloaded: 1_100_000_000, downloadTotal: 2_200_000_000 };
        say({ state: `waiting`, percent: 0, waitingFor: `pcSetup`, at: 1 });
        say({ ...beat, at: 2 });
        say({ ...beat, at: 3, downloaded: 1_200_000_000 });
        say({ ...beat, at: 4, downloaded: 1_300_000_000 });
        const told = mocked(track)
            .mock.calls.filter(([event]) => event === `desktop_setup_report`)
            .map(([, properties]) => properties);
        expect(told).toContainEqual({ state: `waiting`, percent: 0, waitingFor: `pcSetup` });
        expect(told).toContainEqual({ state: `running`, percent: 53, step: `pulling-image`, downloadedMb: 1100, downloadTotalMb: 2200 });
        // Every earlier test's fresh module still listens too, so the beats that changed nothing are judged by kind.
        expect(told).not.toContainEqual({ state: `running`, percent: 53, step: `pulling-image`, downloadedMb: 1200, downloadTotalMb: 2200 });
        expect(told).not.toContainEqual({ state: `running`, percent: 53, step: `pulling-image`, downloadedMb: 1300, downloadTotalMb: 2200 });
    });

    // The handed-over setup is parked behind this PC's own: the page keeps saying so once the app's card is put away.
    it(`keeps a wait on this PC's own setup after the app's card is put away, and drops it once the setup moves`, async () => {
        const { report, pcSetup } = await load();
        say({ state: `waiting`, percent: 0, waitingFor: `pcSetup`, at: 1 });
        expect(pcSetup.value).toBe(true);
        say({ state: `closed`, percent: 0 });
        expect({ report: report.value, pcSetup: pcSetup.value }).toEqual({ report: undefined, pcSetup: true });
        say({ state: `running`, percent: 12, step: `pulling-image` });
        expect(pcSetup.value).toBe(false);
    });

    // How long the image download has run is dated by its step's first report, not by the reports after it.
    it(`dates a step from its first report, and again when the step changes`, async () => {
        jest.useFakeTimers();
        try {
            jest.setSystemTime(new Date(`2026-10-12T13:38:52Z`));
            const { stepSince } = await load();
            say({ state: `running`, percent: 30, step: `pulling-image` });
            const started = stepSince.value;
            jest.setSystemTime(new Date(`2026-10-12T13:45:00Z`));
            say({ state: `running`, percent: 53, step: `pulling-image` });
            say({ state: `closed`, percent: 0 });
            say({ state: `running`, percent: 53, step: `pulling-image` });
            expect(stepSince.value).toBe(started);
            say({ state: `running`, percent: 90, step: `starting-sandbox` });
            expect(stepSince.value).toBe(Date.parse(`2026-10-12T13:45:00Z`));
        } finally {
            jest.useRealTimers();
        }
    });
});

describe(`the slow download's way out, as the funnel hears it`, () => {
    it(`is told offered once a visit, and taken on each press, with the download's figures`, async () => {
        const { track } = await load();
        const { tellSlowDownloadHosted, tellSlowDownloadOffered } = await freshImport<typeof import("./desktopSetup")>("./desktopSetup", import.meta.url);
        const slow = { state: `running`, percent: 53, step: `pulling-image`, remainingSeconds: 900, downloaded: 400_000_000, downloadTotal: 2_200_000_000 } as const;
        tellSlowDownloadOffered(slow);
        tellSlowDownloadOffered(slow);
        tellSlowDownloadHosted(slow);
        const calls = mocked(track).mock.calls.filter(([event]) => event.startsWith(`setup_slow_download`));
        expect(calls).toEqual([
            [`setup_slow_download_offered`, { remainingSeconds: 900, downloadedMb: 400, downloadTotalMb: 2200 }],
            [`setup_slow_download_hosted`, { remainingSeconds: 900, downloadedMb: 400, downloadTotalMb: 2200 }],
        ]);
    });
});
