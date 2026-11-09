import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { RunnerSummary } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { loopsOf, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../composition.js";
import { type ChildFleet, type ChildPlacementAsk, type ChildPlacementVerdict, type ChildWeight, placeChild, roomContested } from "../../runners/child-placement.js";
import { fleetMachine, type PendingWork, readHere, readRunners } from "../../runners/fleet-advice.js";
import { freshRunnerSummaries } from "../../runners/runner-peer.js";
import { credentialsTravel } from "../../runners/runner-scheduler.js";
import type { ChildSpawnSpec } from "./children.js";
import { childRouting } from "./child-spec.js";
import { sizeChild } from "../models/subagent-sizing.js";

/* The live half of a child's placement: the facts runners/child-placement.ts judges, read off this sandbox (its runners,
   the privacy shield, which harness the child runs in, how full each machine is), and the book of children placed a
   moment ago. A fan-out spawns its children within a second of each other, faster than any measurement moves: placed
   one at a time against that book, the fourth child of a burst sees the three before it, here or on a runner, as the
   agents and the memory they are about to be. */

// Long enough for a placed child's turn to register (after which the registry counts it), short enough that a child
// that never started stops holding room nobody uses.
const PENDING_FOR_MS = 60_000;

// Children placed and not yet seen running, by id: where each went (a runner's id, undefined for here) and when.
const placed = new Map<string, { readonly runner: string | undefined; readonly at: number }>();

const pendingWork = (services: Pick<Services, "conversations">, now: number): PendingWork => {
    let here = 0;
    const runners = new Map<string, number>();
    for (const [id, entry] of placed) {
        if (now - entry.at > PENDING_FOR_MS || services.conversations.running(id)) {
            placed.delete(id);
        } else if (entry.runner === undefined) {
            here += 1;
        } else {
            runners.set(entry.runner, (runners.get(entry.runner) ?? 0) + 1);
        }
    }
    return { here, runners };
};

// One placement at a time, so two siblings never read the book before either has written to it.
let line: Promise<unknown> = Promise.resolve();
const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(work);
    // allow(silent-catch): the failure is the caller's to see on `next`; the line only has to keep moving.
    line = next.catch(() => undefined);
    return next;
};

export const resetChildPlacementForTest = (): void => {
    placed.clear();
    line = Promise.resolve();
};

// Whether the privacy shield keeps a child on this provider here: it would refuse it on a runner, as it refuses its
// parent there (stream-agent.ts). A fresh child has no conversation of its own a grant could name.
const shieldHoldsHere = async (services: Pick<Services, "privacyShield">, provider: AgentProvider): Promise<boolean> =>
    (await services.privacyShield.refusal({ provider, route: "runner" })) !== undefined;

const askOf = async (services: Services, spec: ChildSpawnSpec): Promise<ChildPlacementAsk> => {
    const { provider, harness } = childRouting(spec);
    return {
        on: spec.on,
        providerLabel: providerLabel(provider),
        travels: credentialsTravel(provider, harness),
        claudeCodeLoop: loopsOf(provider).includes("claude-code"),
        shieldHolds: await shieldHoldsHere(services, provider),
    };
};

// Every machine a child nobody placed could go to, or undefined when it could only run here anyway: a provider that
// cannot leave, or no runner online to leave for. The runners were just refreshed by freshRunnerSummaries.
const childFleet = async (services: Services, ask: ChildPlacementAsk, runners: readonly RunnerSummary[]): Promise<ChildFleet | undefined> => {
    if (ask.shieldHolds || !ask.travels || !runners.some((runner) => runner.online)) {
        return undefined;
    }
    const pending = pendingWork(services, Date.now());
    const [here, readings] = await Promise.all([readHere(services, pending), readRunners(services, { refresh: false, pending })]);
    // The shield and the credential were judged above, for the child as a whole.
    return { here, machines: readings.map((reading) => fleetMachine(reading, { areas: false, shielded: false, travels: true })) };
};

/** Why a spawn cannot run where it asked, said before it takes a seat; undefined when it can (always, when unplaced). */
export const childPlacementRefusal = async (services: Services, spec: ChildSpawnSpec): Promise<string | undefined> => {
    if (spec.on === undefined || spec.on === "here") {
        return undefined;
    }
    const verdict = placeChild(await askOf(services, spec), await freshRunnerSummaries(services), undefined);
    return verdict.kind === "refused" ? verdict.message : undefined;
};

/**
 * Where a child that is starting now goes, written into the book so its siblings see it. Its weight is asked of the
 * sizing helper only when the room it would take is contested, outside the line, so a slow answer holds no sibling.
 */
export const placeStartingChild = async (services: Services, spec: ChildSpawnSpec, child: { readonly id: string; readonly parent: string }): Promise<ChildPlacementVerdict> => {
    const ask = await askOf(services, spec);
    if (ask.on !== undefined) {
        // A machine the parent named is not the fleet's to weigh; it is checked again here, since a runner may have gone.
        return placeChild(ask, await freshRunnerSummaries(services), undefined);
    }
    let weight: ChildWeight | undefined;
    for (;;) {
        const sized = weight;
        const verdict = await oneAtATime(async () => {
            const runners = await freshRunnerSummaries(services);
            const fleet = await childFleet(services, ask, runners);
            const weighed = { ...ask, weight: sized };
            if (sized === undefined && roomContested(weighed, fleet)) {
                return undefined;
            }
            const decided = placeChild(weighed, runners, fleet);
            if (decided.kind !== "refused") {
                placed.set(child.id, { runner: decided.kind === "runner" ? decided.runner : undefined, at: Date.now() });
            }
            return decided;
        });
        if (verdict !== undefined) {
            return verdict;
        }
        weight = await sizeChild(services, spec, child.parent);
    }
};
