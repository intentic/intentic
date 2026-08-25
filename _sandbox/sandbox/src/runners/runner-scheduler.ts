import { type AgentHarness, type AgentProvider, capabilitiesOf, type RunnerFacts, type RunnerSummary } from "@intentic/sandbox-contract";

/* WHERE THE NEXT FAN-OUT AGENT SHOULD RUN (docs/remote-runners-plan.md §12 P4, at the workspace root).
 *
 * A person picks a placement for a conversation they are watching; nobody picks one thirty times for a
 * workflow that spreads over the codebase. So a SPAWNED child (children/children.ts: the agents a turn starts
 * for itself) is placed by this function instead, and the benefit of the whole feature stops depending on
 * anyone remembering to use it.
 *
 * THE RULE IS FREE SLOTS FIRST, THEN LOAD, and the order matters more than the metric: a machine already
 * running four agents and a machine running none can report the same one-minute load average, because that
 * average is a minute behind the thing it is measuring. Slots are what this daemon knows RIGHT NOW (it
 * dispatched every one of those turns), so they decide, and load only breaks ties between equals.
 *
 * FALLING BACK HERE IS NOT A FAILURE. With no runner free, the work runs in this sandbox exactly as it always
 * has: the caller's own ceilings (the owner's subagentsAtOnce, the local turn machinery) still bound it. That
 * is why this returns "where", never "wait": queueing is somebody else's job, and a scheduler that held work
 * for a laptop to wake up would be slower than the sandbox that was free all along. */

// How many agent turns one machine is asked to hold at once.
//
// TWO CEILINGS, whichever is lower. Cores, because a turn is mostly waiting on a model but spends its bursts
// compiling and running tests, and a machine with more agents than cores turns those bursts into contention.
// Memory, because the burst is the expensive half: a Node harness plus a build plus a test runner is the ~2 GB
// this divides by, and a 4-core box with 4 GB that took four agents would swap rather than work.
//
// The cores half deliberately mirrors the local rule the product already applies to fan-out (cores − 2, capped
// at 16): the reserve is the daemon itself and whatever the person is doing on that machine, and the cap is
// where more parallelism stops buying anything a model's own latency does not already give away.
const MEMORY_PER_AGENT_MB = 2_048;
export const runnerSlots = (facts: RunnerFacts): number =>
    Math.max(1, Math.min(16, facts.cpus - 2, Math.floor(facts.memoryMb / MEMORY_PER_AGENT_MB)));

/* CAN THIS AGENT'S CREDENTIAL GET THERE? The scheduler's other question, and the one that turns a helpful
 * placement into a broken child if nobody asks it.
 *
 * A runner spends the ORIGIN sandbox's model providers (§8), and what travels is what
 * `resolveHarnessCredentials` resolves: the Claude Code runtime's family — native Claude, codex/grok/kimi
 * ROUTED under that harness, endpoint capabilities, the trial. Every other runtime (native Codex's
 * app-server, opencode for Grok and Gemini, Cursor's SDK, an ACP agent, Pi) authenticates from a store on
 * the machine it runs on: a CLI's own home, with that provider's own login in it. Those stores are on THIS
 * box, and a fresh runner has none.
 *
 * So an automatic placement asks first. Sending a Cursor child to a machine that has never signed into
 * Cursor produces a child that dies on its first request with a sentence about a missing account, which
 * reads as the fleet being broken rather than as the credential never having been there. An EXPLICIT `on`
 * still wins: somebody who names a machine may well have signed in on it, and the feature should not argue
 * with a person who knows their own fleet. */
export const credentialsTravel = (provider: AgentProvider, harness: AgentHarness): boolean => capabilitiesOf(provider, harness).runtime === "claude-code";

export interface FleetPlacement {
    // The runner to place this agent on, or undefined for "this sandbox", which is the ordinary answer on a
    // sandbox with no runners and the fallback when every runner is full.
    readonly runner?: string | undefined;
    // Why, for the log line the dispatch writes. Not shown to anybody: a placement nobody chose should not
    // announce itself on a card, it should simply be the fastest place the work could have gone.
    readonly reason: "no-runners" | "all-busy" | "free-slot" | "asked-for" | "provider-is-local";
}

export interface FleetLoad {
    // How many turns this daemon currently has dispatched to each runner, by runner id. Derived from the
    // agent registry rather than counted here, so it cannot drift from what is actually running.
    readonly inFlight: ReadonlyMap<string, number>;
}

/* Pick a machine. `asked` is an explicit choice from the caller (a spec that named one, a person's placement
 * picker) and is honoured whenever that runner is usable, because a stated preference beats a measurement.
 *
 * A runner is USABLE when it is online and has told us what it is: a machine that has never connected has no
 * facts, so there is no honest way to size it, and guessing a slot count for one is how a four-core laptop
 * ends up holding sixteen agents. Parity is deliberately NOT a filter: an outdated runner runs turns (§7), and
 * refusing to schedule onto one would quietly halve somebody's fleet over a version they were never told
 * mattered. */
export const placeFanOut = (
    runners: readonly RunnerSummary[],
    load: FleetLoad,
    options: { readonly asked?: string | undefined; readonly travels?: boolean | undefined } = {},
): FleetPlacement => {
    const usable = runners.filter((runner) => runner.online && runner.facts !== undefined);
    if (options.asked !== undefined) {
        return usable.some((runner) => runner.id === options.asked) ? { runner: options.asked, reason: "asked-for" } : { reason: "all-busy" };
    }
    // Nothing to spread onto is checked first, so the ordinary sandbox's answer names the fleet it lacks
    // rather than a credential rule it has never met.
    if (usable.length === 0) {
        return { reason: "no-runners" };
    }
    if (options.travels === false) {
        return { reason: "provider-is-local" };
    }
    const free = usable
        .map((runner) => ({
            id: runner.id,
            // `facts` is present by the filter above; the assertion keeps the arithmetic honest without a cast
            // at every use.
            slots: runnerSlots(runner.facts as RunnerFacts) - (load.inFlight.get(runner.id) ?? 0),
            load: (runner.facts as RunnerFacts).load,
        }))
        .filter((runner) => runner.slots > 0);
    if (free.length === 0) {
        return { reason: "all-busy" };
    }
    /* Most free slots first, then least loaded, then by name. The last one is not decoration: without a total
     * order, two machines that tie churn their pick between calls, and a fan-out of eight ends up split by
     * whichever comparison the sort happened to make rather than evenly. */
    const best = free.toSorted((left, right) => right.slots - left.slots || left.load - right.load || left.id.localeCompare(right.id))[0];
    return best === undefined ? { reason: "all-busy" } : { runner: best.id, reason: "free-slot" };
};
