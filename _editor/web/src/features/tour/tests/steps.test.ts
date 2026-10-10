import { type Choices, offered, progress, type StepFacts, stepOrder } from "../steps";

// Pins the getting-started checklist's order and rules: a step is done by the sandbox's own facts, never by a press;
// nothing is current until every fact is in; a passed-over step counts as settled; and the list is never offered once
// work has landed, so a long-standing owner never meets a beginner's list.

const facts = (overrides: Partial<StepFacts> = {}): StepFacts => ({
    work: false,
    agent: false,
    models: false,
    land: false,
    runnable: true,
    ...overrides,
});
const NONE: Choices = { hidden: false, skipped: [] };

describe(`which step is next`, () => {
    it(`starts with bringing work in, and walks agent, models, land in that order`, () => {
        expect(progress(facts(), NONE).current).toBe(`work`);
        expect(progress(facts({ work: true }), NONE).current).toBe(`agent`);
        expect(progress(facts({ work: true, agent: true }), NONE).current).toBe(`models`);
        expect(progress(facts({ work: true, agent: true, models: true }), NONE).current).toBe(`land`);
    });

    it(`names nothing as next until every fact has been heard`, () => {
        const pending = progress(facts({ agent: undefined }), NONE);
        expect(pending.current).toBeUndefined();
        expect(pending.known).toBe(false);
        expect(pending.rows.map((row) => row.state)).not.toContain(`current`);
        expect(progress(facts({ runnable: undefined }), NONE).current).toBeUndefined();
    });

    it(`puts connecting a model first when nothing at all can run, not even the trial`, () => {
        expect(stepOrder(facts({ runnable: false }))).toEqual([`models`, `work`, `agent`, `land`]);
        expect(progress(facts({ runnable: false }), NONE).current).toBe(`models`);
        // Once a model of one's own is in, the usual order stands again.
        expect(stepOrder(facts({ runnable: false, models: true }))).toEqual([`work`, `agent`, `models`, `land`]);
    });

    it(`points at the land ahead of the model once an agent's work is waiting`, () => {
        const waiting = facts({ work: true, agent: true, ready: true });
        expect(stepOrder(waiting)).toEqual([`work`, `agent`, `land`, `models`]);
        expect(progress(waiting, NONE).current).toBe(`land`);
        // After the land the model is what is left.
        expect(progress(facts({ work: true, agent: true, ready: true, land: true }), NONE).current).toBe(`models`);
    });

    it(`moves past a step the reader passed over, and counts it as settled`, () => {
        const scratch = progress(facts(), { hidden: false, skipped: [`work`] });
        expect(scratch.current).toBe(`agent`);
        expect(scratch.rows[0]).toEqual({ id: `work`, state: `skipped` });
        expect(scratch.settled).toBe(1);
    });

    it(`never lets the loop itself be passed over`, () => {
        expect(progress(facts({ work: true }), { hidden: false, skipped: [`agent`, `land`] }).current).toBe(`agent`);
    });

    it(`calls a step done once the sandbox says so, even one passed over before`, () => {
        const done = progress(facts({ work: true }), { hidden: false, skipped: [`work`] });
        expect(done.rows[0]).toEqual({ id: `work`, state: `done` });
        expect(done.settled).toBe(1);
        expect(done.total).toBe(4);
    });
});

describe(`who is offered the checklist`, () => {
    it(`is offered to a maintainer on a first run once every fact is in`, () => {
        expect(offered(facts(), NONE, true)).toBe(true);
        expect(offered(facts({ work: undefined }), NONE, true)).toBe(false);
    });

    it(`is never offered to someone who could not finish it`, () => {
        expect(offered(facts(), NONE, false)).toBe(false);
    });

    it(`stays away once put away, and once work has landed, whatever else is unticked`, () => {
        expect(offered(facts(), { hidden: true, skipped: [] }, true)).toBe(false);
        expect(offered(facts({ land: true }), NONE, true)).toBe(false);
    });

    it(`stays away from a sandbox past its first days, where work done in place never landed`, () => {
        expect(offered(facts({ work: true, agent: true, established: true }), NONE, true)).toBe(false);
    });
});
