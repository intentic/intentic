import type { FleetMachine, MachineLoad, RunnerFacts } from "@intentic/sandbox-contract";
import { fleetMachine, machineLoad, type RunnerReading, type SessionFit, suggestionFor } from "./fleet-advice.js";

// Which machine a new session should start on. The verdicts are read by a person deciding where their work goes, so
// each case is a moment they would recognise: a box filling up, a quiet machine across the room, a suggestion that
// would only have traded one busy machine for another.

// An eight-core, 32 GiB machine with nothing running: six slots, plenty of memory, quiet CPUs.
const idle = (overrides: Partial<RunnerFacts> = {}): RunnerFacts => ({
    cpus: 8,
    memoryMb: 32_768,
    freeDiskMb: 100_000,
    load: 0.1,
    memoryFreeMb: 28_000,
    memoryLimitMb: 32_768,
    cpuPressure: 2,
    memoryStall: 0,
    ...overrides,
});

const FITS: SessionFit = { areas: false, shielded: false, travels: true };

const reading = (id: string, facts: RunnerFacts | undefined, overrides: Partial<RunnerReading> = {}): RunnerReading => ({
    id,
    name: id,
    online: true,
    facts,
    agents: 0,
    ...overrides,
});

const machines = (...entries: readonly [string, RunnerFacts, number?][]): FleetMachine[] =>
    entries.map(([id, facts, agents]) => fleetMachine(reading(id, facts, { agents: agents ?? 0 }), FITS));

describe("how full a machine is", () => {
    test("an idle machine is calm, with all its room", () => {
        const load = machineLoad(idle(), 0);
        expect(load).toMatchObject({ standing: "calm", strain: [], slots: 6, agents: 0 });
        expect(load.headroom).toBeGreaterThan(0.8);
    });

    // The turn door warns a person below an agent's gibibyte: the advice must call that full, not merely busy.
    test("memory a person's next turn would be warned about is full; a little more than that is busy", () => {
        expect(machineLoad(idle({ memoryFreeMb: 900 }), 1)).toMatchObject({ standing: "full", strain: ["memory"] });
        expect(machineLoad(idle({ memoryFreeMb: 2_500 }), 1)).toMatchObject({ standing: "busy", strain: ["memory"] });
        expect(machineLoad(idle({ memoryFreeMb: 3_100 }), 1).standing).toBe("calm");
    });

    test("memory stalling counts even with bytes free, at the turn door's own thresholds", () => {
        expect(machineLoad(idle({ memoryStall: 25 }), 0)).toMatchObject({ standing: "full", strain: ["memory-stall"] });
        expect(machineLoad(idle({ memoryStall: 12 }), 0)).toMatchObject({ standing: "busy", strain: ["memory-stall"] });
    });

    // Agents mostly wait on their model: CPU reads busy only once something is really saturating the cores.
    test("saturated CPUs are busy, far past saturated is full, by load or by pressure", () => {
        expect(machineLoad(idle({ load: 0.95 }), 0)).toMatchObject({ standing: "busy", strain: ["cpu"] });
        expect(machineLoad(idle({ cpuPressure: 45 }), 0)).toMatchObject({ standing: "busy", strain: ["cpu"] });
        expect(machineLoad(idle({ load: 1.6 }), 0)).toMatchObject({ standing: "full", strain: ["cpu"] });
        expect(machineLoad(idle({ load: 0.6, cpuPressure: 20 }), 0).standing).toBe("calm");
    });

    test("every slot taken is full; three quarters of them is busy", () => {
        expect(machineLoad(idle(), 6)).toMatchObject({ standing: "full", strain: ["agents"] });
        expect(machineLoad(idle(), 5)).toMatchObject({ standing: "busy", strain: ["agents"] });
        expect(machineLoad(idle(), 4).standing).toBe("calm");
    });

    test("names the strains that leave no room before the ones that only slow things down", () => {
        expect(machineLoad(idle({ memoryFreeMb: 500, load: 1.0 }), 5).strain).toEqual(["memory", "cpu", "agents"]);
    });

    // Slots follow the memory the sandbox may use, not the machine's: a 4 GiB container on a 64 GiB box holds four.
    test("a container's memory limit sizes its slots, not the machine around it", () => {
        expect(machineLoad(idle({ cpus: 16, memoryMb: 65_536, memoryLimitMb: 4_096, memoryFreeMb: 3_500 }), 0).slots).toBe(4);
    });

    // A runner that predates the live figures still has a load and a size to be judged by.
    test("a runner that reports no memory figures is judged by what it does report", () => {
        const old: RunnerFacts = { cpus: 8, memoryMb: 32_768, freeDiskMb: 0, load: 0.2 };
        expect(machineLoad(old, 1)).toMatchObject({ standing: "calm", slots: 6 });
    });
});

