import {
    capabilitiesOf,
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
import { runGeminiOneShot } from "./one-shot-gemini.js";
import { spentRung } from "./quick-model-quota.js";

/* THE SANDBOX'S QUICK MODEL, resolved against what it actually has connected, the daemon half of the rule in
 * the contract's quick-model.ts. The contract owns the ORDER (which of the available models to try, and in
 * which sequence) because the browser has to reach the same answer to name it in a tooltip; this file owns the
 * FACTS that order runs on, which only the daemon holds: the account stores, the translator's subscriptions,
 * and each provider's live catalog, and the WALK, because only the daemon has run the call and seen it fail.
 *
 * Every catalog here is a cached read (discovery → persisted → seed floor, never empty), so asking all five is
 * cheap after the first turn, and asking all five is required, since the whole point is to compare them. */

// One provider's catalog, from the same table the picker's own /providers/{provider}/models route serves from.
// Failures degrade to an empty list rather than taking the resolution down: a provider whose catalog is
// momentarily unreachable simply doesn't compete, and one of the others answers.
const catalogOf = async (services: Services, provider: NativeProvider): Promise<readonly string[]> => {
    const catalog = await services.providerCatalogs[provider].models().catch(() => undefined);
    return catalog?.models.map((model) => model.id) ?? [];
};

// Every configured model endpoint, as a source. Ready by being installed, its credential (if any) was
// configured with it, so there is no separate connection to check, and its catalog is the same probe the picker
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
// can run, and what it publishes. Catalogs load concurrently, independent cached reads with no reason to queue.
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

/* ONE RUNG'S TURN, AS IT IS BEING SPENT, what a caller that wants to SHOW the walk receives, live, where
 * QuickModelAnswer only says how it ended. `asking` is a rung in flight; the other three are settled, with the
 * time each cost and (for a refusal, or a rung skipped on its own recent refusal) the sentence it gave. */
export interface QuickModelAttempt {
    readonly choice: QuickModelChoice;
    readonly status: "asking" | "answered" | "refused" | "skipped";
    // When this rung started being asked, what a consumer's ticking "12s…" is measured from. Absent for
    // `skipped`, which cost nothing.
    readonly at?: number;
    readonly ms?: number;
    readonly reason?: string;
}

/* The live view of the walk: called with the WHOLE list after every transition, a rung starting, settling, or
 * being stepped over, so the consumer holds a snapshot rather than replaying events. Optional, because most
 * callers only want the answer; the one that is drawing a progress report wants every beat.
 *
 * A listener's throw must not kill the walk it is only watching. */
export type QuickModelProgress = (attempts: readonly QuickModelAttempt[]) => void;

// What went wrong, as a sentence rather than an object. Every throw this walks over already carries a
// user-facing message (one-shot.ts turns a spent allowance and a dead credential into prose deliberately), so
// there is nothing to classify here, this is the seam that keeps a stray non-Error from becoming "[object
// Object]" in the panel's readout.
const refusalText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* WHAT A RUNG THAT JUST REFUSED COSTS THE NEXT CALLER, nothing, for hours.
 *
 * A refusal is not a property of one call. An allowance that is spent is spent for hours, an outage lasts
 * minutes, a revoked token lasts until somebody reconnects it, and the walk below re-discovered every one of
 * them from scratch, on every helper call, paying the full wait each time. Measured on this workspace: the
 * first pinned model answered nothing for 58 seconds before the chain stepped down to one that answered in 7,
 * per landing, all afternoon. The daemon knew that after the first landing and spent it again on every one
 * after, which is most of what "the commit message takes a minute" was.
 *
 * So a refusal is REMEMBERED and the next walk starts below it. This is the FALLBACK memory, not the primary
 * one: what a provider still has left, and when it renews, is a fact we hold for every account that publishes
 * it (translator turnLimit, accountWithHeadroom), and a rung skipped on a reading is skipped for a reason with
 * an expiry the provider itself stated. The memo covers what no reading can, a provider that publishes no
 * quota, a snapshot that failed to refresh, and the refusals that are not about allowance at all (a revoked
 * token, an outage, a request the vendor objects to and answers with a quota-shaped error anyway).
 *
 * HOURS, not the five minutes this began as. Five was chosen so a model that recovered was back quickly, and
 * that reasoning had the frequency backwards: landings are usually further apart than five minutes, so the
 * window almost always expired between them and the same refusal was bought again on nearly every commit,
 * measured at 58 failed attempts out of 116, about 4.7s each. A memo that expires faster than the work it is
 * remembering for is not a memo. Hours is still a memo and not a verdict: it ends by itself, one re-test
 * re-opens the rung, and an answer clears it outright.
 *
 * KEPT WITH ITS REASON, so a rung skipped without being asked reports the same sentence it gave when it did
 * refuse, `skipped` stays the honest account of what happened to the chain, rather than going quiet about the
 * accounts this walk never touched.
 *
 * IN MEMORY, never persisted: a daemon that restarted did not inherit the outage it was in, and a memo restored
 * from disk would skip a working account on the strength of something that happened before the reboot. */
export const REFUSED_FOR_MS = 2 * 60 * 60 * 1000;

const refusals = new Map<string, { readonly until: number; readonly reason: string }>();

// What this rung last refused with, while that memo still stands. Undefined once the window has run out, and
// for a rung that has never refused, both of which mean "ask it".
const cooling = (choice: QuickModelChoice, now: number): string | undefined => {
    const held = refusals.get(quickModelKey(choice));
    return held !== undefined && held.until > now ? held.reason : undefined;
};

/* WHICH LOOP RUNS THIS RUNG, asked of the contract, never decided here. `capabilitiesOf` is where a provider's
 * runtime is settled for the whole product (the adapter that serves a chat turn reads the same record), so a
 * helper that named a provider of its own would be a second opinion on a question that already has one, and
 * the day the two disagreed, a turn and its commit message would run on different loops.
 *
 * What it settles today: Gemini answers `opencode-gemini` whatever harness is asked for, because the Claude
 * Code loop announces itself in every request and Google refuses on that announcement. Reading it rather than
 * hard-coding it means this walk needs no opinion about Google at all, and that when another provider ends up
 * native-only, this seam is already right. */
const askRung = async (services: Services, choice: QuickModelChoice, prompt: string, signal: AbortSignal): Promise<string> => {
    if (capabilitiesOf(choice.provider, `claude-code`).runtime === `opencode-gemini`) {
        return runGeminiOneShot({ services, prompt, cwd: services.workspace.root, model: choice.model, signal });
    }
    const resolved = await resolveHarnessCredentials(services, { agent: choice.provider, model: choice.model });
    if (!resolved.ok) {
        throw new Error(resolved.message);
    }
    return runOneShot({ prompt, cwd: services.workspace.root, model: choice.model, credentials: resolved.credentials, signal });
};

/* RUN ONE PROMPT ON THE SANDBOX'S QUICK MODEL, WALKING DOWN THE CHAIN UNTIL ONE ANSWERS. The single seam every
 * one-click helper goes through, so they all spend the same rungs, in the same order, and all name what they
 * spent the same way.
 *
 * EVERY REFUSAL IS WORTH STEPPING OVER, and the walk deliberately does not try to sort them. A spent allowance
 * is the case the chain exists for, but a revoked token, a provider having an outage and a translator that
 * cannot route this model all leave the user in exactly the same place, nothing written, no reason given,
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
    const skipped: QuickModelRefusal[] = [];
    /* WHY THIS RUNG IS NOT WORTH ASKING, in the words the user will read, or undefined, which means ask it.
     *
     * Two sources, cheapest first. The MEMO is what this rung said last time it was asked, and costs a map
     * lookup. The READING is what every account of that provider has left and when it renews (quick-model-quota
     * .ts), and costs a local call, so it is consulted only for the rungs the walk actually reaches, never for
     * the ones below the one that answers.
     *
     * They are ordered by cost rather than by authority because they rarely disagree, and where they do the
     * answer is the same either way: step over it. */
    const stepOverReason = async (choice: QuickModelChoice): Promise<string | undefined> =>
        cooling(choice, now) ?? (await spentRung(services, choice, now))?.reason;
    /* ONE PASS OVER THE CHAIN. `honourSkips` is what separates the two it may take, see below.
     *
     * `asked` is the fact the caller needs and the answer cannot carry: a walk that skipped every rung and a
     * walk that asked every rung and was refused by all of them both end with no text, and they call for
     * opposite things next. */
    const walk = async (honourSkips: boolean): Promise<{ answer?: QuickModelAnswer; asked: boolean }> => {
        // The timeline is rebuilt, not appended to: a second pass is a RETRACTION of the first's skips, and
        // showing both would report every rung twice, once stepped over, once asked, for one walk.
        attempts.length = 0;
        skipped.length = 0;
        let asked = false;
        for (const choice of chain) {
            // Stepped over without being asked, and reported in the words that stood in the way, so `skipped`
            // stays the honest account of what the caller's answer cost, rather than going quiet about the
            // accounts this walk never touched.
            const stepOver = honourSkips ? await stepOverReason(choice) : undefined;
            if (stepOver !== undefined) {
                skipped.push({ choice, reason: stepOver });
                attempts.push({ choice, status: `skipped`, reason: stepOver });
                tell();
                continue;
            }
            asked = true;
            /* EVERY RUNG IS TIMED, answered or refused, and named as it is spent. The call as a whole was already
             * measured by its caller (landing.subject and its siblings), and that number cannot say the one thing
             * worth knowing when a helper turns slow: WHICH model took the time. Finding that out meant watching
             * the CLI processes by hand. One record per attempt makes the next occurrence self-evident, and the
             * memo's effect legible too, a rung that stops appearing is one the walk has stopped paying for. */
            const from = Date.now();
            const spent = (): number => Date.now() - from;
            const key = quickModelKey(choice);
            // In flight, said before the wait rather than after: "asking X" during the seconds X is taking is the
            // one line of this report that answers a user staring at it right now.
            attempts.push({ choice, status: `asking`, at: from });
            tell();
            // The in-flight entry settles in place, the walk's list is a timeline, and one rung is one entry.
            const settle = (attempt: QuickModelAttempt): void => {
                attempts[attempts.length - 1] = attempt;
                tell();
            };
            try {
                // Inside the try with the call itself: a credential that fails on the way in (a token that no
                // longer refreshes passes the cheap readiness check but fails resolution) is the same kind of
                // dead end as one that fails on the way out, and the next model in the chain answers both.
                const text = await askRung(services, choice, prompt, signal);
                // It answered, so whatever it last refused for is over, a memo outliving the condition it
                // describes would keep steering work off an account that is plainly working again.
                refusals.delete(key);
                services.perf.record("quick.model", spent(), { provider: choice.provider, model: choice.model });
                settle({ choice, status: `answered`, at: from, ms: spent() });
                return { answer: { text, choice, skipped }, asked };
            } catch (error) {
                if (signal.aborted) {
                    // The user's own cancel is not the model's failure, so it earns no memo: the next call must
                    // ask this rung as if nothing had happened, because nothing about it did.
                    throw error;
                }
                services.perf.record("quick.model", spent(), { provider: choice.provider, model: choice.model }, true);
                refusals.set(key, { until: Date.now() + REFUSED_FOR_MS, reason: refusalText(error) });
                services.logger.debug({ err: error, model: choice.model }, "quick model: refused, trying the next in the chain");
                skipped.push({ choice, reason: refusalText(error) });
                settle({ choice, status: `refused`, at: from, ms: spent(), reason: refusalText(error) });
            }
        }
        return { asked };
    };

    const walked = await walk(true);
    if (walked.answer !== undefined) {
        return walked.answer;
    }
    /* WHAT IS ON FILE MAY NEVER EMPTY THE CHAIN. Every rung stepped over and NOTHING asked is the one outcome
     * the walk above is not allowed to end on: both of its sources are shortcuts, and a shortcut that can stand
     * between the user and every account they have turns a slow feature into a dead one, the same failure they
     * were added to prevent, arriving from the other side. A memo can go stale; a quota snapshot can be minutes
     * behind a window that has since reopened, or measure a pool the vendor has quietly renamed.
     *
     * So the second pass retracts them both and asks everything. It costs a full walk exactly when a full walk
     * was going to be needed anyway, and it is the reason neither source has to be individually trustworthy. */
    if (!walked.asked) {
        const everything = await walk(false);
        if (everything.answer !== undefined) {
            return everything.answer;
        }
    }
    throw new Error(skipped.map((refusal) => `${refusal.choice.model}: ${refusal.reason}`).join(`; `));
};
