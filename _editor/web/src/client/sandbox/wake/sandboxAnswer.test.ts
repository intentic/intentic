import type { HostReport } from "@intentic/api-contract";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { answerOf, isAsleep, sleepingOn, sleepOfSandbox } from "./sandboxAnswer";

// A sandbox its own computer had put to sleep was said to be "not answering" in warning ink in the Changes panel and
// the switcher, since both read only a hosted machine's state, which a sandbox on the owner's computer does not have.

const asleepReport: HostReport = {
    source: `agent`,
    machine: `omen`,
    os: `windows`,
    stage: `done`,
    outcome: `healthy`,
    checks: [],
    asleep: true,
    at: `2026-10-29T10:00:00.000Z`,
};
const own = sandboxSummary({ id: `own` });
const sleeping = sandboxSummary({ id: `own`, sleep: { heardAt: `2026-10-29T10:00:00.000Z`, wakeable: true } });
const offline = sandboxSummary({ id: `own`, sleep: { heardAt: `2026-10-29T08:00:00.000Z`, wakeable: false } });
const hosted = (state: `awake` | `asleep` | `starting`) => sandboxSummary({ id: `cloud`, hosted: { region: `iad`, warm: true, state } });

describe(`answerOf`, () => {
    it(`says asleep for a sandbox its own computer put to sleep, and for a hosted one asleep, read or not`, () => {
        for (const answered of [false, undefined]) {
            expect(answerOf(sleeping, answered)).toBe(`asleep`);
            expect(answerOf(hosted(`asleep`), answered)).toBe(`asleep`);
        }
    });

    it(`tells a sleeper whose computer is off from one that opening starts`, () => {
        expect(answerOf(offline, false)).toBe(`unwakeable`);
        expect(answerOf(offline, undefined)).toBe(`unwakeable`);
        expect([isAsleep(`asleep`), isAsleep(`unwakeable`), isAsleep(`not-answering`)]).toEqual([true, true, false]);
    });

    it(`takes an answer over anything the list says, since only the daemon proves it is up`, () => {
        expect(answerOf(sleeping, true)).toBe(`answering`);
        expect(answerOf(hosted(`asleep`), true)).toBe(`answering`);
    });

    it(`keeps "not answering" for a failed read with nothing saying it sleeps, and "starting" for a hosted boot`, () => {
        expect(answerOf(own, false)).toBe(`not-answering`);
        expect(answerOf(hosted(`awake`), false)).toBe(`not-answering`);
        expect(answerOf(hosted(`starting`), false)).toBe(`starting`);
        expect(answerOf(own, undefined)).toBe(`unknown`);
    });

    it(`falls back on the owner's host report where the platform is older than the sleep field`, () => {
        const older = sandboxSummary({ id: `own`, hostReport: asleepReport });
        expect(answerOf(older, false)).toBe(`asleep`);
        expect(sleepOfSandbox(older)).toEqual({ wakeable: true });
        // A newer platform's word wins over the report: awake is awake.
        expect(answerOf(sandboxSummary({ id: `own`, hostReport: asleepReport, sleep: null }), false)).toBe(`not-answering`);
        expect(sleepingOn(older)).toBe(`omen`);
    });
});
