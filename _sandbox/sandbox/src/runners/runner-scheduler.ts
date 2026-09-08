import { type AgentHarness, type AgentProvider, capabilitiesOf, type RunnerFacts, type RunnerSummary } from "@intentic/sandbox-contract";

// Where a spawned fan-out child runs, since nobody manually places one thirty times per workflow. Free slots decide
// first, load only breaks ties: a load average lags a minute behind what this daemon already knows it dispatched.
// Falling back here is not a failure; queueing is somebody else's job, and the caller's own ceilings still bound it.

// Two ceilings, whichever is lower: cores minus 2 (capped at 16, the local fan-out rule) and memory / 2GB.
const MEMORY_PER_AGENT_MB = 2_048;
export const runnerSlots = (facts: RunnerFacts): number =>
    Math.max(1, Math.min(16, facts.cpus - 2, Math.floor(facts.memoryMb / MEMORY_PER_AGENT_MB)));

// Whether an agent's credential can reach the runner. Only the Claude Code runtime family travels; every other runtime
// needs its own login already on that machine, which a fresh runner lacks.
export const credentialsTravel = (provider: AgentProvider, harness: AgentHarness): boolean => capabilitiesOf(provider, harness).runtime === "claude-code";

export interface FleetPlacement {
    // Undefined means this sandbox: the ordinary answer with no runners, or the fallback when all are full.
    readonly runner?: string | undefined;
    // For the dispatch's log line only; a placement nobody chose should not announce itself elsewhere.
    readonly reason: "no-runners" | "all-busy" | "free-slot" | "asked-for" | "provider-is-local";
}

export interface FleetLoad {
    // Derived from the agent registry, not counted here, so it can't drift from what is actually running.
    readonly inFlight: ReadonlyMap<string, number>;
}

// An explicit `asked` wins whenever usable: a stated preference beats a measurement. Usable means online with known
// facts; parity is deliberately not a filter, since an outdated runner still runs turns.
export const placeFanOut = (
    runners: readonly RunnerSummary[],
    load: FleetLoad,
    options: { readonly asked?: string | undefined; readonly travels?: boolean | undefined } = {},
): FleetPlacement => {
    const usable = runners.filter((runner) => runner.online && runner.facts !== undefined);
    if (options.asked !== undefined) {
        return usable.some((runner) => runner.id === options.asked) ? { runner: options.asked, reason: "asked-for" } : { reason: "all-busy" };
    }
    // Checked first, so a fleetless sandbox names the fleet it lacks rather than a credential rule it never met.
    if (usable.length === 0) {
        return { reason: "no-runners" };
    }
    if (options.travels === false) {
        return { reason: "provider-is-local" };
    }
    const free = usable
        .map((runner) => ({
            id: runner.id,
            // `facts` is present by the filter above; asserted once here instead of cast at every later use.
            slots: runnerSlots(runner.facts as RunnerFacts) - (load.inFlight.get(runner.id) ?? 0),
            load: (runner.facts as RunnerFacts).load,
        }))
        .filter((runner) => runner.slots > 0);
    if (free.length === 0) {
        return { reason: "all-busy" };
    }
    // The name tiebreak isn't decoration: without a total order, tied machines churn their pick between calls.
    const best = free.toSorted((left, right) => right.slots - left.slots || left.load - right.load || left.id.localeCompare(right.id))[0];
    return best === undefined ? { reason: "all-busy" } : { runner: best.id, reason: "free-slot" };
};
