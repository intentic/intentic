// Pins what the composer does with the fleet advice for a new chat (settings `offload.sessions`): which machine the strip
// offers, when an automatic placement moves the draft, and that neither one hops between machines or overrules a person.
import type { FleetAdvice, FleetMachine, MachineLoad } from "@intentic/sandbox-contract";
import { autoPlacement, offeredMachine } from "./fleetPlacement";
import { loadLine, movedLine, strainWords, suggestLine, unfitWords } from "./fleetWords";

const load = (overrides: Partial<MachineLoad> = {}): MachineLoad => ({
    standing: `calm`,
    strain: [],
    cpus: 8,
    load: 0.1,
    memoryFreeMb: 20_000,
    memoryLimitMb: 32_768,
    agents: 0,
    slots: 6,
    headroom: 0.9,
    ...overrides,
});

const BUSY_HERE = load({ standing: `busy`, strain: [`cpu`], load: 0.95, agents: 4, headroom: 0.05 });

const machine = (runner: string, overrides: Partial<FleetMachine> = {}): FleetMachine => ({
    runner,
    name: runner,
    online: true,
    load: load(),
    ...overrides,
});

const advice = (overrides: Partial<FleetAdvice> = {}): FleetAdvice => ({
    mode: `suggest`,
    here: BUSY_HERE,
    machines: [machine(`omen`)],
    suggestion: { runner: `omen`, name: `omen` },
    ...overrides,
});

describe(`what the strip offers`, () => {
    test(`the suggested machine while this one is busy`, () => {
        expect(offeredMachine(advice(), undefined)?.runner).toBe(`omen`);
    });

    test(`nothing while this machine is calm, nor when the owner switched it off`, () => {
        expect(offeredMachine(advice({ here: load(), suggestion: undefined }), `omen`)).toBeUndefined();
        expect(offeredMachine(advice({ mode: `off` }), undefined)).toBeUndefined();
    });

    // The daemon's order can flip between two equals from one read to the next; the line on screen must not.
    test(`keeps offering the machine it already offered while that one is still a good answer`, () => {
        const both = advice({ machines: [machine(`omen`), machine(`rig`)], suggestion: { runner: `rig`, name: `rig` } });
        expect(offeredMachine(both, `omen`)?.runner).toBe(`omen`);
    });

    test(`moves on once the machine it offered fell asleep or filled up`, () => {
        const asleep = advice({ machines: [machine(`omen`, { online: false, unfit: `offline` }), machine(`rig`)], suggestion: { runner: `rig`, name: `rig` } });
        expect(offeredMachine(asleep, `omen`)?.runner).toBe(`rig`);
        const filled = advice({
            machines: [machine(`omen`, { load: load({ standing: `full`, strain: [`memory`] }) }), machine(`rig`)],
            suggestion: { runner: `rig`, name: `rig` },
        });
        expect(offeredMachine(filled, `omen`)?.runner).toBe(`rig`);
    });
});

describe(`an automatic placement`, () => {
    const AUTO = advice({ mode: `auto` });

    test(`moves an untouched draft to the suggested machine, only in auto`, () => {
        expect(autoPlacement(AUTO, { by: undefined, dismissed: false, runner: undefined })).toEqual({ runner: `omen` });
        expect(autoPlacement(advice(), { by: undefined, dismissed: false, runner: undefined })).toBeUndefined();
    });

    test(`never overrules the person: a pick of theirs, a press of Keep it here, or a tab that was already placed`, () => {
        expect(autoPlacement(AUTO, { by: `person`, dismissed: false, runner: undefined })).toBeUndefined();
        expect(autoPlacement(AUTO, { by: undefined, dismissed: true, runner: undefined })).toBeUndefined();
        expect(autoPlacement(AUTO, { by: undefined, dismissed: false, runner: `rig` })).toBeUndefined();
    });

    // A draft that bounced back here each time this machine dipped under a threshold would read as the app changing its mind.
    test(`stays where it put a draft while that machine is no worse off than here, even once here calms down`, () => {
        const calmNow = advice({ mode: `auto`, here: load(), suggestion: undefined });
        expect(autoPlacement(calmNow, { by: `fleet`, dismissed: false, runner: `omen` })).toBeUndefined();
    });

    test(`follows a better machine, or comes back here, once the one it chose is no longer a good answer`, () => {
        const omenAsleep = advice({
            mode: `auto`,
            machines: [machine(`omen`, { online: false, unfit: `offline` }), machine(`rig`)],
            suggestion: { runner: `rig`, name: `rig` },
        });
        expect(autoPlacement(omenAsleep, { by: `fleet`, dismissed: false, runner: `omen` })).toEqual({ runner: `rig` });
        const nowhere = advice({ mode: `auto`, machines: [machine(`omen`, { online: false, unfit: `offline` })], suggestion: undefined });
        expect(autoPlacement(nowhere, { by: `fleet`, dismissed: false, runner: `omen` })).toEqual({ runner: undefined });
    });
});

describe(`the words`, () => {
    test(`say why this machine is busy, strongest reason first, with its figure`, () => {
        expect(strainWords(load())).toBeUndefined();
        expect(strainWords(BUSY_HERE)).toBe(`its CPUs are saturated`);
        expect(strainWords(load({ standing: `full`, strain: [`memory`, `agents`], memoryFreeMb: 512, agents: 6 }))).toBe(
            `only 512 MB of memory free and 6 agents running`,
        );
    });

    test(`offer the machine, or say the draft already moved there`, () => {
        expect(suggestLine(BUSY_HERE, `omen`)).toBe(`This machine is busy: its CPUs are saturated. omen has room for this session.`);
        expect(movedLine(BUSY_HERE, `omen`)).toBe(`Starting on omen: this machine is busy (its CPUs are saturated).`);
    });

    test(`describe a machine in the placement menu, and why a runner cannot take this chat`, () => {
        expect(loadLine(load({ agents: 1 }))).toBe(`Has room · 1 of 6 agent slots used · 20 GB free`);
        expect(unfitWords(`credentials`)).toBe(`This model signs in from here only; a Claude Code model can run there`);
    });
});
