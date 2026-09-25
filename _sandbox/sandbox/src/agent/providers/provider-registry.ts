import type { Model, NativeProvider, OauthAccount, SecretInventoryEntry } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { Services } from "../../composition.js";
import type { ProviderDeps } from "../../runtimes/runtime-table.js";
import { mergeSupersededAccounts } from "./accounts/account-identity.js";
import type { BootRole, ProviderCatalog, ProviderModule, SharedProviderReads } from "./provider-module.js";

export type { ProviderCatalog } from "./provider-module.js";

// The shared surfaces every provider module feeds, each iterating the modules composition wired rather than a list of its
// own; the list itself is runtimes/runtime-table.ts. Every aggregate hands the modules what they read of the daemon.
type ProviderRegistry = ProviderDeps & Pick<Services, "cliProxy" | "providerModules">;

// Reads shared across modules per sweep, memoized so iterating them costs one round trip. Scoped to one sweep:
// outliving it would answer a later readiness check with stale sign-ins.
export const sharedProviderReads = (services: Pick<Services, "cliProxy">): SharedProviderReads => {
    let translator: Promise<Awaited<ReturnType<Services["cliProxy"]["accounts"]>>> | undefined;
    return { translatorAccounts: () => (translator ??= services.cliProxy.accounts()) };
};

// Builds the catalog record every picker, comparison and routed-turn validation reads. `services` is late-bound since
// this record is itself one of its members.
export const providerCatalogsOf = (
    modules: readonly ProviderModule<ProviderDeps>[],
    services: () => ProviderDeps & Pick<Services, "modelCooldowns" | "modelRefusals">,
): Record<NativeProvider, ProviderCatalog> =>
    Object.fromEntries(
        modules.map((module) => [module.id, { models: () => servedModels(services(), module.id, module.catalog(services())) }]),
    ) as Record<NativeProvider, ProviderCatalog>;

// Catalog minus models this sandbox's credentials can't run; a refusal (agent.routes.ts) removes a row until it's no
// longer refused. Never empties the list or leaves the default on a refused row.
// A cooling model is marked, not removed: it comes back on its own, and a row that vanishes for an hour teaches a
// reader to distrust the list. Only a model the plan does not cover at all is dropped.
export const servedModels = async (
    services: Pick<Services, "modelRefusals" | "modelCooldowns">,
    provider: NativeProvider,
    catalog: Promise<{ models: Model[]; default: string }>,
): Promise<{ models: Model[]; default: string }> => {
    const [served, refused, cooling] = await Promise.all([
        catalog,
        services.modelRefusals.refused(provider),
        services.modelCooldowns.cooling(provider),
    ]);
    const marked = cooling.size === 0 ? served.models : served.models.map((model) => withCooldown(model, cooling.get(model.id)));
    if (refused.size === 0) {
        return { ...served, models: marked };
    }
    const models = marked.filter((model) => !refused.has(model.id));
    if (models.length === 0) {
        return { ...served, models: marked };
    }
    return { models, default: refused.has(served.default) ? models[0]!.id : served.default };
};

// Epoch ms on the store, epoch seconds on the wire, like every other instant a client draws.
const withCooldown = (model: Model, cooldown: { readonly until: number } | undefined): Model =>
    cooldown === undefined ? model : { ...model, availableAt: Math.ceil(cooldown.until / 1000) };

// Report readiness for every native provider guarded by initialization.
export const providerReadiness = async (services: ProviderRegistry): Promise<Record<NativeProvider, boolean>> => {
    const shared = sharedProviderReads(services);
    const entries = await Promise.all(services.providerModules.map(async (module) => [module.id, await module.ready(services, shared)] as const));
    return Object.fromEntries(entries) as Record<NativeProvider, boolean>;
};

// Starts every module's boot tasks; fire-and-forget and best-effort, so a throw is only that module's log line. The
// daemon owning the workspace roots also merges superseded account rows into their survivors (account-identity.ts), the
// conversion that moves pins before a duplicate is forgotten; no other writer touches those stores at boot.
export const startProviderBoot = (services: ProviderRegistry & Pick<Services, "agents" | "automations">, role: BootRole, logger: Logger): void => {
    for (const module of services.providerModules) {
        try {
            module.boot?.(services, role, logger);
        } catch (error) {
            logger.warn({ err: error, provider: module.id }, "provider boot failed");
        }
    }
    if (role.roots) {
        const doors = Object.fromEntries(services.providerModules.flatMap((module) => (module.accounts === undefined ? [] : [[module.id, module.accounts(services)]])));
        void mergeSupersededAccounts(services, doors)
            .then((merged) => {
                if (merged.length > 0) {
                    logger.info({ merged }, "accounts: merged superseded sign-ins into the accounts that go on");
                }
            })
            .catch((error: unknown) => logger.warn({ err: error }, "accounts: merging superseded sign-ins failed"));
    }
};

// Pack names connected providers want baked in, in module order.
export const providerPackWants = async (services: ProviderRegistry): Promise<string[]> =>
    (await Promise.all(services.providerModules.map((module) => module.packs?.(services) ?? []))).flat();

// Every provider's own connected accounts, in module order; a provider with no door answers with an empty list, which
// is a real state (a plain key, a container credential) and not an error. `list(false)` reads what is on file rather
// than re-measuring: a caller wanting fresh plan limits asks the headroom service, not this.
export const providerAccountLists = async (services: ProviderRegistry): Promise<Record<NativeProvider, readonly OauthAccount[]>> => {
    const entries = await Promise.all(
        services.providerModules.map(async (module) => {
            const accounts: readonly OauthAccount[] = await (module.accounts?.(services).list(false) ?? []);
            return [module.id, accounts] as const;
        }),
    );
    return Object.fromEntries(entries) as Record<NativeProvider, readonly OauthAccount[]>;
};

// Every provider's connected-account rows for the secrets inventory, in module order; derived, not hand-kept.
export const providerSecretEntries = async (services: ProviderRegistry): Promise<SecretInventoryEntry[]> => {
    const shared = sharedProviderReads(services);
    return (await Promise.all(services.providerModules.map((module) => module.secretEntries?.(services, shared) ?? []))).flat();
};
