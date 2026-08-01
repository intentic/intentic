import {
    endpointProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type QuickModelChoice,
    type QuickModelSource,
    resolveQuickModel,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { harnessReadyProviders, resolveHarnessCredentials } from "./harness-credentials.js";
import { runOneShot } from "./one-shot.js";

/* THE SANDBOX'S QUICK MODEL, resolved against what it actually has connected — the daemon half of the rule in
 * the contract's quick-model.ts. The contract owns the DECISION (which of the available models is the cheap
 * one) because the browser has to reach the same answer to name it in a tooltip; this file owns the FACTS that
 * decision runs on, which only the daemon holds: the account stores, the translator's subscriptions, and each
 * provider's live catalog.
 *
 * Every catalog here is a cached read (discovery → persisted → seed floor, never empty), so asking all five is
 * cheap after the first turn — and asking all five is required, since the whole point is to compare them. */

// One provider's catalog, by the same service the picker's own /…/models route serves from. Failures degrade to
// an empty list rather than taking the resolution down: a provider whose catalog is momentarily unreachable
// simply doesn't compete, and one of the others answers.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly string[]> => {
    const catalog = await (
        provider === "claude"
            ? services.claudeModels.models()
            : provider === "codex"
              ? services.codexModels.models()
              : provider === "grok"
                ? services.openCode.xaiModels()
                : provider === "kimi"
                  ? services.kimiModels.models()
                  : services.geminiModels.models()
    ).catch(() => undefined);
    return catalog?.models.map((model) => model.id) ?? [];
};

// Every configured model endpoint, as a source. Ready by being installed — its credential (if any) was
// configured with it, so there is no separate connection to check — and its catalog is the same probe the picker
// and the card read. An endpoint that has published nothing contributes an empty list and simply never wins.
const endpointSources = async (services: Services): Promise<QuickModelSource[]> => {
    const endpoints = (await services.capabilities.list()).flatMap((capability) => (capability.kind === "endpoint" ? [capability] : []));
    return Promise.all(
        endpoints.map(async (capability) => ({
            provider: endpointProvider(capability.id),
            ready: true,
            models: await services.endpointModels
                .models(capability.id, capability.config)
                .then((catalog) => catalog.models.map((model) => model.id))
                .catch(() => []),
        })),
    );
};

// What the contract's resolver decides over: every native provider plus every configured endpoint, whether each
// can run, and what it publishes. Catalogs load concurrently — independent cached reads with no reason to queue.
const quickModelSources = async (services: Services): Promise<QuickModelSource[]> => {
    const ready = await harnessReadyProviders(services);
    const [native, endpoints] = await Promise.all([
        Promise.all(
            NATIVE_PROVIDERS.map(async (provider) => ({
                provider,
                ready: ready[provider],
                // A provider that cannot run is never going to be picked, so don't spend a catalog read proving it.
                models: ready[provider] ? await catalogOf(services, provider) : [],
            })),
        ),
        endpointSources(services),
    ]);
    return [...native, ...endpoints];
};

/* Run one prompt on the sandbox's quick model, reporting which model answered. The single seam every one-click
 * helper goes through, so they all spend the same rung and all name it the same way.
 *
 * Both refusals are thrown rather than returned, and that is the opposite of harness-credentials.ts on purpose:
 * there, "no translator in this image" is a state several callers render differently, while here every caller
 * is a click that already has one place to print a failure. Nothing connected is a message about the sandbox;
 * a credential that fails on the way in (a token that no longer refreshes passes the cheap readiness check but
 * fails resolution) is the resolver's own message, which says which of the several ways it failed. */
export const askQuickModel = async (
    services: Services,
    prompt: string,
    signal: AbortSignal,
): Promise<{ readonly text: string; readonly choice: QuickModelChoice }> => {
    const choice = resolveQuickModel(await quickModelSources(services), (await services.sandboxSettings.get()).quickModel);
    if (choice === undefined) {
        throw new Error(`No AI account is connected to this sandbox — connect one in Sandbox ▸ Agent first.`);
    }
    const resolved = await resolveHarnessCredentials(services, { agent: choice.provider, model: choice.model });
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    const text = await runOneShot({ prompt, cwd: services.workspace.root, model: choice.model, credentials: resolved.credentials, signal });
    return { text, choice };
};
