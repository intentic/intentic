import {
    endpointProvider,
    NATIVE_PROVIDERS,
    type NativeProvider,
    type QuickModelChoice,
    quickModelKey,
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

/* ONE RUNG'S TURN, AS IT IS BEING SPENT — what a caller that wants to SHOW the walk receives, live, where
 * QuickModelAnswer only says how it ended. `asking` is a rung in flight; the other three are settled, with the
 * time each cost and (for a refusal, or a rung skipped on its own recent refusal) the sentence it gave. */
export interface QuickModelAttempt {
    readonly choice: QuickModelChoice;
    readonly status: "asking" | "answered" | "refused" | "skipped";
    // When this rung started being asked — what a consumer's ticking "12s…" is measured from. Absent for
    // `skipped`, which cost nothing.
    readonly at?: number;
    readonly ms?: number;
    readonly reason?: string;
}

/* The live view of the walk: called with the WHOLE list after every transition — a rung starting, settling, or
 * being stepped over — so the consumer holds a snapshot rather than replaying events. Optional, because most
 * callers only want the answer; the one that is drawing a progress report wants every beat.
 *
 * A listener's throw must not kill the walk it is only watching. */
export type QuickModelProgress = (attempts: readonly QuickModelAttempt[]) => void;

// What went wrong, as a sentence rather than an object. Every throw this walks over already carries a
// user-facing message (one-shot.ts turns a spent allowance and a dead credential into prose deliberately), so
// there is nothing to classify here — this is the seam that keeps a stray non-Error from becoming "[object
// Object]" in the panel's readout.
const refusalText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* WHAT A RUNG THAT JUST REFUSED COSTS THE NEXT CALLER — nothing, for a few minutes.
 *
 * A refusal is not a property of one call. An allowance that is spent is spent for hours, an outage lasts
 * minutes, a revoked token lasts until somebody reconnects it — and the walk below re-discovered every one of
 * them from scratch, on every helper call, paying the full wait each time. Measured on this workspace: the
 * first pinned model answered nothing for 58 seconds before the chain stepped down to one that answered in 7,
 * per landing, all afternoon. The daemon knew that after the first landing and spent it again on every one
 * after — which is most of what "the commit message takes a minute" was.
 *
 * So a refusal is REMEMBERED, briefly, and the next walk starts below it. Briefly because this is a memo and
 * not a verdict: nothing tells this process when an allowance resets or a provider recovers, so the window
 * simply ends and the next call spends one re-test to find out. Long enough that a burst of landings costs one
 * discovery between them; short enough that a model which came back is back in minutes.
 *
 * KEPT WITH ITS REASON, so a rung skipped without being asked reports the same sentence it gave when it did
 * refuse — `skipped` stays the honest account of what happened to the chain, rather than going quiet about the
 * accounts this walk never touched.
 *
 * IN MEMORY, never persisted: a daemon that restarted did not inherit the outage it was in, and a memo restored
 * from disk would skip a working account on the strength of something that happened before the reboot. */
const REFUSED_FOR_MS = 5 * 60 * 1000;

const refusals = new Map<string, { readonly until: number; readonly reason: string }>();

// What this rung last refused with, while that memo still stands. Undefined once the window has run out, and
// for a rung that has never refused — both of which mean "ask it".
const cooling = (choice: QuickModelChoice, now: number): string | undefined => {
    const held = refusals.get(quickModelKey(choice));
    return held !== undefined && held.until > now ? held.reason : undefined;
};

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
export const askQuickModel = async (
    services: Services,
    prompt: string,
    signal: AbortSignal,
    onProgress?: QuickModelProgress,
): Promise<QuickModelAnswer> => {
    const chain = resolveQuickModels(await quickModelSources(services), (await services.sandboxSettings.get()).quickModel);
    if (chain.length === 0) {
        throw new Error(`No AI account is connected to this sandbox — connect one in Sandbox ▸ Agent first.`);
    }
    /* The walk as it stands, re-told whole after every beat. Wrapped so a listener that throws is the
     * listener's problem: this function's job is the answer, and the report may never cost the user the
     * sentence it is reporting on. */
    const attempts: QuickModelAttempt[] = [];
    const tell = (): void => {
        try {
            onProgress?.([...attempts]);
        } catch {
            // A broken listener forfeits its updates, nothing else.
        }
    };
    const now = Date.now();
    /* THE MEMO MAY NEVER EMPTY THE CHAIN. When every rung is cooling down at once this walk ignores it and asks
     * them all: a memo exists to save time, and one that could stand between the user and every account they
     * have would turn a slow feature into a dead one for the length of its own window — the same failure it was
     * added to prevent, arriving from the other side. */
    const honourMemo = chain.some((choice) => cooling(choice, now) === undefined);
    const skipped: QuickModelRefusal[] = [];
    for (const choice of chain) {
        // Stepped over without being asked, and reported in the words it used when it did refuse — so `skipped`
        // stays the honest account of what stood between the caller and the model that answered.
        const remembered = honourMemo ? cooling(choice, now) : undefined;
        if (remembered !== undefined) {
            skipped.push({ choice, reason: remembered });
            attempts.push({ choice, status: `skipped`, reason: remembered });
            tell();
            continue;
        }
        /* EVERY RUNG IS TIMED, answered or refused, and named as it is spent. The call as a whole was already
         * measured by its caller (landing.subject and its siblings), and that number cannot say the one thing
         * worth knowing when a helper turns slow: WHICH model took the time. Finding that out meant watching
         * the CLI processes by hand. One record per attempt makes the next occurrence self-evident, and the
         * memo's effect legible too — a rung that stops appearing is one the walk has stopped paying for. */
        const from = Date.now();
        const spent = (): number => Date.now() - from;
        const key = quickModelKey(choice);
        // In flight, said before the wait rather than after: "asking X" during the seconds X is taking is the
        // one line of this report that answers a user staring at it right now.
        attempts.push({ choice, status: `asking`, at: from });
        tell();
        // The in-flight entry settles in place — the walk's list is a timeline, and one rung is one entry.
        const settle = (attempt: QuickModelAttempt): void => {
            attempts[attempts.length - 1] = attempt;
            tell();
        };
        try {
            // Inside the try with the call itself: a credential that fails on the way in (a token that no longer
            // refreshes passes the cheap readiness check but fails resolution) is the same kind of dead end as
            // one that fails on the way out, and the next model in the chain answers both.
            const resolved = await resolveHarnessCredentials(services, { agent: choice.provider, model: choice.model });
            if (!resolved.ok) {
                throw new Error(resolved.message);
            }
            const text = await runOneShot({ prompt, cwd: services.workspace.root, model: choice.model, credentials: resolved.credentials, signal });
            // It answered, so whatever it last refused for is over — a memo outliving the condition it
            // describes would keep steering work off an account that is plainly working again.
            refusals.delete(key);
            services.perf.record("quick.model", spent(), { provider: choice.provider, model: choice.model });
            settle({ choice, status: `answered`, at: from, ms: spent() });
            return { text, choice, skipped };
        } catch (error) {
            if (signal.aborted) {
                // The user's own cancel is not the model's failure, so it earns no memo: the next call must ask
                // this rung as if nothing had happened, because nothing about it did.
                throw error;
            }
            services.perf.record("quick.model", spent(), { provider: choice.provider, model: choice.model }, true);
            refusals.set(key, { until: Date.now() + REFUSED_FOR_MS, reason: refusalText(error) });
            services.logger.debug({ err: error, model: choice.model }, "quick model: refused, trying the next in the chain");
            skipped.push({ choice, reason: refusalText(error) });
            settle({ choice, status: `refused`, at: from, ms: spent(), reason: refusalText(error) });
        }
    }
    throw new Error(skipped.map((refusal) => `${refusal.choice.model}: ${refusal.reason}`).join(`; `));
};
