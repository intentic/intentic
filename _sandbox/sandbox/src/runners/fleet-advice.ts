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
    SessionsPlacement,FleetPressure
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
// The same reading and the same rule place a spawned child nobody placed (child-placement.ts) and a heavy command sent
// to "any machine with room" (`roomierRunner`), so a session, a subagent and a test run never disagree about which
// machine has room.

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

// Work this daemon has already sent somewhere that no measurement shows yet: a child placed a moment ago whose turn has
// not registered. Counted as the agent it is about to be and the memory it is about to hold, so a burst of siblings placed
// one after another does not read the same empty machine each time (child-placement-live.ts keeps the book).
export interface PendingWork {
    readonly here: number;
    readonly runners: ReadonlyMap<string, number>;
}

const NOTHING_PENDING: PendingWork = { here: 0, runners: new Map() };

const lessPending = (facts: RunnerFacts, pending: number): RunnerFacts =>
    pending === 0 || facts.memoryFreeMb === undefined ? facts : { ...facts, memoryFreeMb: Math.max(0, facts.memoryFreeMb - pending * AGENT_MB) };

export type FleetReadDeps = Pick<Services, "runners" | "runnerHub" | "conversations" | "resources" | "workspace">;

// This machine, by the ruler every runner is measured with. Swapped in tests: the load of the box a suite happens to run
// on says nothing about the case under test.
const realHere = async (deps: Pick<Services, "workspace" | "resources">): Promise<RunnerFacts> =>
    await machineFacts(deps.workspace.root, { budget: deps.resources });
let measureHere = realHere;
export const measureHereForTest = (fake: ((deps: Pick<Services, "workspace" | "resources">) => Promise<RunnerFacts>) | undefined): void => {
    measureHere = fake ?? realHere;
};

/** How full this sandbox is: every registered turn runs from here, except the ones dispatched to a runner. */
export const readHere = async (deps: FleetReadDeps, pending: PendingWork = NOTHING_PENDING): Promise<MachineLoad> => {
    const elsewhere = [...deps.conversations.inFlightByRunner().values()].reduce((sum, count) => sum + count, 0);
    const facts = await measureHere(deps);
    return machineLoad(lessPending(facts, pending.here), Math.max(0, deps.conversations.activeTurnCount() - elsewhere) + pending.here);
};

/**
 * Every enrolled runner as the hub knows it, the word the owner knows its machine by, and the conversations running a
 * turn on it. `refresh` asks each one again first (at most once per FACTS_FRESH_MS, and never longer than its timeout);
 * without it the last answer stands, for a reader that must not wait on the fleet.
 */
export const readRunners = async (deps: FleetReadDeps, options: { readonly refresh: boolean; readonly pending?: PendingWork }): Promise<RunnerReading[]> => {
    const enrolled = await deps.runners.list();
    if (options.refresh) {
        await refreshRunnerFacts(
            deps.runnerHub,
            enrolled.map((runner) => runner.id),
        );
    }
    const inFlight = deps.conversations.inFlightByRunner();
    const pending = options.pending ?? NOTHING_PENDING;
    return enrolled.map((runner) => {
        const state = deps.runnerHub.state(runner.id);
        const waiting = pending.runners.get(runner.id) ?? 0;
        return {
            id: runner.id,
            name: runner.host ?? runner.id,
            online: state.online,
            facts: state.facts === undefined ? undefined : lessPending(state.facts, waiting),
            agents: (inFlight.get(runner.id) ?? 0) + waiting,
        };
    });
};

// A heavy command carries no model and no sign-in, so nothing but a machine's room decides whether it may go there.
const COMMAND_FIT: SessionFit = { areas: false, shielded: false, travels: true };

/**
 * The runner a heavy command should run on instead of here (settings `offload.commands` set to "any machine with room"):
 * none while this machine is calm, so a quiet sandbox never pays for a snapshot and a round trip, and otherwise the
 * runner the session advice would suggest, strictly better off by standing and by headroom.
 */
export const roomierRunner = async (deps: FleetReadDeps): Promise<{ readonly runner: string; readonly name: string } | undefined> => {
    const here = await readHere(deps);
    if (here.standing === "calm") {
        return undefined;
    }
    const runners = await readRunners(deps, { refresh: true });
    return suggestionFor("auto", here, runners.map((runner) => fleetMachine(runner, COMMAND_FIT)));
};

/**
 * The machines with room while this sandbox is full, by the word the owner knows each by: what a turn is told so that
 * work it can send elsewhere goes there (agent/prompt/guidance.ts `fleet`). Undefined while this sandbox is anything
 * but full, or no runner is calm. Read off the last answers the runners gave, so a turn never waits on the fleet.
 */
export const fleetPressure = async (deps: FleetReadDeps): Promise<FleetPressure | undefined> => {
    const here = await readHere(deps);
    if (here.standing !== "full") {
        return undefined;
    }
    const roomy = (await readRunners(deps, { refresh: false }))
        .filter((runner) => runner.online && runner.facts !== undefined && machineLoad(runner.facts, runner.agents).standing === "calm")
        .map((runner) => runner.name);
    return roomy.length === 0 ? undefined : { roomy };
};

// The advice for one draft. `areas` is the caller's own limit (auth/principal.ts areasOf).
export const fleetAdvice = async (deps: FleetAdviceDeps, input: FleetAdviceInput, areas: readonly string[] | undefined): Promise<FleetAdvice> => {
    const session = withRuntimeDefaults(input);
    const [settings, here, runners, fit] = await Promise.all([
        deps.sandboxSettings.get(),
        readHere(deps),
        readRunners(deps, { refresh: true }),
        fitOf(deps, session, areas),
    ]);
    const mode = settings.offload.sessions;
    const machines = runners.map((runner) => fleetMachine(runner, fit));
    return { mode, here, machines, ...opt("suggestion", suggestionFor(mode, here, machines)) };
};
