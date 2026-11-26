import type { FleetMachine, MachineLoad } from "@intentic/sandbox-contract/schemas/offload";
import type { RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { unstubbed } from "@intentic/testing";
import {
    type FleetReadDeps,
    fleetMachine,
    fleetPressure,
    machineLoad,
    measureHereForTest,
    readHere,
    readRunners,
    type RunnerReading,
    type SessionFit,
    shortOfMemory,
    suggestionFor,
} from "./fleet-advice.js";
import type { BudgetSnapshot } from "../workload/resource-budget.js";

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

    // 2026-11-24: omen took ten subagents while its C: drive filled, and Docker Desktop died with all of them on it.
    test("a disk without room for another agent's checkout and build is full; a little more than that is busy", () => {
        expect(machineLoad(idle({ freeDiskMb: 0 }), 0)).toMatchObject({ standing: "full", strain: ["disk"], diskFreeMb: 0 });
        expect(machineLoad(idle({ freeDiskMb: 8_000 }), 0)).toMatchObject({ standing: "full", strain: ["disk"] });
        expect(machineLoad(idle({ freeDiskMb: 20_000 }), 0)).toMatchObject({ standing: "busy", strain: ["disk"] });
        expect(machineLoad(idle({ freeDiskMb: 40_000 }), 0)).toMatchObject({ standing: "calm", diskFreeMb: 40_000 });
    });

    test("a disk-full runner is never suggested, however idle the rest of it reads", () => {
        const here = machineLoad(idle({ load: 1.0 }), 0);
        expect(suggestionFor("auto", here, machines(["omen", idle({ freeDiskMb: 0 })]))).toBeUndefined();
        expect(suggestionFor("auto", here, machines(["omen", idle({ freeDiskMb: 0 })], ["z440", idle()]))).toEqual({ runner: "z440", name: "z440" });
    });

    // Slots follow the memory the sandbox may use, not the machine's: a 4 GiB container on a 64 GiB box holds four.
    test("a container's memory limit sizes its slots, not the machine around it", () => {
        expect(machineLoad(idle({ cpus: 16, memoryMb: 65_536, memoryLimitMb: 4_096, memoryFreeMb: 3_500 }), 0).slots).toBe(4);
    });

    // A runner that predates the live figures still has a load and a size to be judged by.
    test("a runner that reports no memory figures is judged by what it does report", () => {
        const old: RunnerFacts = { cpus: 8, memoryMb: 32_768, freeDiskMb: 100_000, load: 0.2 };
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

// The reading every placement shares, with what this daemon placed a moment ago and no measurement shows yet.
describe("the fleet as one reading", () => {
    // What each device's agent last answered its heartbeat with, by hub door (a card, or `<card>::wsl:<distro>`).
    type Beats = Record<string, { readonly at: number; readonly answer: unknown }>;
    const deps = (runners: Record<string, RunnerFacts>, running = 0, beats: Beats = {}): FleetReadDeps =>
        unstubbed<FleetReadDeps>("fleet", {
            // SAFETY: the reading touches only a runner's `id` and `host` in the enrolment list.
            runners: unstubbed<FleetReadDeps["runners"]>("runners", { list: async () => Object.keys(runners).map((id) => ({ id, host: `${id}-pc` })) as never }),
            // SAFETY: the reading touches only `online` and `facts` of a runner's state.
            runnerHub: unstubbed<FleetReadDeps["runnerHub"]>("runnerHub", { refresh: async () => undefined, state: (id: string) => ({ online: true, facts: runners[id] }) as never }),
            // SAFETY: the reading touches only `pinged` of a device's state.
            hostHub: unstubbed<FleetReadDeps["hostHub"]>("hostHub", { state: (door: string) => ({ pinged: beats[door] }) as never }),
            conversations: unstubbed<FleetReadDeps["conversations"]>("conversations", { inFlightByRunner: () => new Map(), activeTurnCount: () => running }),
        });
    afterEach(() => measureHereForTest(undefined));

    // A fan-out's fourth child is placed before the first three register: without the book it reads an empty machine.
    test("counts children placed a moment ago as the agents and memory they are about to be", async () => {
        measureHereForTest(async () => idle());
        const pending = { here: 3, runners: new Map([["omen", 2]]) };
        expect(await readHere(deps({}, 1), pending)).toMatchObject({ agents: 4, memoryFreeMb: 28_000 - 3 * 1024 });
        const [omen] = await readRunners(deps({ omen: idle() }), { refresh: false, pending });
        expect(omen).toMatchObject({ name: "omen-pc", agents: 2, facts: { memoryFreeMb: 28_000 - 2 * 1024 } });
    });

    // Ten siblings placed in one burst would each read the same free disk; the book spends it as they go.
    test("counts children placed a moment ago against the disk they are about to fill", async () => {
        const pending = { here: 0, runners: new Map([["omen", 3]]) };
        const [omen] = await readRunners(deps({ omen: idle({ freeDiskMb: 30_000 }) }), { refresh: false, pending });
        expect(omen?.facts?.freeDiskMb).toBe(30_000 - 3 * 5 * 1024);
        expect(omen === undefined ? undefined : fleetMachine(omen, FITS).load).toMatchObject({ standing: "busy", strain: ["disk"] });
    });

    test("names the calm machines only while this sandbox is full", async () => {
        const fleet = deps({ omen: idle(), z440: idle({ load: 1 }) });
        measureHereForTest(async () => idle({ memoryFreeMb: 500 }));
        expect(await fleetPressure(fleet)).toEqual({ roomy: ["omen-pc"] });
        measureHereForTest(async () => idle({ load: 1 }));
        expect(await fleetPressure(fleet)).toBeUndefined();
        measureHereForTest(async () => idle({ memoryFreeMb: 500 }));
        expect(await fleetPressure(deps({ z440: idle({ load: 1 }) }))).toBeUndefined();
    });

    // 2026-11-23: omen's Windows had 0.3 to 3 GiB of its 31.6 available for four hours while its runner's container, in a
    // 26 GiB WSL VM shared with another sandbox's runner and the owner's CI, read as roomy; the machine froze and its
    // Docker engine died with five turns on it. The device's own heartbeat said so all along.
    const GIB = 1024 ** 3;
    const windows = (availableGib: number) => ({ at: Date.now() - 10_000, answer: { ok: true, memory: { availableBytes: availableGib * GIB, totalBytes: 31.6 * GIB } } });

    // The one runner a fleet of one reads as.
    const omenOf = async (fleet: FleetReadDeps): Promise<RunnerReading> => {
        const [omen] = await readRunners(fleet, { refresh: false });
        if (omen === undefined) {
            throw new Error("the fleet read no runner");
        }
        return omen;
    };

    test("a runner has no more free than its machine's own OS has above the line it thrashes under", async () => {
        const short = await omenOf(deps({ omen: idle() }, 0, { "omen-pc": windows(2.5) }));
        expect(short.facts?.memoryFreeMb).toBe(0);
        expect(fleetMachine(short, FITS).load).toMatchObject({ standing: "full", strain: ["memory"] });
        // 9 GiB available less the 3.16 GiB reserve a 31.6 GiB machine keeps: under the container's own 28 000 MiB.
        const roomy = await omenOf(deps({ omen: idle() }, 0, { "omen-pc": windows(9) }));
        expect(roomy.facts?.memoryFreeMb).toBe(Math.floor((9 - 3.16) * 1024));
        expect(fleetMachine(roomy, FITS).load?.standing).toBe("calm");
    });

    test("a full host is never suggested, nor named as having room, however idle its runner's container reads", async () => {
        const fleet = deps({ omen: idle() }, 0, { "omen-pc": windows(1.2) });
        measureHereForTest(async () => idle({ memoryFreeMb: 500 }));
        expect(await fleetPressure(fleet)).toBeUndefined();
        const readings = await readRunners(fleet, { refresh: false });
        expect(suggestionFor("auto", machineLoad(idle({ load: 0.95 }), 1), readings.map((entry) => fleetMachine(entry, FITS)))).toBeUndefined();
    });

    // A machine that stopped answering, or one whose agent predates the field, says nothing about now: no room is taken.
    test("a stale heartbeat or none at all leaves the runner's own reading as it was", async () => {
        const stale = { ...windows(0.5), at: Date.now() - 10 * 60_000 };
        expect((await omenOf(deps({ omen: idle() }, 0, { "omen-pc": stale }))).facts?.memoryFreeMb).toBe(28_000);
        expect((await omenOf(deps({ omen: idle() }))).facts?.memoryFreeMb).toBe(28_000);
    });
});

// What work nobody asked for gives way to (a dictation model loaded on a hover, an idle one kept): this sandbox's own
// budget reading, its host's room folded in, judged by the line its standing reads busy at.
describe("whether this sandbox is short of memory", () => {
    const GIB = 1024 ** 3;
    const budget = (snapshot: { readonly freeGib?: number; readonly stall?: number; readonly host?: { readonly availableGib: number } }) => ({
        snapshot: async (): Promise<BudgetSnapshot> => ({
            at: Date.now(),
            reading: {
                limitBytes: 16 * GIB,
                usedBytes: 16 * GIB - (snapshot.freeGib ?? 8) * GIB,
                swapBytes: 0,
                stallPercent: snapshot.stall ?? 0,
                oomKills: 0,
                host:
                    snapshot.host === undefined
                        ? undefined
                        : { name: "rog", availableBytes: snapshot.host.availableGib * GIB, totalBytes: 32 * GIB, reserveBytes: 3 * GIB },
            },
            reservedBytes: 0,
            freeBytes: (snapshot.freeGib ?? 8) * GIB,
            personNeedBytes: GIB,
            stallLimitPercent: 20,
            stallSustainedLimitPercent: 10,
        }),
    });

    test("reads short when memory is busy or full, or while memory stalls, and not with room", async () => {
        expect(await shortOfMemory(budget({ freeGib: 8 }))).toBe(false);
        expect(await shortOfMemory(budget({ freeGib: 0.5 }))).toBe(true);
        // Busy: room for a person's turn but for fewer than a few more agents, where a guessed model load tips it full.
        expect(await shortOfMemory(budget({ freeGib: 1.9 }))).toBe(true);
        expect(await shortOfMemory(budget({ freeGib: 8, stall: 25 }))).toBe(true);
    });

    // 2026-11-26: the owner's laptop, its Windows nearly out of memory, while the sandbox's own cgroup read as roomy.
    test("reads short when the host has no room above its reserve, however roomy the sandbox's own reading", async () => {
        expect(await shortOfMemory(budget({ freeGib: 8, host: { availableGib: 3.5 } }))).toBe(true);
        expect(await shortOfMemory(budget({ freeGib: 8, host: { availableGib: 12 } }))).toBe(false);
    });

    test("a budget that cannot be read is no shortage", async () => {
        expect(await shortOfMemory({ snapshot: () => Promise.reject(new Error("no cgroup here")) })).toBe(false);
    });
});
