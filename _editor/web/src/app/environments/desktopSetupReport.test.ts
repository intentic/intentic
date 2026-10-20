import { readDesktopSetupReport } from "./desktopSetupReport";

/* The app's progress announcement, read back off a detail that crossed a process boundary: the fields the strip draws survive. */
test("a setup report is read back with its figures and without anything unexpected", () => {
    expect(
        readDesktopSetupReport({
            name: `work`,
            state: `running`,
            percent: 42,
            position: `Step 4 of 10`,
            remaining: `about 3 min left`,
            step: `pulling-image`,
            extra: 1,
        }),
    ).toEqual({ name: `work`, state: `running`, percent: 42, position: `Step 4 of 10`, remaining: `about 3 min left`, step: `pulling-image` });
    // The optional fields are absent when empty, never empty strings the strip would draw as blanks.
    expect(readDesktopSetupReport({ state: `failed`, percent: 100, name: ``, position: null })).toEqual({ state: `failed`, percent: 100 });
    // A percentage is kept on the bar.
    expect(readDesktopSetupReport({ state: `running`, percent: 140 })?.percent).toBe(100);
});

/* A setup stopped on a question says which: a restart and a sign-out are worded as themselves, and ids only ride as ids. */
test("a waiting report keeps what it waits for and its requirement ids", () => {
    expect(
        readDesktopSetupReport({ state: `waiting`, percent: 10, waitingFor: `restart`, requirements: [`pending-restart`, `Not An Id!`, 3] }),
    ).toEqual({ state: `waiting`, percent: 10, waitingFor: `restart`, requirements: [`pending-restart`] });
    // An app too old to say, or one saying something this page has no words for, is a plain wait.
    expect(readDesktopSetupReport({ state: `waiting`, percent: 10, waitingFor: `reboot-twice` })).toEqual({ state: `waiting`, percent: 10 });
});

/* A heartbeat's clock, the image download's two counts and the estimate in seconds ride as numbers the page can reason with. */
test("a report keeps its clock, its download and its estimate in seconds, when each is a real amount", () => {
    expect(
        readDesktopSetupReport({
            state: `running`,
            percent: 53,
            step: `pulling-image`,
            at: 1_760_000_000_000,
            downloaded: 1_100_000_000,
            downloadTotal: 2_200_000_000,
            remainingSeconds: 0,
        }),
    ).toEqual({
        state: `running`,
        percent: 53,
        step: `pulling-image`,
        at: 1_760_000_000_000,
        downloaded: 1_100_000_000,
        downloadTotal: 2_200_000_000,
        remainingSeconds: 0,
    });
    // A negative, a NaN, an infinity or a string is no amount at all: dropped, not drawn as "-1 of NaN GB".
    const odd = readDesktopSetupReport({
        state: `running`,
        percent: 53,
        at: `now`,
        downloaded: -1,
        downloadTotal: Number.POSITIVE_INFINITY,
        remainingSeconds: Number.NaN,
    });
    expect([odd?.at, odd?.downloaded, odd?.downloadTotal, odd?.remainingSeconds]).toEqual([undefined, undefined, undefined, undefined]);
    // An app from before heartbeats says none of them, and its report reads as it always did.
    expect(readDesktopSetupReport({ state: `running`, percent: 53 })).toEqual({ state: `running`, percent: 53 });
});

/* The handed-over setup parked behind this PC's own setup is a wait of its own, worded as itself. */
test("a report waiting on this PC's own setup says so", () => {
    expect(readDesktopSetupReport({ state: `waiting`, percent: 0, waitingFor: `pcSetup`, at: 5 })).toEqual({
        state: `waiting`,
        percent: 0,
        waitingFor: `pcSetup`,
        at: 5,
    });
});

test("a report in a shape this page has no screen for is nothing", () => {
    expect(readDesktopSetupReport(undefined)).toBeUndefined();
    expect(readDesktopSetupReport(`running`)).toBeUndefined();
    expect(readDesktopSetupReport({ state: `exploding`, percent: 10 })).toBeUndefined();
    expect(readDesktopSetupReport({ state: `running`, percent: `10` })).toBeUndefined();
    expect(readDesktopSetupReport({ state: `running`, percent: Number.NaN })).toBeUndefined();
});
