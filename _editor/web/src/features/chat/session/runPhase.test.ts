import { accepted, advance, IDLE, type RunPhase } from "./runPhase";

// Pins every move one run can make in this window, and every event a phase refuses, as values: a send opens it, the
// daemon's ack takes it, an attach adopts a run already taken, and settling says whether the daemon ever had it.

const controller = new AbortController();
const live = (kind: `composing` | `sending`): RunPhase => ({ kind, controller, startedAt: 4_000 });
// Taken by the daemon, under the name its ack gave it.
const running = (run = `r1`): RunPhase => ({ kind: `running`, controller, startedAt: 4_000, run });

describe(`a run's phase`, () => {
    it(`opens idle into sending, or into composing for an errand whose words are not written yet`, () => {
        expect(advance(IDLE, { kind: `open`, composing: false, controller, startedAt: 4_000 })).toEqual(live(`sending`));
        expect(advance(IDLE, { kind: `open`, composing: true, controller, startedAt: 4_000 })).toEqual(live(`composing`));
    });

    it(`sends composed words, and is taken only from sending`, () => {
        expect(advance(live(`composing`), { kind: `composed` })).toEqual(live(`sending`));
        expect(advance(live(`sending`), { kind: `accepted`, run: `r1` })).toEqual(running(`r1`));
        // Words still being written were never handed to the daemon, so nothing it says can have taken them.
        expect(advance(live(`composing`), { kind: `accepted`, run: `r1` })).toEqual(live(`composing`));
    });

    it(`adopts an attached run as already taken, from idle alone`, () => {
        const other = new AbortController();
        expect(advance(IDLE, { kind: `attached`, controller: other, startedAt: 9_000, run: `r7` })).toEqual({
            kind: `running`,
            controller: other,
            startedAt: 9_000,
            run: `r7`,
        });
        // A send that opened first owns the stream; the probe's run is not adopted over it.
        expect(advance(live(`sending`), { kind: `attached`, controller: other, startedAt: 9_000, run: `r7` })).toEqual(live(`sending`));
    });

    it(`settles into idle remembering whether the daemon took the run`, () => {
        expect(advance(running(), { kind: `settled` })).toEqual({ kind: `idle`, accepted: true });
        expect(advance(live(`sending`), { kind: `settled` })).toEqual({ kind: `idle`, accepted: false });
        expect(advance(live(`composing`), { kind: `settled` })).toEqual({ kind: `idle`, accepted: false });
        const settled: RunPhase = { kind: `idle`, accepted: true };
        expect(advance(settled, { kind: `settled` })).toBe(settled);
    });

    it(`opens nothing beside a live run, and a late ack after settling changes nothing`, () => {
        expect(advance(running(), { kind: `open`, composing: false, controller: new AbortController(), startedAt: 9_000 })).toEqual(running());
        expect(advance(IDLE, { kind: `accepted`, run: `r1` })).toBe(IDLE);
        expect(advance(IDLE, { kind: `composed` })).toBe(IDLE);
    });

    it(`reads as accepted while running and once a taken run settled, and at no other point`, () => {
        expect([IDLE, live(`composing`), live(`sending`), running(), { kind: `idle`, accepted: true } as const].map(accepted)).toEqual([
            false,
            false,
            false,
            true,
            true,
        ]);
    });
});
