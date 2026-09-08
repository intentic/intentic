import { type Model, NATIVE_PROVIDERS, type NativeProvider, type SecretInventoryEntry } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { claudeProvider } from "../../runtimes/claude/claude-provider.js";
import { codexProvider } from "../../runtimes/codex/codex-provider.js";
import type { Services } from "../../composition.js";
import { cursorProvider } from "../../runtimes/cursor/cursor-provider.js";
import { geminiProvider } from "../../runtimes/gemini/gemini-provider.js";
import { grokProvider } from "../../runtimes/grok/grok-provider.js";
import { MINTED_PROVIDER_MODULES } from "../../runtimes/minted/minted-provider.js";
import { kimiProvider } from "../../runtimes/kimi/kimi-provider.js";
import type { AgentAdapter } from "./adapter.js";
import type { BootRole, ProviderCatalog, ProviderModule, SharedProviderReads } from "./provider-module.js";

export type { ProviderCatalog } from "./provider-module.js";

// List order feeds the pack overlay hash and must stay stable across daemon versions.
export const PROVIDER_MODULES: readonly ProviderModule[] = [
    claudeProvider,
    codexProvider,
    cursorProvider,
    grokProvider,
    geminiProvider,
    kimiProvider,
    // Minted providers are generated from the spec table, not listed here by hand.
    ...MINTED_PROVIDER_MODULES,
];

// Fails fast at init if a native provider has no module, instead of shipping an incomplete picker.
const ids = PROVIDER_MODULES.map((module) => module.id);
if (new Set(ids).size !== ids.length || NATIVE_PROVIDERS.some((provider) => !ids.includes(provider)) || ids.length !== NATIVE_PROVIDERS.length) {
    throw new Error(`provider registry drift: modules [${ids.join(", ")}] must be exactly the native providers [${NATIVE_PROVIDERS.join(", ")}]`);
}

// Adapter rows from native providers, in module order; ACP/Pi are appended in adapter-registry.ts.
export const PROVIDER_ADAPTERS: readonly AgentAdapter[] = PROVIDER_MODULES.flatMap((module) => module.adapters);

// Reads shared across modules per sweep, memoized so iterating them costs one round trip. Scoped to one sweep:
// outliving it would answer a later readiness check with stale sign-ins.
export const sharedProviderReads = (services: Services): SharedProviderReads => {
    let translator: Promise<Awaited<ReturnType<Services["cliProxy"]["accounts"]>>> | undefined;
    return { translatorAccounts: () => (translator ??= services.cliProxy.accounts()) };
};

// Builds the catalog record every picker, comparison and routed-turn validation reads. `services` is late-bound since
// this record is itself one of its members.
export const providerCatalogsOf = (services: () => Services): Record<NativeProvider, ProviderCatalog> =>
    Object.fromEntries(
        PROVIDER_MODULES.map((module) => [module.id, { models: () => servedModels(services(), module.id, module.catalog(services())) }]),
    ) as Record<NativeProvider, ProviderCatalog>;

// Catalog minus models this sandbox's credentials can't run; a refusal (agent.routes.ts) removes a row until it's no
// longer refused. Never empties the list or leaves the default on a refused row.
export const servedModels = async (
    services: Pick<Services, "modelRefusals">,
    provider: NativeProvider,
    catalog: Promise<{ models: Model[]; default: string }>,
): Promise<{ models: Model[]; default: string }> => {
    const [served, refused] = await Promise.all([catalog, services.modelRefusals.refused(provider)]);
    if (refused.size === 0) {
        return served;
    }
    const models = served.models.filter((model) => !refused.has(model.id));
    if (models.length === 0) {
        return served;
    }
    return { models, default: refused.has(served.default) ? models[0]!.id : served.default };
};

// Whether each provider could serve a turn now; complete over NATIVE_PROVIDERS because the init guard above enforces
// it.
export const providerReadiness = async (services: Services): Promise<Record<NativeProvider, boolean>> => {
    const shared = sharedProviderReads(services);
    const entries = await Promise.all(PROVIDER_MODULES.map(async (module) => [module.id, await module.ready(services, shared)] as const));
    return Object.fromEntries(entries) as Record<NativeProvider, boolean>;
};

// Starts every module's boot tasks; fire-and-forget and best-effort, so a throw is only that module's log line.
export const startProviderBoot = (services: Services, role: BootRole, logger: Logger): void => {
    for (const module of PROVIDER_MODULES) {
        try {
            module.boot?.(services, role, logger);
        } catch (error) {
            logger.warn({ err: error, provider: module.id }, "provider boot failed");
        }
    }
};

// Pack names connected providers want baked in, in module order.
export const providerPackWants = async (services: Services): Promise<string[]> =>
    (await Promise.all(PROVIDER_MODULES.map((module) => module.packs?.(services) ?? []))).flat();

// Every provider's connected-account rows for the secrets inventory, in module order; derived, not hand-kept.
export const providerSecretEntries = async (services: Services): Promise<SecretInventoryEntry[]> => {
    const shared = sharedProviderReads(services);
    return (await Promise.all(PROVIDER_MODULES.map((module) => module.secretEntries?.(services, shared) ?? []))).flat();
};
