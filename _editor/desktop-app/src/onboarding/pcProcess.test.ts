import { pcProcessOf } from "./pcProcess";

// This PC's own setup as the process both faces draw (2026-10-26): its questions answered where the reader is.

describe(`this PC's own setup, as a process`, () => {
    it(`runs, and waits on the reader while Windows asks them`, () => {
        expect(pcProcessOf({ state: `running`, percent: 30, step: `wsl` }, true)).toMatchObject({ id: `pc-setup:this`, state: `running`, percent: 30 });
        expect(pcProcessOf({ state: `running`, percent: 30, needsYou: true }, true)).toMatchObject({ state: `waiting`, waitingFor: `answer` });
    });

    it(`asks a restart, a sign-out or a go-ahead as itself, with a machine of ours beside`, () => {
        expect(pcProcessOf({ state: `waiting`, for: `restart` }, true)?.actions).toEqual([`restart-now`, `restart-in-10`, `restart-later`, `use-hosted`]);
        expect(pcProcessOf({ state: `waiting`, for: `signOut` }, true)?.waitingFor).toBe(`signOut`);
        expect(pcProcessOf({ state: `waiting`, for: `admin` }, true)?.actions?.[0]).toBe(`consent`);
    });

    it(`says why it stopped, is done only where it was seen running, and is nothing at rest`, () => {
        expect(pcProcessOf({ state: `failed`, reason: `no virtualization` }, false)).toMatchObject({ state: `failed`, failure: `no virtualization` });
        expect(pcProcessOf({ state: `ready` }, true)?.state).toBe(`done`);
        expect(pcProcessOf({ state: `ready` }, false)).toBeUndefined();
        expect(pcProcessOf({ state: `idle` }, true)).toBeUndefined();
    });
});
