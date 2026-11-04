import type { AccountUsage } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Model } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { ModelOffer, OfferedAccount, OfferedModel, OfferedWindow } from "@intentic/sandbox-contract/models/model-offer";
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { fleetCapacity, gatingWindows, type RefusalsOnFile, type ServiceFacts, windowPeriod } from "@intentic/sandbox-contract/models/plan-pools";
import type { Services } from "../../composition.js";
import { ACCOUNTS_ALL, type AccountReach, accountReachAllows } from "../../secrets/credential-reach.js";
import { accountFactsOf } from "../../usage/serviceability/serviceability.js";
import { providerReadiness } from "../providers/provider-registry.js";

// What the Auto judge may choose from: every provider that can run a turn now, the models it publishes, and the
// accounts that would pay with the allowance each has left. A model no connected account can serve is dropped before
// the judge ever sees it, by the one rule the role ladder steps a rung over by and the spawn listing leaves a model out
// by (plan-pools.ts fleetCapacity, on the same facts and refusals), so the pick it comes back with cannot be one the
// provider would refuse.
//
// Endpoint providers and the free trial are deliberately absent. The premise of this feature is choosing against a
// readable allowance, and neither publishes one; an endpoint's cost is invisible here, and the trial is a disclosed
// bargain its owner opts into rather than one a router moves them to.
//
// Read as the person asking may spend (`reach`, Access ▸ People, a person's AI accounts): a member held to some accounts
// is offered those alone, by the rule their turn is then held to (agent/run/decide/account-reach.ts). Offered the
// sandbox's whole fleet, the judge picked an account their turn was refused on, so Auto failed exactly the people it is
// most useful to: the ones who cannot see which accounts are theirs.

// The pools the judge is shown: every one gating a model, less any whose window closed since it was read (a lapsed pool
// reads at the floor, not a measurement), so it is never told an allowance is fresher than it is.
const offeredWindows = (usage: AccountUsage | undefined): readonly OfferedWindow[] =>
    gatingWindows(usage)
        .filter((window) => window.lapsedAt === undefined)
        .map((window) => {
        const period = windowPeriod(window);
        return {
            ...(period === undefined ? {} : { short: period.short }),
            ...(window.label === undefined ? {} : { label: window.label }),
            left: Math.max(0, Math.min(100, 100 - window.utilization)),
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        };
    });

// The accounts that would pay, as the judge is shown them, from the very facts the filter below judges.
const offeredOf = (facts: readonly ServiceFacts[]): readonly OfferedAccount[] =>
    facts.map((entry) => ({ id: entry.account, label: entry.label ?? entry.account, windows: offeredWindows(entry.usage) }));

// Spent for every account there is, which is the only reading that may remove a model. An unmeasured account may still
// answer: "no reading" is not evidence of a full pool, and benching a model on silence would hide most of the catalog in
// a sandbox nobody has measured. Judged with the provider's refusals on file: every Claude pool is read rounded, at the
// line rather than spent, so read without them no Claude account was ever spent here, and Auto could pick a model every
// account had refused (2026-10-19).
const runnable = (facts: readonly ServiceFacts[], model: Model, refusals: RefusalsOnFile, now: number): boolean =>
    fleetCapacity(facts, refusals, { id: model.id, label: model.label }, now).kind !== "spent";

const offeredModel = (provider: AgentProvider, model: Model): OfferedModel => ({
    provider,
    model: model.id,
    label: model.label,
    efforts: model.efforts ?? [],
    ...(model.description === undefined ? {} : { note: model.description }),
});

// One catalog read per ready provider, concurrent; a provider whose catalog will not load contributes nothing rather
// than failing the whole offer, exactly as the tier router treats an unreadable catalog.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly Model[]> => {
    try {
        return (await services.providerCatalogs[provider].models()).models;
    } catch (error: unknown) {
        services.logger.warn({ err: error, provider }, "auto model: catalog unreadable, leaving this provider out of the offer");
        return [];
    }
};

const NO_REFUSALS: Awaited<ReturnType<Services["providerRefusals"]["onFile"]>> = {};

// One provider's accounts as the serviceability rule reads them; an unreadable list offers none, as one with no
// accounts does, rather than failing the whole offer.
const factsOf = async (services: Services, provider: NativeProvider): Promise<readonly ServiceFacts[]> => {
    try {
        return await accountFactsOf(services, provider);
    } catch (error: unknown) {
        services.logger.warn({ err: error, provider }, "auto model: accounts unreadable, offering this provider's models unjudged");
        return [];
    }
};

// The accounts of one provider the asker may spend. A provider granted whole hands over every account; otherwise only the
// accounts their lists name, and a provider with no account on file is theirs only when granted whole, which is how the
// turn's own reach judges one (account-reach.ts).
const withinReach = (reach: AccountReach, provider: NativeProvider, facts: readonly ServiceFacts[]): readonly ServiceFacts[] | undefined => {
    if (accountReachAllows(reach, provider, undefined)) {
        return facts;
    }
    const allowed = facts.filter((entry) => accountReachAllows(reach, provider, entry.account));
    return allowed.length === 0 ? undefined : allowed;
};

export const autoOffer = async (services: Services, now: number = Date.now(), reach: AccountReach = ACCOUNTS_ALL): Promise<ModelOffer> => {
    const [ready, refusals] = await Promise.all([
        providerReadiness(services),
        services.providerRefusals.onFile().catch((cause: unknown) => {
            services.logger.warn({ err: cause }, "auto model: refusals on file unreadable, judging allowances by the readings alone");
            return NO_REFUSALS;
        }),
    ]);
    const providers = (Object.keys(ready) as NativeProvider[]).filter((provider) => ready[provider]);
    const gathered = await Promise.all(
        providers.map(async (provider) => {
            const [held, catalog] = await Promise.all([factsOf(services, provider), catalogOf(services, provider)]);
            const facts = withinReach(reach, provider, held);
            if (facts === undefined) {
                return { provider, offered: [], models: [] };
            }
            const models = catalog.filter((model) => runnable(facts, model, refusals[provider] ?? [], now));
            return { provider, offered: offeredOf(facts), models };
        }),
    );
    // A provider with no runnable model is left out whole: offering its accounts would invite a pick with nothing to run.
    const serving = gathered.filter((entry) => entry.models.length > 0);
    return {
        models: serving.flatMap((entry) => entry.models.map((model) => offeredModel(entry.provider, model))),
        accounts: Object.fromEntries(serving.map((entry) => [entry.provider, entry.offered])),
    };
};
