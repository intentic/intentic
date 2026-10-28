import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { loopsOf, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import type { Services } from "../../composition.js";
import { type ChildPlacementVerdict, placeChild } from "../../runners/child-placement.js";
import { freshRunnerSummaries } from "../../runners/runner-peer.js";
import { credentialsTravel } from "../../runners/runner-scheduler.js";
import type { ChildSpawnSpec } from "./children.js";
import { childRouting } from "./child-spec.js";

// The live half of a child's placement: the facts runners/child-placement.ts judges, read off this sandbox (its runners,
// the privacy shield, which harness the child runs in).
// Whether the privacy shield keeps a child on this provider here: it would refuse it on a runner, as it refuses its
// parent there (stream-agent.ts). A fresh child has no conversation of its own a grant could name.
const shieldHoldsHere = async (services: Pick<Services, "privacyShield">, provider: AgentProvider): Promise<boolean> =>
    (await services.privacyShield.refusal({ provider, route: "runner" })) !== undefined;

/** Where a spawn's child goes, read live: asked of a spawn before it takes a seat, and again as it starts. */
export const childPlacement = async (services: Services, spec: ChildSpawnSpec): Promise<ChildPlacementVerdict> => {
    if (spec.on === "here") {
        return { kind: "here" };
    }
    const { provider, harness } = childRouting(spec);
    return placeChild(
        {
            on: spec.on,
            providerLabel: providerLabel(provider),
            travels: credentialsTravel(provider, harness),
            claudeCodeLoop: loopsOf(provider).includes("claude-code"),
            shieldHolds: await shieldHoldsHere(services, provider),
        },
        await freshRunnerSummaries(services),
        { inFlight: services.conversations.inFlightByRunner() },
    );
};
