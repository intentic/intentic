// DOM: the app's reports arrive as a window event.
import "@intentic/testing/dom";
import { freshImport, mocked } from "@intentic/testing/bun";

jest.mock("../../app/analytics", () => ({ track: jest.fn() }));

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
});
