import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import { aiAccountAllowed } from "@intentic/sandbox-contract/schemas/members";
import { isBuiltInPersona } from "@intentic/sandbox-contract/schemas/personas";
import { ORPCError } from "@orpc/server";
import { type ChainLimit, serviceLimits } from "./principal-chain.js";
import type { Services } from "../composition.js";

/* AN AUTOMATION'S SERVICE, CHECKED AS IT IS SAVED (docs/architecture/access.md). Every `runAs` it names, its own and each
   sender rule's, must be a service this sandbox has, and what it pairs with that service must be something the service
   could ever run with: a persona speaking through an account the service may not use, or a model ladder with no rung on
   an AI account it may use, would fail on every fire. Refused here, where the person choosing can still pick another;
   what changes later (a profile narrowed, a steward re-graded) is answered at fire time instead. */

export type AutomationServiceDeps = Pick<Services, "services" | "accessProfiles" | "members" | "ownerEmail" | "personas">;

// Each persona and the service its wakes act as: the automation's own pair, and each sender rule's, a rule naming no
// service acting as the automation's.
const pairsOf = (automation: Automation): { readonly actsAs: string | undefined; readonly runAs: string }[] => [
    ...(automation.runAs === undefined ? [] : [{ actsAs: automation.actsAs, runAs: automation.runAs }]),
    ...(automation.senders?.rules ?? []).flatMap((rule) => {
        const runAs = rule.runAs ?? automation.runAs;
        return runAs === undefined ? [] : [{ actsAs: rule.actsAs, runAs }];
    }),
];

// Whether a list of AI account keys lets any account of this provider run: the provider whole, or one account of it.
const providerAllowed = (keys: readonly string[], provider: string): boolean =>
    aiAccountAllowed(keys, provider, undefined) || keys.some((key) => key.startsWith(`${provider}:`));

const modelsRefusal = (automation: Automation, limits: readonly ChainLimit[], name: string): string | undefined => {
    const rungs = automation.models ?? [];
    for (const limit of limits) {
        if (limit.aiAccounts === "all") {
            continue;
        }
        const keys = limit.aiAccounts;
        if (rungs.length > 0 && !rungs.some((rung) => providerAllowed(keys, rung.provider))) {
            return `none of the models it may run on is an AI account ${name} may use; pick a model on one it may`;
        }
        const pinned = automation.account;
        const provider = rungs[0]?.provider;
        if (pinned !== undefined && provider !== undefined && rungs.every((rung) => rung.provider === provider) && !aiAccountAllowed(keys, provider, pinned)) {
            return `the account it pays with is not one ${name} may use`;
        }
    }
    return undefined;
};

const personaRefusal = (accounts: readonly string[], limits: readonly ChainLimit[], persona: string, name: string): string | undefined => {
    for (const limit of limits) {
        if (limit.credentials === "all") {
            continue;
        }
        const allowed = limit.credentials.capabilities;
        const missing = accounts.find((account) => !allowed.includes(account));
        if (missing !== undefined) {
            return `the persona "${persona}" speaks through "${missing}", which ${name} may not use, so it could never use it there`;
        }
    }
    return undefined;
};

/** Refuses an automation whose service is missing, or that pairs it with a persona or models the service could never run with. */
export const refuseServiceMismatch = async (services: AutomationServiceDeps, automation: Automation): Promise<void> => {
    const pairs = pairsOf(automation);
    if (pairs.length === 0) {
        return;
    }
    const [stored, profiles, roster, owner, personas] = await Promise.all([
        services.services.list(),
        services.accessProfiles.list(),
        services.members.list(),
        services.ownerEmail(),
        services.personas.list(),
    ]);
    for (const { actsAs, runAs } of pairs) {
        const service = stored.find((entry) => entry.id === runAs);
        if (service === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: `no service is called "${runAs}": pick one that exists, or leave it acting for the owner` });
        }
        const name = `the service "${service.label ?? service.id}"`;
        const limits = serviceLimits(runAs, service, profiles, roster, owner);
        const card = actsAs === undefined || isBuiltInPersona(actsAs) ? undefined : personas.find((persona) => persona.id === actsAs);
        const refused = modelsRefusal(automation, limits, name) ?? (card === undefined ? undefined : personaRefusal(card.capabilities, limits, card.label ?? card.id, name));
        if (refused !== undefined) {
            throw new ORPCError("BAD_REQUEST", { message: refused });
        }
    }
};
