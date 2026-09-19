import {
    type AccountUsage,
    type AgentProvider,
    type Model,
    type ModelOffer,
    type NativeProvider,
    type OfferedAccount,
    type OfferedModel,
    type OfferedWindow,
    TRANSLATOR_PROVIDERS,
    type TranslatorProvider,
    gatingWindows,
    windowLive,
    windowPeriod,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { type FleetReading, fleetLimit } from "../../usage/fleet-limit.js";
import { providerAccountLists, providerReadiness, sharedProviderReads } from "../providers/provider-registry.js";

// What the Auto judge may choose from: every provider that can run a turn now, the models it publishes, and the
// accounts that would pay with the allowance each has left. A model whose every connected account is at cap is dropped
// before the judge ever sees it — the same reading role-model-quota.ts steps a helper rung over — so the pick it comes
// back with cannot be one the provider would refuse.
//
// Endpoint providers and the free trial are deliberately absent. The premise of this feature is choosing against a
// readable allowance, and neither publishes one; an endpoint's cost is invisible here (the same reason turn-tier.ts
// leaves them alone), and the trial is a disclosed bargain its owner opts into rather than one a router moves them to.

const isTranslator = (provider: NativeProvider): provider is TranslatorProvider => (TRANSLATOR_PROVIDERS as readonly string[]).includes(provider);

// A reading only survives if it can still be true: a window past its reset describes a pool that no longer exists, and
// counting it as spent would bench a model that is in fact free to run. Dropped ONCE, here, so the allowance the judge
// is shown and the allowance the filter below enforces are the same fact rather than two readings of one file.
const liveUsage = (usage: AccountUsage | undefined, now: number): AccountUsage | undefined =>
    usage === undefined ? undefined : { ...usage, windows: usage.windows.filter((window) => windowLive(window, usage.measuredAt, now)) };

const offeredWindows = (usage: AccountUsage | undefined): readonly OfferedWindow[] =>
    gatingWindows(usage).map((window) => {
        const period = windowPeriod(window);
        return {
            ...(period === undefined ? {} : { short: period.short }),
            ...(window.label === undefined ? {} : { label: window.label }),
            left: Math.max(0, Math.min(100, 100 - window.utilization)),
            ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        };
    });

// One provider's accounts from both places they live: its own door (Claude and the minted providers) and the
// translator's auth files (every routed subscription). A provider can hold both; the two are one list to a picker.
const accountsOf = (
    provider: NativeProvider,
    native: readonly { readonly id: string; readonly label: string; readonly usage?: AccountUsage | undefined }[],
    routed: readonly { readonly name: string; readonly label: string; readonly usage?: AccountUsage | undefined; readonly cooling?: unknown }[],
    now: number,
): { readonly offered: readonly OfferedAccount[]; readonly readings: readonly FleetReading[] } => {
    // Normalised to one list first, so what the judge reads and what the filter enforces cannot come apart.
    const accounts = [
        ...native.map((entry) => ({ id: entry.id, label: entry.label, usage: liveUsage(entry.usage, now), cooling: undefined as FleetReading["cooling"] })),
        ...(isTranslator(provider)
            ? routed.map((entry) => ({
                  id: entry.name,
                  label: entry.label,
                  usage: liveUsage(entry.usage, now),
                  cooling: entry.cooling as FleetReading["cooling"],
              }))
            : []),
    ];
    return {
        offered: accounts.map((entry) => ({ id: entry.id, label: entry.label, windows: offeredWindows(entry.usage) })),
        readings: accounts.map((entry) => ({ account: entry.id, usage: entry.usage, ...(entry.cooling === undefined ? {} : { cooling: entry.cooling }) })),
    };
};

// Spent for every account there is, which is the only reading that may remove a model. An unmeasured account counts as
// headroom, matching role-model-quota.ts: "no reading" is not evidence of a full pool, and benching a model on silence
// would hide most of the catalog in a sandbox nobody has measured.
const runnable = (readings: readonly FleetReading[], model: Model): boolean => {
    if (readings.length === 0) {
        return true;
    }
    const limit = fleetLimit(readings, { id: model.id, label: model.label });
    return limit.spent < readings.length;
};

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

export const autoOffer = async (services: Services, now: number = Date.now()): Promise<ModelOffer> => {
    const shared = sharedProviderReads(services);
    const [ready, native, routed] = await Promise.all([providerReadiness(services), providerAccountLists(services), shared.translatorAccounts()]);
    const providers = (Object.keys(ready) as NativeProvider[]).filter((provider) => ready[provider]);
    const gathered = await Promise.all(
        providers.map(async (provider) => {
            const { offered, readings } = accountsOf(provider, native[provider] ?? [], routed[provider as TranslatorProvider] ?? [], now);
            const models = (await catalogOf(services, provider)).filter((model) => runnable(readings, model));
            return { provider, offered, models };
        }),
    );
    // A provider with no runnable model is left out whole: offering its accounts would invite a pick with nothing to run.
    const serving = gathered.filter((entry) => entry.models.length > 0);
    return {
        models: serving.flatMap((entry) => entry.models.map((model) => offeredModel(entry.provider, model))),
        accounts: Object.fromEntries(serving.map((entry) => [entry.provider, entry.offered])),
    };
};
