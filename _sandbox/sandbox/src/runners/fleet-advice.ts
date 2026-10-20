import { COST_BYTES, PERSON_RESERVE_BYTES, STALL_PERCENT, STALL_SUSTAINED_PERCENT } from "@intentic/constants/memory-room";
import { type AgentHarness, type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type {
    FleetAdvice,
    FleetAdviceInput,
    FleetMachine,
    FleetUnfit,
    MachineLoad,
    MachineStanding,
    MachineStrain,
    SessionsPlacement,
} from "@intentic/sandbox-contract/schemas/offload";
import type { RunnerFacts } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { refreshRunnerFacts } from "./fleet-facts.js";
import { machineFacts } from "./machine-facts.js";
import { credentialsTravel, runnerSlots } from "./runner-scheduler.js";

// WHICH MACHINE A NEW SESSION SHOULD START ON (settings `offload.sessions`, GET /offload/placement). Every machine, this
// sandbox and each runner alike, is measured by one ruler (machine-facts.ts) and judged by one rule (`machineLoad`), so
// the composer's suggestion, the placement menu and an automatic placement read the same verdict. A runner is
// suggested only when this machine is busy, that one is strictly better off, and the session could actually start
// there: the turn would refuse otherwise (stream-agent.ts), and a suggestion that ends in a refusal is worse than none.

const MB = 1_048_576;
// What one more agent takes, the figure the turn door and the fan-out's slots reserve per agent.
const AGENT_MB = COST_BYTES.agentRuntime / MB;
// Below this free, a person's next turn is warned about memory (the turn door's attended need).
const PERSON_NEED_MB = PERSON_RESERVE_BYTES / MB;
// Room for fewer agents than this is busy: the next one fits, the one after may not.
const BUSY_AGENTS_OF_MEMORY = 3;
// Load averages over the cores (1 = every core busy) and CPU pressure (percent of ten seconds something waited for a
// CPU). Agents mostly wait on their model, so CPU says busy only once builds and tests are saturating it.
const CPU_BUSY_LOAD = 0.9;
const CPU_FULL_LOAD = 1.5;
const CPU_BUSY_PRESSURE = 40;
const CPU_FULL_PRESSURE = 80;
// The share of a machine's slots in use from which it reads busy.
const AGENTS_BUSY_SHARE = 0.75;

const RANK = { calm: 0, busy: 1, full: 2 } as const satisfies Readonly<Record<MachineStanding, number>>;

const round2 = (value: number): number => Math.round(value * 100) / 100;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// Strains that leave no room at all, and strains that only cost the agents already running; each list in the order a
// reader should hear them.
interface Strains {
    readonly full: MachineStrain[];
    readonly busy: MachineStrain[];
}

const strainsOf = (facts: RunnerFacts, agents: number, slots: number): Strains => {
    const full: MachineStrain[] = [];
    const busy: MachineStrain[] = [];
    const free = facts.memoryFreeMb;
    if (free !== undefined && free < PERSON_NEED_MB) {
        full.push("memory");
    } else if (free !== undefined && free < PERSON_NEED_MB + (BUSY_AGENTS_OF_MEMORY - 1) * AGENT_MB) {
        busy.push("memory");
    }
    const stall = facts.memoryStall ?? 0;
    if (stall >= STALL_PERCENT) {
        full.push("memory-stall");
    } else if (stall >= STALL_SUSTAINED_PERCENT) {
        busy.push("memory-stall");
    }
    const pressure = facts.cpuPressure ?? 0;
    if (facts.load >= CPU_FULL_LOAD || pressure >= CPU_FULL_PRESSURE) {
        full.push("cpu");
    } else if (facts.load >= CPU_BUSY_LOAD || pressure >= CPU_BUSY_PRESSURE) {
        busy.push("cpu");
    }
    if (agents >= slots) {
        full.push("agents");
    } else if (agents >= Math.ceil(slots * AGENTS_BUSY_SHARE)) {
        busy.push("agents");
    }
    return { full, busy };
};

// One machine's verdict from its facts and the conversations running there. Slots are sized by the memory its budget
// is limited to where it says, else the machine's, the same ceiling the fan-out scheduler places by.
export const machineLoad = (facts: RunnerFacts, agents: number): MachineLoad => {
    const slots = runnerSlots({ ...facts, memoryMb: facts.memoryLimitMb ?? facts.memoryMb });
    const { full, busy } = strainsOf(facts, agents, slots);
    const standing: MachineStanding = full.length > 0 ? "full" : busy.length > 0 ? "busy" : "calm";
    const slotRoom = Math.max(0, slots - agents) / slots;
    // Free memory in agents beyond a person's own reserve, against the slots, so a big idle machine reads as roomy.
    const memoryRoom = facts.memoryFreeMb === undefined ? 1 : Math.floor(Math.max(0, facts.memoryFreeMb - PERSON_NEED_MB) / AGENT_MB) / slots;
    const cpuRoom = 1 - Math.max(facts.load, (facts.cpuPressure ?? 0) / 100);
    return {
        standing,
        strain: [...full, ...busy.filter((strain) => !full.includes(strain))],
        cpus: facts.cpus,
        load: facts.load,
        ...opt("memoryFreeMb", facts.memoryFreeMb),
        ...opt("memoryLimitMb", facts.memoryLimitMb),
        agents,
        slots,
        headroom: round2(clamp01(Math.min(slotRoom, memoryRoom, cpuRoom))),
    };
};

// What decides whether a runner could take a new session at all, apart from how full it is.
export interface SessionFit {
    // The caller is limited to areas of the workspace, which a runner cannot fence (stream-agent.ts refuses it).
    readonly areas: boolean;
    // The privacy shield masks for this provider, and a runner would call it from past the shield.
    readonly shielded: boolean;
    // The draft's credential reaches a runner (the Claude Code runtime family only).
    readonly travels: boolean;
}

export interface RunnerReading {
    readonly id: string;
    readonly name: string;
    readonly online: boolean;
    readonly facts: RunnerFacts | undefined;
    readonly agents: number;
}

// Why a session could not start on this runner now, first reason first; undefined when it could.
const unfitOf = (runner: RunnerReading, fit: SessionFit): FleetUnfit | undefined => {
    if (!runner.online) {
        return "offline";
    }
    if (runner.facts === undefined) {
        return "unmeasured";
    }
    if (fit.areas) {
        return "areas";
    }
    if (fit.shielded) {
        return "privacy";
    }
    return fit.travels ? undefined : "credentials";
};

export const fleetMachine = (runner: RunnerReading, fit: SessionFit): FleetMachine => {
    const unfit = unfitOf(runner, fit);
    return {
        runner: runner.id,
        name: runner.name,
        online: runner.online,
        ...opt("load", runner.online && runner.facts !== undefined ? machineLoad(runner.facts, runner.agents) : undefined),
        ...opt("unfit", unfit),
    };
};

// The runner to start on instead of here: only while here is not calm, only one that could take the session, and only
// one strictly better off by standing and by headroom, so a suggestion never trades one busy machine for another. The
// best standing wins, then the most headroom, then the quieter CPU, then the name, a total order so equal machines do
// not swap places between two reads.
export const suggestionFor = (
    mode: SessionsPlacement,
    here: MachineLoad,
    machines: readonly FleetMachine[],
): FleetAdvice["suggestion"] => {
    if (mode === "off" || here.standing === "calm") {
        return undefined;
    }
    const best = machines
        .flatMap((machine) => (machine.unfit === undefined && machine.load !== undefined ? [{ machine, load: machine.load }] : []))
        .filter(({ load }) => RANK[load.standing] < RANK[here.standing] && load.headroom > here.headroom)
        .toSorted(
            (left, right) =>
                RANK[left.load.standing] - RANK[right.load.standing] ||
                right.load.headroom - left.load.headroom ||
                left.load.load - right.load.load ||
                left.machine.name.localeCompare(right.machine.name),
        )[0];
    return best === undefined ? undefined : { runner: best.machine.runner, name: best.machine.name };
};

export type FleetAdviceDeps = Pick<Services, "runners" | "runnerHub" | "conversations" | "resources" | "privacyShield" | "sandboxSettings" | "workspace">;

// Whether the shield keeps a session with this provider here: it would refuse it on a runner, as stream-agent.ts does.
const shieldHolds = async (deps: Pick<Services, "privacyShield">, provider: AgentProvider, conversationId: string | undefined): Promise<boolean> =>
    (await deps.privacyShield.refusal({ provider, conversationId, route: "runner" })) !== undefined;

const fitOf = async (
    deps: FleetAdviceDeps,
    session: { readonly agent: AgentProvider; readonly harness: AgentHarness; readonly conversationId?: string | undefined },
    areas: readonly string[] | undefined,
): Promise<SessionFit> => ({
    areas: areas !== undefined,
    shielded: await shieldHolds(deps, session.agent, session.conversationId),
    travels: credentialsTravel(session.agent, session.harness),
});

// Every enrolled runner as the hub knows it after a refresh, the word the owner knows its machine by, and the
// conversations running a turn on it.
const readRunners = async (deps: FleetAdviceDeps, inFlight: ReadonlyMap<string, number>): Promise<RunnerReading[]> => {
    const enrolled = await deps.runners.list();
    await refreshRunnerFacts(
        deps.runnerHub,
        enrolled.map((runner) => runner.id),
    );
    return enrolled.map((runner) => {
        const state = deps.runnerHub.state(runner.id);
        return { id: runner.id, name: runner.host ?? runner.id, online: state.online, facts: state.facts, agents: inFlight.get(runner.id) ?? 0 };
    });
};

// The advice for one draft. `areas` is the caller's own limit (auth/principal.ts areasOf).
export const fleetAdvice = async (deps: FleetAdviceDeps, input: FleetAdviceInput, areas: readonly string[] | undefined): Promise<FleetAdvice> => {
    const session = withRuntimeDefaults(input);
    const inFlight = deps.conversations.inFlightByRunner();
    const elsewhere = [...inFlight.values()].reduce((sum, count) => sum + count, 0);
    const [settings, hereFacts, runners, fit] = await Promise.all([
        deps.sandboxSettings.get(),
        machineFacts(deps.workspace.root, { budget: deps.resources }),
        readRunners(deps, inFlight),
        fitOf(deps, session, areas),
    ]);
    const mode = settings.offload.sessions;
    // Every registered turn runs from here; the ones dispatched to a runner run there, so they count there instead.
    const here = machineLoad(hereFacts, Math.max(0, deps.conversations.activeTurnCount() - elsewhere));
    const machines = runners.map((runner) => fleetMachine(runner, fit));
    return { mode, here, machines, ...opt("suggestion", suggestionFor(mode, here, machines)) };
};
