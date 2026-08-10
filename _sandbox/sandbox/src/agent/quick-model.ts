import {
    endpointProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type QuickModelChoice,
    type QuickModelSource,
    resolveQuickModels,
} from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { harnessReadyProviders, resolveHarnessCredentials } from "./harness-credentials.js";
import { runOneShot } from "./one-shot.js";

/* THE SANDBOX'S QUICK MODEL, resolved against what it actually has connected — the daemon half of the rule in
 * the contract's quick-model.ts. The contract owns the ORDER (which of the available models to try, and in
 * which sequence) because the browser has to reach the same answer to name it in a tooltip; this file owns the
 * FACTS that order runs on, which only the daemon holds: the account stores, the translator's subscriptions,
 * and each provider's live catalog — and the WALK, because only the daemon has run the call and seen it fail.
 *
 * Every catalog here is a cached read (discovery → persisted → seed floor, never empty), so asking all five is
 * cheap after the first turn — and asking all five is required, since the whole point is to compare them. */

// One provider's catalog, from the same table the picker's own /providers/{provider}/models route serves from.
// Failures degrade to an empty list rather than taking the resolution down: a provider whose catalog is
// momentarily unreachable simply doesn't compete, and one of the others answers.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly string[]> => {
    const catalog = await services.providerCatalogs[provider].models().catch(() => undefined);
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

// A model that was asked and did not answer, with the sentence it refused in. Carried out of here rather than
// logged and dropped: a helper that quietly ran on the user's second-choice account owes them the reason, and
// the whole chain being spent is a message only this walk can write.
export interface QuickModelRefusal {
    readonly choice: QuickModelChoice;
    readonly reason: string;
}

export interface QuickModelAnswer {
    readonly text: string;
    readonly choice: QuickModelChoice;
    // Everything ahead of `choice` in the chain that refused, in the order it was tried. Empty on the ordinary
    // path, which is what lets a surface stay silent unless something actually happened.
    readonly skipped: readonly QuickModelRefusal[];
}

// What went wrong, as a sentence rather than an object. Every throw this walks over already carries a
// user-facing message (one-shot.ts turns a spent allowance and a dead credential into prose deliberately), so
// there is nothing to classify here — this is the seam that keeps a stray non-Error from becoming "[object
// Object]" in the panel's readout.
const refusalText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* RUN ONE PROMPT ON THE SANDBOX'S QUICK MODEL, WALKING DOWN THE CHAIN UNTIL ONE ANSWERS. The single seam every
 * one-click helper goes through, so they all spend the same rungs, in the same order, and all name what they
 * spent the same way.
 *
 * EVERY REFUSAL IS WORTH STEPPING OVER, and the walk deliberately does not try to sort them. A spent allowance
 * is the case the chain exists for, but a revoked token, a provider having an outage and a translator that
 * cannot route this model all leave the user in exactly the same place — nothing written, no reason given —
 * while the next account down could have answered in two seconds. Classifying would only add ways to
 * get the answer wrong, and the cost of over-stepping is one extra one-shot on a cheap rung.
 *
 * THE USER'S OWN CANCEL IS NOT A REFUSAL. A caller whose signal aborts (a loop the user stopped) is done, and
 * continuing down the chain after it would spend three more calls nobody is waiting for.
 *
 * Both terminal refusals are thrown rather than returned, and that is the opposite of harness-credentials.ts on
 * purpose: there, "no translator in this image" is a state several callers render differently, while here every
 * caller already has one place to record a failure. Nothing connected is a message about the sandbox; a chain
 * that is spent to the bottom names every model it asked and what each one said, because "couldn't draft a
 * message" without that is indistinguishable from a helper that is simply broken. */
export const askQuickModel = async (services: Services, prompt: string, signal: AbortSignal): Promise<QuickModelAnswer> => {
    const chain = resolveQuickModels(await quickModelSources(services), (await services.sandboxSettings.get()).quickModel);
    if (chain.length === 0) {
        throw new Error(`No AI account is connected to this sandbox — connect one in Sandbox ▸ Agent first.`);
    }
    const skipped: QuickModelRefusal[] = [];
    for (const choice of chain) {
        try {
            // Inside the try with the call itself: a credential that fails on the way in (a token that no longer
            // refreshes passes the cheap readiness check but fails resolution) is the same kind of dead end as
            // one that fails on the way out, and the next model in the chain answers both.
            const resolved = await resolveHarnessCredentials(services, { agent: choice.provider, model: choice.model });
            if (!resolved.ok) {
                throw new Error(resolved.message);
            }
            const text = await runOneShot({ prompt, cwd: services.workspace.root, model: choice.model, credentials: resolved.credentials, signal });
            return { text, choice, skipped };
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            services.logger.debug({ err: error, model: choice.model }, "quick model: refused, trying the next in the chain");
            skipped.push({ choice, reason: refusalText(error) });
        }
    }
    throw new Error(skipped.map((refusal) => `${refusal.choice.model}: ${refusal.reason}`).join(`; `));
};
