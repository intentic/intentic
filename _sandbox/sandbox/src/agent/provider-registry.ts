import { type Model, NATIVE_PROVIDERS, type NativeProvider, type SecretInventoryEntry } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { claudeProvider } from "../claude/claude-provider.js";
import { codexProvider } from "../codex/codex-provider.js";
import type { Services } from "../composition.js";
import { cursorProvider } from "../cursor/cursor-provider.js";
import { geminiProvider } from "../gemini/gemini-provider.js";
import { grokProvider } from "../grok/grok-provider.js";
import { MINTED_PROVIDER_MODULES } from "../minted/minted-provider.js";
import { kimiProvider } from "../kimi/kimi-provider.js";
import type { AgentAdapter } from "./adapter.js";
import type { BootRole, ProviderCatalog, ProviderModule, SharedProviderReads } from "./provider-module.js";

export type { ProviderCatalog } from "./provider-module.js";

/* THE PROVIDER LIST, once. Every shared surface that used to keep its own enumeration of the native providers
 * (the adapter table, the catalog record, the readiness sweep, the boot blocks, the pack predicates, the
 * secrets rows) derives from this one instead, so a provider that exists is a provider every surface serves.
 * provider-module.ts is the seam's contract and the reasoning; this file is the aggregation and the
 * derivations, kept together so "what iterates the modules" has one answer.
 *
 * ORDER IS MEANINGFUL in one place only: the pack fragments compose an image overlay in list order, and the
 * committed overlay hash must be stable across daemon versions, so this order is part of that stability. */
export const PROVIDER_MODULES: readonly ProviderModule[] = [
    claudeProvider,
    codexProvider,
    cursorProvider,
    grokProvider,
    geminiProvider,
    kimiProvider,
    /* THE MINTED PROVIDERS ARE ONE LINE FOR ALL OF THEM, and that is the point of the family rather than an
     * economy taken with it. Meta and Z.ai differ in a seed list, a login driver and their estates' URLs, so
     * their modules are generated from the spec table (minted/minted-provider.ts). Writing them out here would
     * put the count of minted providers in two places — this file and the contract — which is exactly the
     * drift the guard below exists to catch, reintroduced one layer up. */
    ...MINTED_PROVIDER_MODULES,
];

/* THE DISCOVERY GUARD, at module init rather than only in a test: a native provider without a module would
 * otherwise ship as a picker row whose catalog, readiness and secrets rows silently do not exist — the exact
 * class of omission this registry replaces. Throwing here fails every suite that touches the agent plane and
 * every daemon boot, which is the loudest available version of "you forgot the registration line". */
const ids = PROVIDER_MODULES.map((module) => module.id);
if (new Set(ids).size !== ids.length || NATIVE_PROVIDERS.some((provider) => !ids.includes(provider)) || ids.length !== NATIVE_PROVIDERS.length) {
    throw new Error(`provider registry drift: modules [${ids.join(", ")}] must be exactly the native providers [${NATIVE_PROVIDERS.join(", ")}]`);
}

// The adapter rows the native providers contribute, in module order. The two non-native runtimes (ACP, Pi)
// are appended where the table is assembled (adapter-registry.ts), because they are capabilities, not modules.
export const PROVIDER_ADAPTERS: readonly AgentAdapter[] = PROVIDER_MODULES.flatMap((module) => module.adapters);

/* The reads several modules share per sweep, memoized so a derived iteration costs the same round trips the
 * hand-written enumerations paid (see SharedProviderReads). One instance per sweep, never longer: a cached
 * account map that outlives the sweep would answer tomorrow's readiness with today's sign-ins. */
export const sharedProviderReads = (services: Services): SharedProviderReads => {
    let translator: Promise<Awaited<ReturnType<Services["cliProxy"]["accounts"]>>> | undefined;
    return { translatorAccounts: () => (translator ??= services.cliProxy.accounts()) };
};

/* The Record<NativeProvider, ProviderCatalog> every picker route, quick-model comparison and routed-turn
 * validation reads (services.providerCatalogs). Takes the services LATE-BOUND, because the record is itself a
 * member of the object it reads from: the thunks only run once a request arrives, long after composition has
 * finished (the extensionBackend holder is the precedent, composition.ts). */
export const providerCatalogsOf = (services: () => Services): Record<NativeProvider, ProviderCatalog> =>
    Object.fromEntries(
        PROVIDER_MODULES.map((module) => [module.id, { models: () => servedModels(services(), module.id, module.catalog(services())) }]),
    ) as Record<NativeProvider, ProviderCatalog>;

/* THE CATALOG MINUS WHAT THIS SANDBOX'S CREDENTIALS ARE NOT ALLOWED TO RUN.
 *
 * A vendor's model list is what the VENDOR publishes, not what the connected plan pays for, and nothing in the
 * list distinguishes the two: the translator serves all eight Kimi models to a subscription that covers six.
 * The rows it does not cover are worse than missing, they are traps — picking one starts a turn that cannot be
 * served, and the refusal comes back as a 503 that every layer above reads as an outage (routed-refusal.ts has
 * the story and the measurements).
 *
 * So the one place every catalog is served through is the one place they come off. Filed by the turn that
 * discovered the refusal (agent.routes.ts) and forgotten a day later, so buying the plan brings the row back
 * without anyone clearing anything.
 *
 * IT WILL NOT EMPTY A CATALOG. `models` is non-empty by this seam's contract and the picker has nothing to draw
 * without it, so a provider whose every model has been refused keeps its list whole: an honest refusal on send
 * beats a picker that cannot say what the provider serves. Same reasoning for the DEFAULT, which moves to the
 * first surviving row rather than being left pointing at one the plan will refuse.
 *
 * Exported for the test alone: the record above is built from the live provider modules, so reaching this
 * through it would mean standing up the whole daemon to assert a filter. */
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

// Whether each provider could serve a turn right now, the harnessReadyProviders sweep. Complete over
// NATIVE_PROVIDERS by the init guard above, which is what lets the cast stand.
export const providerReadiness = async (services: Services): Promise<Record<NativeProvider, boolean>> => {
    const shared = sharedProviderReads(services);
    const entries = await Promise.all(PROVIDER_MODULES.map(async (module) => [module.id, await module.ready(services, shared)] as const));
    return Object.fromEntries(entries) as Record<NativeProvider, boolean>;
};

// Start every module's boot tasks. Each is fire-and-forget and best-effort by the seam's contract; the loop
// adds nothing but the iteration, so a module that throws SYNCHRONOUSLY is still only its own log line.
export const startProviderBoot = (services: Services, role: BootRole, logger: Logger): void => {
    for (const module of PROVIDER_MODULES) {
        try {
            module.boot?.(services, role, logger);
        } catch (error) {
            logger.warn({ err: error, provider: module.id }, "provider boot failed");
        }
    }
};

// The pack names connected providers want baked, in module order (see the ORDER note above).
export const providerPackWants = async (services: Services): Promise<string[]> =>
    (await Promise.all(PROVIDER_MODULES.map((module) => module.packs?.(services) ?? []))).flat();

// Every provider's connected-account rows for the secrets inventory, in module order. THE list that was
// hand-kept and wrong twice (Kimi never listed, Cursor forgotten on landing); derived, it cannot be.
export const providerSecretEntries = async (services: Services): Promise<SecretInventoryEntry[]> => {
    const shared = sharedProviderReads(services);
    return (await Promise.all(PROVIDER_MODULES.map((module) => module.secretEntries?.(services, shared) ?? []))).flat();
};
