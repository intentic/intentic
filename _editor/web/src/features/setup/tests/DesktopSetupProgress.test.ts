// The app's install as /setup draws it. A user on the app's v1.331.0 (2026-10-12) watched this card say "no word from
// the app" twenty seconds into a download that was still going, and restart the app as it told him: the restart started
// a second install beside the first. What the card says over silence, a download and a parked setup is pinned here.
import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, reactive } from "vue";
import { IconStub } from "@intentic/ui/testing";
import type { DesktopSetupReport } from "../../../app/environments/desktop";

const track = jest.fn();
jest.mock(`../../../app/analytics`, () => ({ track, replaySessionId: () => undefined }));

const { default: DesktopSetupProgress } = await import(`../DesktopSetupProgress.vue`);

interface Shown {
    report: DesktopSetupReport;
    heardAt: number | undefined;
    stepSince?: number | undefined;
    hostedOffered?: boolean;
}

let app: App | undefined;
let el: HTMLElement | undefined;
const hosted = jest.fn();
const mount = async (shown: Shown): Promise<{ props: Shown; text: () => string; button: (label: string) => HTMLButtonElement | undefined }> => {
    el = document.createElement(`div`);
    document.body.append(el);
    const props = reactive(shown);
    app = createApp({ render: () => h(DesktopSetupProgress, { ...props, onHosted: hosted }) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    const root = el;
    return {
        props,
        text: () => root.textContent ?? ``,
        button: (label) => [...root.querySelectorAll(`button`)].find((entry) => entry.textContent?.includes(label)),
    };
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(`2026-10-12T13:38:52Z`));
    track.mockClear();
    hosted.mockClear();
});

afterEach(() => {
    app?.unmount();
    el?.remove();
    app = undefined;
    jest.useRealTimers();
});

const pulling: DesktopSetupReport = { name: `work`, state: `running`, percent: 53, step: `pulling-image`, position: `Step 4 of 10` };

describe(`an app that goes quiet`, () => {
    // The pull outran its estimate and only its "about N minutes" changed, once a minute: that is a working download.
    it(`says nothing for minutes from an app that reports only on a change, then asks to check the window, never to restart`, async () => {
        const { text } = await mount({ report: pulling, heardAt: Date.now() });
        await advanceTimersByTimeAsync(2 * 60_000);
        expect(text()).toContain(`Closing this panel didn't stop it.`);
        await advanceTimersByTimeAsync(61_000);
        expect(text()).toContain(`Still working: the app hasn't reported in a while. Check that the Intentic window is still open.`);
        await advanceTimersByTimeAsync(30 * 60_000);
        expect(text()).not.toContain(`no word from the app`);
        expect(text()).not.toContain(`open it again`);
        expect(text()).not.toContain(`picks up from where it was`);
    });

    it(`asks to check the window twenty seconds into an app's missed heartbeats, and says how to bring it back after a minute`, async () => {
        const { text } = await mount({ report: { ...pulling, at: Date.now() }, heardAt: Date.now() });
        await advanceTimersByTimeAsync(19_000);
        expect(text()).toContain(`Closing this panel didn't stop it.`);
        await advanceTimersByTimeAsync(2_000);
        expect(text()).toContain(`Still working: the app hasn't reported in a while.`);
        await advanceTimersByTimeAsync(40_000);
        expect(text()).toContain(`Installing work on this device: no word from the app for a while`);
        expect(text()).toContain(`It may have closed. Press "Show the setup" to bring its window back.`);
    });

    it(`takes a fresh heartbeat as an app that is fine again`, async () => {
        const { props, text } = await mount({ report: { ...pulling, at: Date.now() }, heardAt: Date.now() });
        await advanceTimersByTimeAsync(25_000);
        expect(text()).toContain(`Still working`);
        props.report = { ...pulling, at: Date.now() };
        props.heardAt = Date.now();
        await nextTick();
        expect(text()).not.toContain(`Still working`);
    });
});

describe(`the download`, () => {
    it(`shows how much of the image is in, and the time left in the page's own words`, async () => {
        const { text } = await mount({
            report: { ...pulling, at: Date.now(), downloaded: 1_100_000_000, downloadTotal: 2_200_000_000, remainingSeconds: 300, remaining: `about 5 min` },
            heardAt: Date.now(),
        });
        expect(text()).toContain(`Downloading the sandbox image: 1.1 of 2.2 GB`);
        expect(text()).toContain(`about 5 minutes left`);
    });

    it(`keeps the app's own words for the time left where it gave no seconds`, async () => {
        const { text } = await mount({ report: { ...pulling, remaining: `about 12 min left` }, heardAt: Date.now() });
        expect(text()).toContain(`about 12 min left`);
        expect(text()).not.toContain(`Downloading the sandbox image`);
    });
});

describe(`a download too slow to wait for`, () => {
    it(`offers a machine of ours, told once, and starts it on the press`, async () => {
        const { text, button } = await mount({ report: { ...pulling, at: Date.now(), remainingSeconds: 1500 }, heardAt: Date.now(), stepSince: Date.now(), hostedOffered: true });
        expect(text()).toContain(`This download is slow on your connection.`);
        // Said as it is: taking it stops this PC's download, which would end refused once a machine of ours holds the address.
        expect(text()).toContain(`Start on our servers instead: you'll be working in a minute or two. This stops the download on this PC.`);
        expect(text()).not.toContain(`keep downloading`);
        expect(track.mock.calls.filter(([event]) => event === `setup_slow_download_offered`)).toHaveLength(1);
        button(`Start on our servers`)?.click();
        expect(hosted).toHaveBeenCalledTimes(1);
    });

    it(`waits eight minutes into the pull where the app gives no estimate in seconds`, async () => {
        const { text } = await mount({ report: { ...pulling, at: Date.now() }, heardAt: Date.now(), stepSince: Date.now(), hostedOffered: true });
        await advanceTimersByTimeAsync(7 * 60_000);
        expect(text()).not.toContain(`This download is slow`);
        await advanceTimersByTimeAsync(61_000 + 1);
        expect(text()).toContain(`This download is slow`);
    });

    // An app from before the heartbeat ignores `intentic://setup-stop`, so the offer's "this stops the download" would be untrue.
    it(`offers nothing to an app that cannot be told to stop its download`, async () => {
        const { text } = await mount({ report: { ...pulling, remainingSeconds: 1500 }, heardAt: Date.now(), stepSince: Date.now(), hostedOffered: true });
        await advanceTimersByTimeAsync(9 * 60_000);
        expect(text()).not.toContain(`This download is slow`);
    });

    it(`offers nothing where no machine of ours can start now`, async () => {
        const { text } = await mount({ report: { ...pulling, remainingSeconds: 1500 }, heardAt: Date.now(), stepSince: Date.now(), hostedOffered: false });
        expect(text()).not.toContain(`This download is slow`);
    });
});

describe(`a setup parked behind this PC's own`, () => {
    it(`says the app is setting up the PC first, with no bar of its own`, async () => {
        const { text } = await mount({ report: { state: `waiting`, percent: 0, waitingFor: `pcSetup`, at: Date.now() }, heardAt: Date.now() });
        expect(text()).toContain(`Setting up this PC first`);
        expect(text()).toContain(`The app is setting up this PC first (Docker). Follow it in the Intentic window`);
        expect(text()).not.toContain(`0%`);
        expect(text()).not.toContain(`Waiting for your answer`);
    });
});
