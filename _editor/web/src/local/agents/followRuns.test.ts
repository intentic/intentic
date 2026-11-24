import { endedShort, runsOf } from "./followRuns";

describe(`the runs an open chat follows off the roster`, () => {
    it(`reads the same while nothing starts or ends, whatever else a card says`, () => {
        expect(runsOf([{ id: `a`, run: `run-1` }, { id: `b` }])).toBe(runsOf([{ id: `a`, run: `run-1` }, { id: `b`, run: undefined }]));
    });

    it(`changes when a conversation's turn starts, ends, or gives way to the next`, () => {
        const idle = runsOf([{ id: `a` }]);
        const first = runsOf([{ id: `a`, run: `run-1` }]);
        const next = runsOf([{ id: `a`, run: `run-2` }]);
        expect(new Set([idle, first, next]).size).toBe(3);
    });
});

describe(`a turn that leaves the record worth reading again`, () => {
    it(`is one the reader stopped or one that failed, never one that ran to its own end`, () => {
        expect([
            endedShort({ stopped: true, failed: false }),
            endedShort({ stopped: false, failed: true }),
            endedShort({ stopped: false, failed: false }),
        ]).toEqual([true, true, false]);
    });
});
