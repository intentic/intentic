// What an update that takes itself says on the card and in the lane, and which of the owner's answers apply. Instants
// are built on the runner's own calendar, since "04:00 tomorrow" is read off the reader's clock.
import type { AutoUpdate } from "@intentic/sandbox-contract";
import { autoUpdateNotice, autoUpdateStatus, countdownClock, holdLine, notTodayUntil } from "./autoUpdate";

const NOW = new Date(2026, 9, 4, 16, 30).getTime();
const ME = [`Ada Lovelace`, `ada@example.com`];

const waiting = (over: Partial<AutoUpdate> = {}): AutoUpdate => ({ enabled: true, phase: `waiting`, version: `1.5.0`, holds: [], ...over });

describe(`what it is waiting for, in words that read as consideration`, () => {
    it(`names the agents it will not interrupt`, () => {
        expect(holdLine({ kind: `agents`, names: [`LEDGERLY`] }, ME, NOW).text).toBe(`LEDGERLY is working`);
        expect(holdLine({ kind: `agents`, names: [`LEDGERLY`, `ORCHESTRATOR`] }, ME, NOW).text).toBe(`LEDGERLY and ORCHESTRATOR are working`);
        expect(holdLine({ kind: `agents`, names: [`LEDGERLY`, `ORCHESTRATOR`, `SCOUT`] }, ME, NOW).text).toBe(`LEDGERLY and 2 more are working`);
    });

    it(`says "you" for the reader at the editor, whichever way the daemon named them`, () => {
        expect(holdLine({ kind: `people`, names: [`Ada Lovelace`] }, ME, NOW).text).toBe(`You're using the editor`);
        expect(holdLine({ kind: `people`, names: [`ADA@example.com`, `Grace`] }, ME, NOW).text).toBe(`You and 1 more are using the editor`);
        expect(holdLine({ kind: `people`, names: [`Grace`] }, ME, NOW).text).toBe(`Grace is using the editor`);
        expect(holdLine({ kind: `people`, names: [`Grace`, `Linus`, `Ken`] }, ME, NOW).text).toBe(`Grace and 2 more are using the editor`);
    });

    it(`tells a moment on the reader's clock, and still says something true of a reason it does not know`, () => {
        const retry = new Date(2026, 9, 4, 18, 0).getTime();
        expect(holdLine({ kind: `retry`, until: retry }, ME, NOW).text).toBe(`Trying again at 18:00 today`);
        expect(holdLine({ kind: `schedule`, until: retry }, ME, NOW).text).toBe(`Something scheduled runs at 18:00 today`);
        expect(holdLine({ kind: `a-newer-reason` }, ME, NOW)).toEqual({ kind: `a-newer-reason`, icon: `clock`, text: `Something is still going on` });
    });
});

describe(`where it stands, beside the update button`, () => {
    it(`says nothing while turned off: the switch already does`, () => {
        expect(autoUpdateStatus({ auto: waiting({ enabled: false }), downloading: false, me: ME, now: NOW })).toBeUndefined();
        expect(autoUpdateStatus({ auto: undefined, downloading: true, me: ME, now: NOW })).toBeUndefined();
    });

    it(`waiting: the promise, what it waits for, and "not today"`, () => {
        const status = autoUpdateStatus({
            auto: waiting({ holds: [{ kind: `agents`, names: [`LEDGERLY`] }, { kind: `people`, names: [`Ada Lovelace`] }] }),
            downloading: false,
            me: ME,
            now: NOW,
        });
        expect(status).toMatchObject({ title: `Installs by itself at a quiet moment`, answer: `not-today` });
        expect(status?.lines.map((line) => line.text)).toEqual([`LEDGERLY is working`, `You're using the editor`]);
    });

    it(`counting down: the time left, and "not now"`, () => {
        const status = autoUpdateStatus({ auto: waiting({ phase: `countdown`, startsAt: NOW + 75_000 }), downloading: false, me: ME, now: NOW });
        expect(status).toMatchObject({ title: `Restarting to update in 1:15`, answer: `not-now`, lines: [] });
    });

    it(`paused: until when, and "resume now", whatever else holds it`, () => {
        const until = new Date(2026, 9, 5, 4, 0).getTime();
        const status = autoUpdateStatus({ auto: waiting({ pausedUntil: until, holds: [{ kind: `paused`, until }] }), downloading: false, me: ME, now: NOW });
        expect(status).toMatchObject({ tone: `paused`, title: `Automatic updates resume 04:00 tomorrow`, answer: `resume` });
    });

    it(`a release that changes what developers build on waits for the owner, and offers no pause`, () => {
        const status = autoUpdateStatus({ auto: waiting({ holds: [{ kind: `consent` }, { kind: `agents`, names: [`LEDGERLY`] }] }), downloading: false, me: ME, now: NOW });
        expect(status).toMatchObject({ tone: `consent`, title: `This update waits for you`, answer: undefined, lines: [] });
    });

    it(`says the last try's words while it waits to try again`, () => {
        const status = autoUpdateStatus({ auto: waiting({ failure: `Not enough free disk space.`, holds: [{ kind: `retry`, until: NOW + 60_000 }] }), downloading: false, me: ME, now: NOW });
        expect(status?.failure).toBe(`Not enough free disk space.`);
    });

    it(`still downloading: one line promising it installs itself once it is in`, () => {
        const status = autoUpdateStatus({ auto: { enabled: true, phase: `idle`, holds: [] }, downloading: true, me: ME, now: NOW });
        expect(status).toMatchObject({ title: `Once it has downloaded, it installs by itself at a quiet moment.`, detail: undefined, lines: [], answer: undefined });
        expect(autoUpdateStatus({ auto: { enabled: true, phase: `idle`, holds: [] }, downloading: false, me: ME, now: NOW })).toBeUndefined();
    });
});

describe(`the lane's card`, () => {
    it(`speaks only for a countdown or the restart itself`, () => {
        expect(autoUpdateNotice(waiting(), NOW)).toBeUndefined();
        expect(autoUpdateNotice(waiting({ phase: `countdown`, startsAt: NOW + 9_000 }), NOW)).toMatchObject({ title: `Restarting to update in 0:09`, counting: true });
        expect(autoUpdateNotice(waiting({ phase: `updating` }), NOW)).toMatchObject({ title: `Updating to 1.5.0`, spin: true, counting: false });
        expect(autoUpdateNotice(waiting({ phase: `countdown`, startsAt: NOW + 9_000, enabled: false }), NOW)).toBeUndefined();
    });
});

describe(`the clocks`, () => {
    it(`counts down in minutes and seconds, never below zero`, () => {
        expect(countdownClock(NOW + 90_000, NOW)).toBe(`1:30`);
        expect(countdownClock(NOW + 6_500, NOW)).toBe(`0:07`);
        expect(countdownClock(NOW - 5_000, NOW)).toBe(`0:00`);
    });

    it(`"not today" is the next 04:00 at least four hours off: tonight in the evening, the night after past midnight`, () => {
        expect(notTodayUntil(NOW)).toBe(new Date(2026, 9, 5, 4, 0).getTime());
        expect(notTodayUntil(new Date(2026, 9, 5, 1, 0).getTime())).toBe(new Date(2026, 9, 6, 4, 0).getTime());
    });
});
