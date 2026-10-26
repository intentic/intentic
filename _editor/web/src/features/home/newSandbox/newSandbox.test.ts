import { markReady, newSandboxNote, newSandboxPhase, newSandboxShownBy, readySandboxes, seenReady, type NewSandboxFacts } from "./newSandbox";

const facts = (overrides: Partial<NewSandboxFacts> = {}): NewSandboxFacts => ({
    pressed: true,
    opening: false,
    started: `here`,
    refused: false,
    machineFailed: false,
    hostedFailed: false,
    report: undefined,
    ...overrides,
});

describe(`the new sandbox's address`, () => {
    it(`is Home asking for it, and nothing else`, () => {
        expect(newSandboxShownBy({ name: `home`, query: { add: `sandbox` } })).toBe(true);
        expect(newSandboxShownBy({ name: `home`, query: {} })).toBe(false);
        expect(newSandboxShownBy({ name: `home`, query: { show: `models` } })).toBe(false);
        // The workspace taking the same query is the shell's to send to Home, not Home showing it.
        expect(newSandboxShownBy({ name: `agents`, query: { add: `sandbox` } })).toBe(false);
    });
});

describe(`where the new sandbox stands`, () => {
    it(`is a draft until Create, whatever else is said`, () => {
        expect(newSandboxPhase(facts({ pressed: false, refused: true }))).toBe(`draft`);
    });

    it(`runs from the press, through the app's install and this PC's own setup coming first`, () => {
        expect(newSandboxPhase(facts({ started: undefined }))).toBe(`running`);
        expect(newSandboxPhase(facts({ report: { state: `running`, percent: 40 } }))).toBe(`running`);
        expect(newSandboxPhase(facts({ report: { state: `waiting`, percent: 0, waitingFor: `pcSetup` } }))).toBe(`running`);
    });

    it(`asks when the app waits on the reader: a consent, a restart, a sign-out`, () => {
        for (const waitingFor of [`consent`, `restart`, `signOut`] as const) {
            expect(newSandboxPhase(facts({ report: { state: `waiting`, percent: 30, waitingFor } }))).toBe(`asking`);
        }
    });

    it(`has failed on a refusal, a failed machine run, a machine of ours that could not start, or an app run that stopped`, () => {
        expect(newSandboxPhase(facts({ started: undefined, refused: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ started: `machine`, machineFailed: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ started: `hosted`, hostedFailed: true }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ report: { state: `failed`, percent: 60 } }))).toBe(`failed`);
        expect(newSandboxPhase(facts({ report: { state: `stopped`, percent: 60 } }))).toBe(`failed`);
    });

    it(`reads a failure only off the run that was started`, () => {
        expect(newSandboxPhase(facts({ started: `hosted`, machineFailed: true }))).toBe(`running`);
        expect(newSandboxPhase(facts({ started: `machine`, report: { state: `failed`, percent: 0 } }))).toBe(`running`);
    });

    it(`is opening once it reported in, ahead of anything its run said before`, () => {
        expect(newSandboxPhase(facts({ opening: true, report: { state: `failed`, percent: 100 } }))).toBe(`opening`);
    });
});

describe(`the tile's line`, () => {
    it(`says the app's percent while it gives one, and only then`, () => {
        expect(newSandboxNote(`running`, facts({ report: { state: `running`, percent: 41.6 } }))).toBe(`Setting up · 42%`);
        expect(newSandboxNote(`running`, facts({ report: { state: `running`, percent: 0 } }))).toBe(`Setting up…`);
        expect(newSandboxNote(`running`, facts({ started: `hosted` }))).toBe(`Setting up…`);
        expect(newSandboxNote(`draft`, facts())).toBe(`Not created yet`);
        expect(newSandboxNote(`asking`, facts())).toBe(`Needs your answer`);
        expect(newSandboxNote(`failed`, facts({ started: undefined }))).toBe(`Could not be created`);
        expect(newSandboxNote(`failed`, facts({ started: `machine` }))).toBe(`Stopped before it was ready`);
    });
});

describe(`a sandbox made ready while its reader was elsewhere`, () => {
    it(`is marked until it is opened`, () => {
        markReady(`sbx-1`);
        markReady(`sbx-2`);
        seenReady(`sbx-1`);
        expect([...readySandboxes.value]).toEqual([`sbx-2`]);
        seenReady(`sbx-2`);
        expect(readySandboxes.value.size).toBe(0);
    });
});