describe("whether a session could start on a runner", () => {
    test("asleep, never measured, area-limited, shielded, a credential that stays home: each says why, first reason first", () => {
        const facts = idle();
        expect(fleetMachine(reading("omen", facts, { online: false }), FITS)).toMatchObject({ unfit: "offline" });
        expect(fleetMachine(reading("omen", facts, { online: false }), FITS).load).toBeUndefined();
        expect(fleetMachine(reading("omen", undefined), FITS)).toMatchObject({ unfit: "unmeasured" });
        expect(fleetMachine(reading("omen", facts), { ...FITS, areas: true })).toMatchObject({ unfit: "areas" });
        expect(fleetMachine(reading("omen", facts), { ...FITS, shielded: true })).toMatchObject({ unfit: "privacy" });
        expect(fleetMachine(reading("omen", facts), { ...FITS, travels: false })).toMatchObject({ unfit: "credentials" });
        expect(fleetMachine(reading("omen", facts), { areas: true, shielded: true, travels: false }).unfit).toBe("areas");
    });

    test("a fit runner carries its load and no reason", () => {
        const machine = fleetMachine(reading("omen", idle(), { name: "omen-pc", agents: 2 }), FITS);
        expect(machine).toMatchObject({ runner: "omen", name: "omen-pc", online: true, load: { agents: 2, standing: "calm" } });
        expect(machine.unfit).toBeUndefined();
    });
});

describe("which machine a new session is pointed at", () => {
    const busyHere: MachineLoad = machineLoad(idle({ load: 0.95 }), 3);
    const fullHere: MachineLoad = machineLoad(idle({ memoryFreeMb: 600 }), 3);

    test("nothing while this machine is calm, however idle the others are", () => {
        expect(suggestionFor("suggest", machineLoad(idle(), 1), machines(["omen", idle()]))).toBeUndefined();
    });

    test("nothing when the owner switched it off", () => {
        expect(suggestionFor("off", busyHere, machines(["omen", idle()]))).toBeUndefined();
    });

    test("a calm runner while this one is busy, in both suggest and auto", () => {
        expect(suggestionFor("suggest", busyHere, machines(["omen", idle()]))).toEqual({ runner: "omen", name: "omen" });
        expect(suggestionFor("auto", busyHere, machines(["omen", idle()]))).toEqual({ runner: "omen", name: "omen" });
    });

    // Moving work from one busy machine to another busy one costs the person a slower session for nothing.
    test("never trades one busy machine for another", () => {
        expect(suggestionFor("suggest", busyHere, machines(["omen", idle({ load: 0.92 })]))).toBeUndefined();
    });

    test("a busy runner is still better than a full machine here", () => {
        expect(suggestionFor("suggest", fullHere, machines(["omen", idle({ load: 0.92 })]))).toEqual({ runner: "omen", name: "omen" });
    });

    test("skips a runner the session could not start on, however roomy", () => {
        const asleep = fleetMachine(reading("omen", idle(), { online: false }), FITS);
        const shielded = fleetMachine(reading("rig", idle()), { ...FITS, shielded: true });
        expect(suggestionFor("suggest", busyHere, [asleep, shielded])).toBeUndefined();
    });

    test("the calmest, roomiest machine wins, and equals are ordered by name so the pick holds still", () => {
        const fleet = machines(["zeta", idle()], ["crowded", idle(), 3], ["alpha", idle()]);
        expect(suggestionFor("suggest", busyHere, fleet)?.runner).toBe("alpha");
        expect(suggestionFor("suggest", busyHere, machines(["quiet", idle({ load: 0.05 })], ["noisy", idle({ load: 0.5 })]))?.runner).toBe("quiet");
    });
});
