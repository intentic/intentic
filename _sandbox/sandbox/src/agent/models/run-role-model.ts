import { endpointProvider, type ModelPin, type ModelRole, type ModelSource, NATIVE_PROVIDERS, readyChain } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { harnessReadyProviders } from "../providers/harness-credentials.js";
import { failingStreak } from "./role-model-health.js";
import { spentRung } from "./role-model-quota.js";

// Resolves which of a `run` role's pinned models this sandbox can actually start; read once before the session starts,
// since a refusal mid-turn cannot be replayed like the one-shot helper chain. Checks readiness and the recorded quota
// only, the same predicate that greys a pin in the settings row.

// No catalogs are read: pins are taken verbatim (the picker's custom-id escape hatch), so readiness is the only fact
// needed here.
const readinessSources = async (services: Services): Promise<ModelSource[]> => {
    const [ready, capabilities] = await Promise.all([harnessReadyProviders(services), services.capabilities.list()]);
    return [
        ...NATIVE_PROVIDERS.map((provider) => ({ provider, ready: ready[provider], models: [] })),
        // An endpoint counts ready simply by being installed; no separate connection to check.
        ...capabilities.flatMap((capability) =>
            capability.kind === "endpoint" ? [{ provider: endpointProvider(capability.id), ready: true, models: [] }] : [],
        ),
    ];
};

// Pin this role should open on, or undefined so the caller falls back to its own composer pick; carries the whole pin
// (effort, harness), not just provider/model.
export const runRoleModel = async (services: Services, role: ModelRole): Promise<ModelPin | undefined> =>
    pinnedRunModel(services, (await services.sandboxSettings.get()).modelRoles[role] ?? []);

// Walks any ordered ladder of pins, whoever wrote it (a role, a persona, an automation); readiness and quota are
// sandbox facts, not the caller's. An empty ladder answers undefined and the caller decides what that means.
export const pinnedRunModel = async (services: Services, pinned: readonly ModelPin[]): Promise<ModelPin | undefined> => {
    if (pinned.length === 0) {
        return undefined;
    }
    return headOf(services, readyChain(await readinessSources(services), pinned));
};

// Pin from the persona's own ladder (schemas/personas.ts `models`), consulted before the role since it is more
// specific; undefined when the card, its ladder, or every provider in it is unavailable.
export const personaRunModel = async (services: Services, actsAs: string | undefined): Promise<ModelPin | undefined> => {
    if (actsAs === undefined) {
        return undefined;
    }
    return pinnedRunModel(services, (await services.personas.get(actsAs))?.models ?? []);
};

// First rung neither the recorded quota calls spent nor the turn ledger shows dying in a row, or the head of the chain
// if every rung is: it runs anyway, since both readings are snapshots that may already be stale.
const headOf = async (services: Services, chain: readonly ModelPin[]): Promise<ModelPin | undefined> => {
    for (const choice of chain) {
        if ((await spentRung(services, choice)) !== undefined) {
            continue;
        }
        const streak = await failingStreak(services.usage, choice);
        if (streak === undefined) {
            return choice;
        }
        services.logger.info({ provider: choice.provider, model: choice.model, streak }, "run role: rung stepped over for a failing streak");
    }
    return chain[0];
};
