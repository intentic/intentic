import { endpointProvider, type ModelPin, type ModelRole, type ModelSource, NATIVE_PROVIDERS, readyChain } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { harnessReadyProviders } from "../providers/harness-credentials.js";
import { spentRung } from "./role-model-quota.js";

/* WHICH OF THE OWNER'S MODELS FOR A `run` ROLE THIS SANDBOX CAN ACTUALLY START, the daemon half of the
 * contract's resolver, split the same way its helper sibling (role-model.ts) is: the contract owns the ORDER,
 * because the settings row has to name the same head the daemon will spend, and this file owns the one FACT
 * that order runs on and only the daemon holds, which accounts are connected.
 *
 * ONE ROLE PER STARTER, and that is what this file gained when the model lists stopped being grouped by
 * intensity. There used to be a single list behind every unattended turn, so a production incident
 * and a documentation sweep were configured together and a surface added tomorrow inherited that tier by saying
 * nothing at all. Now a starter declares what it IS (AgentTurn.runRole) and the owner answers per job.
 *
 * THE WALK IS OVER WHAT IS KNOWABLE BEFORE THE SESSION STARTS, and that is a narrower promise than
 * askRoleModel's. A one-shot that comes back refused has cost nothing, so the helper chain re-asks the next rung
 * and keeps going. An agent session cannot be replayed that way: by the time a provider refuses mid-turn the
 * agent may already have edited files in a worktree, and starting a second session on the next model would be
 * two agents on one job. So this list is read ONCE, before anything is spent, and steps over exactly the two
 * failures that are knowable in advance: an account that is not there, and an allowance the recorded quota
 * already says is spent (role-model-quota.ts, the same reading the helper chain steps over on). The second is
 * the commoner: a pinned head whose account the chat had spent all morning took every Fix-with-agent down for
 * hours while the second pin sat with a full week. A model that accepts the turn and dies later is a failed run
 * the user reads on its card, like any other.
 *
 * Readiness rather than a full credential resolution, deliberately: this runs at the boundary EVERY detached
 * turn passes through, and the deeper probe reads live provider catalogs. Paying for that on every unattended
 * turn to catch the rarer case (a stored account whose token has stopped refreshing) would tax the common path
 * to pre-empt a failure the run reports perfectly well by itself. It is also the same predicate the settings
 * row greys a pin with, so what the user is shown and what the daemon spends cannot disagree. */

// No catalogs are read. The contract's resolver takes pins VERBATIM, the picker offers a custom-id escape
// hatch, so a model this build has never heard of is a supported pin rather than a mistake, which leaves
// readiness as the only fact it needs, and readiness is the cheap half of what the helper walk gathers.
const readinessSources = async (services: Services): Promise<ModelSource[]> => {
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

/* The PIN a turn started for this ROLE should open on, or undefined for "nobody pinned anything this sandbox
 * can reach", which is not an error: the caller's floor (the owner's own composer pick) answers instead, and
 * that is the honest fallback because it is a model they chose.
 *
 * The whole pin rather than its (provider, model) pair, because the entry says how hard that model thinks and
 * on which loop as well as which model it is, and the turn is composed from all of it (turn-resume.ts).
 *
 * The empty-list shortcut is not just a fast path. It is what keeps a sandbox that has pinned nothing for this
 * role from paying for a readiness sweep on every single unattended turn it starts. */
export const runRoleModel = async (services: Services, role: ModelRole): Promise<ModelPin | undefined> =>
    pinnedRunModel(services, (await services.sandboxSettings.get()).modelRoles[role] ?? []);

/* THE WALK ITSELF, over ANY ordered ladder, whoever wrote it down. The three callers differ only in where the
 * list comes from — a role's settings row, a persona card, an automation's own manifest entry — and that is the
 * whole of the difference: readiness and the recorded quota are facts about this sandbox, not about who is
 * asking. It was inlined in the role lookup while the role WAS the only list; an automation carrying its own
 * ladder (contract schemas/automations.ts `models`) is the second real list, and a second copy of this walk is
 * how two surfaces come to disagree about which rung they would spend.
 *
 * An empty ladder answers undefined, and what that MEANS is the caller's to decide: a run role falls to the
 * owner's composer pick, while an automation refuses to fire at all, because a job nobody is watching has no
 * composer behind it to fall to. */
export const pinnedRunModel = async (services: Services, pinned: readonly ModelPin[]): Promise<ModelPin | undefined> => {
    if (pinned.length === 0) {
        return undefined;
    }
    return headOf(services, readyChain(await readinessSources(services), pinned));
};

/* THE PIN A TURN WEARING THIS PERSONA SHOULD OPEN ON, from the card's own ladder (contract schemas/personas.ts
 * `models`), or undefined for a card with none, a card that is not there, or a ladder whose every provider is
 * disconnected. Literally the same walk as the role's above — there is no floor under either any more, so the
 * two differ only in which list they read: a card that says nothing about models has left the question to the
 * role, and the caller asks the role next (turn-resume.ts withRoleModel). Consulted BEFORE
 * the role because the card is the more specific answer: the role says what kind of job this is, the card
 * says who is doing it, and an owner who pinned a model on a persona meant it for every turn wearing that
 * persona, whatever started them. */
export const personaRunModel = async (services: Services, actsAs: string | undefined): Promise<ModelPin | undefined> => {
    if (actsAs === undefined) {
        return undefined;
    }
    return pinnedRunModel(services, (await services.personas.get(actsAs))?.models ?? []);
};

// The first rung of a chain the recorded quota does not already call spent, or, when every rung is, the head:
// it runs anyway and fails in the provider's own words, which beats a run that quietly opens on an account the
// user never pinned. The reading is a snapshot, and a chain spent to the bottom is exactly when a window may
// have reopened since it was taken.
const headOf = async (services: Services, chain: readonly ModelPin[]): Promise<ModelPin | undefined> => {
    for (const choice of chain) {
        if ((await spentRung(services, choice)) === undefined) {
            return choice;
        }
    }
    return chain[0];
};
