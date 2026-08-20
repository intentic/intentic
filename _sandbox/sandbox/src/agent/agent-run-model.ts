import { endpointProvider, NATIVE_PROVIDERS, type QuickModelChoice, type QuickModelSource, resolveAgentRunModels } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { harnessReadyProviders } from "./harness-credentials.js";

/* WHICH OF THE OWNER'S AGENT-RUN MODELS THIS SANDBOX CAN ACTUALLY START, the daemon half of the contract's
 * agent-run-model.ts, split the same way its quick-model sibling is: the contract owns the ORDER, because the
 * settings row has to name the same head the daemon will spend, and this file owns the one FACT that order runs
 * on and only the daemon holds, which accounts are connected.
 *
 * THE WALK IS OVER CONNECTIONS, NOT OVER REFUSALS, and that is a narrower promise than askQuickModel's. A
 * one-shot that comes back refused has cost nothing, so the quick chain re-asks the next rung and keeps going.
 * An agent session cannot be replayed that way: by the time a provider refuses mid-turn the agent may already
 * have edited files in a worktree, and starting a second session on the next model would be two agents on one
 * job. So this list is read ONCE, before anything is spent, and steps over exactly the failure that is knowable
 * in advance, an account that is not there. A model that accepts the turn and dies later is a failed run the
 * user reads on its card, like any other.
 *
 * Readiness rather than a full credential resolution, deliberately: this runs at the boundary EVERY detached
 * turn passes through, and the deeper probe reads live provider catalogs. Paying for that on every unattended
 * turn to catch the rarer case (a stored account whose token has stopped refreshing) would tax the common path
 * to pre-empt a failure the run reports perfectly well by itself. It is also the same predicate the settings
 * row greys a pin with, so what the user is shown and what the daemon spends cannot disagree. */

// No catalogs are read. The contract's resolver takes pins VERBATIM, the picker offers a custom-id escape
// hatch, so a model this build has never heard of is a supported pin rather than a mistake, which leaves
// readiness as the only fact it needs, and readiness is the cheap half of what quickModelSources gathers.
const readinessSources = async (services: Services): Promise<QuickModelSource[]> => {
    const [ready, capabilities] = await Promise.all([harnessReadyProviders(services), services.capabilities.list()]);
    return [
        ...NATIVE_PROVIDERS.map((provider) => ({ provider, ready: ready[provider], models: [] })),
        // An endpoint is ready by being installed: its credential (if it needs one) was configured with it, so
        // there is no separate connection to check.
        ...capabilities.flatMap((capability) =>
            capability.kind === "endpoint" ? [{ provider: endpointProvider(capability.id), ready: true, models: [] }] : [],
        ),
    ];
};

/* The model a surface-started turn should open on, or undefined for "nobody pinned anything this sandbox can
 * reach", which is not an error: the caller's floor (the owner's own composer pick) answers instead, and that
 * is the honest fallback because it is a model they chose.
 *
 * The empty-list shortcut is not just a fast path. It is what keeps a sandbox that has pinned nothing from
 * paying for a readiness sweep on every single unattended turn it starts. */
export const agentRunModel = async (services: Services): Promise<QuickModelChoice | undefined> => {
    const { agentRunModels } = await services.sandboxSettings.get();
    if (agentRunModels.length === 0) {
        return undefined;
    }
    return resolveAgentRunModels(await readinessSources(services), agentRunModels)[0];
};
