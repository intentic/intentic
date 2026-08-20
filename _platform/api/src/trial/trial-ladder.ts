import type { Config } from "../config.js";
import { listed, type TrialPool } from "./trial-pool.js";

/* WHICH REAL MODELS A TRIAL MESSAGE MAY LAND ON, in the order they are tried.
 *
 * The trial publishes ONE id (`TRIAL_MODEL_ID`) and picks the model behind it here. That inverts what this
 * module used to be: the old code discovered the upstream's catalog, filtered it, and published the survivors as
 * picker rows. Discovery cannot carry that weight. Google's own listing declares `generateContent` for models
 * that will not serve an agent turn — `deep-research-*` wants a different API, `gemma-*` has no tool calling,
 * `lyria-*` writes music, `antigravity-*` and the computer-use and robotics previews answer "This model only
 * supports Interactions API" — so every one of them passed the capability check, sorted to the head of an
 * id-derived ordering that had never heard of them, and became the model a fresh conversation sent its first
 * message to. A filter cannot fix a list whose entries lie about themselves.
 *
 * So the ladder is CURATED, and discovery is demoted to a veto. We name the families we are willing to spend a
 * user's first impression on; the upstream may only remove from that list, never add to it. An id we have never
 * heard of cannot reach a user by appearing in a catalog. */

/* ALIASES, NOT PINS — the same reason the old floor gave, and it still holds. A pinned id is retired out from
 * under a free key (`gemini-2.5-flash` now answers "no longer available to new users") and a list of pins would
 * need re-shipping to notice; Google repoints `-latest` itself.
 *
 * Flash first because it is the only tier Google's free key serves with real quota — Pro is refused outright, so
 * a Pro rung would be one that only ever 429s and then costs every user the latency of discovering that. Lite
 * second: it is the fallback that still answers when Flash's per-minute window is spent, which on a shared pool
 * is often. Order is preference, and the walk below takes the first rung that answers.
 *
 * These name the DEFAULT upstream. An operator who repoints TRIAL_BASE_URL elsewhere names their own ids in
 * TRIAL_MODELS, which replaces this list wholesale. */
const TRIAL_LADDER: readonly string[] = [`gemini-flash-latest`, `gemini-flash-lite-latest`];

/* WHERE THE UPSTREAM SAYS WHAT EACH MODEL CAN DO — the one question its OpenAI-compatible surface cannot answer.
 *
 * `/v1beta/openai/models` publishes bare ids. Google's OWN listing beside it carries
 * `supportedGenerationMethods`, and `generateContent` is the capability a chat spends. It sits one path segment
 * up from the compatibility shim, so it is derived rather than configured — an upstream that is not Google has
 * no such surface, answers nothing, and the ladder stands unchecked, which is correct: these are ids we chose,
 * not ids we found, and refusing to serve them because a listing endpoint is missing would disable the trial
 * over a surface it does not need.
 *
 * `pageSize` is not a nicety: this surface pages at 50 by default where the shim beside it returns everything,
 * and a key already listing 54 models would have had four of them silently read as "cannot chat". 1000 is the
 * documented maximum and leaves no second page to forget about. */
export const nativeModelsUrl = (config: Config): string | undefined => {
    const compat = config.trial.baseUrl.replace(/\/+$/, ``);
    return compat.endsWith(`/openai`) ? `${compat.slice(0, -`/openai`.length)}/models?pageSize=1000` : undefined;
};

// Google addresses a model as `models/<id>` on both of its listing surfaces; the harness addresses the bare id.
const bareId = (name: unknown): string | undefined => (typeof name === `string` ? name.replace(/^models\//, ``) : undefined);

/* The ids the upstream says it can generate with. `undefined` means it would not say — no such surface,
 * unreachable, or a shape we do not recognise — which is NOT the same as "none of them", and the caller treats
 * the two oppositely: unknown leaves the ladder alone, while a known set removes the rungs missing from it. */
const chatCapableIds = async (config: Config, pool: TrialPool): Promise<Set<string> | undefined> => {
    const url = nativeModelsUrl(config);
    if (url === undefined) {
        return undefined;
    }
    const attempt = await pool.call(``, { method: `GET`, url, auth: `goog` });
    if (attempt?.response.ok !== true) {
        return undefined;
    }
    const body = (await attempt.response.json().catch(() => undefined)) as
        { models?: { name?: unknown; supportedGenerationMethods?: unknown }[] } | undefined;
    if (!Array.isArray(body?.models)) {
        return undefined;
    }
    const capable = new Set<string>();
    for (const model of body.models) {
        const id = bareId(model.name);
        const methods = model.supportedGenerationMethods;
        if (id !== undefined && Array.isArray(methods) && methods.includes(`generateContent`)) {
            capable.add(id);
        }
    }
    // An answer that named nothing chat-capable is as uninformative as no answer: it can only mean the shape
    // moved under us, since a key that serves this trial demonstrably serves generateContent.
    return capable.size > 0 ? capable : undefined;
};

// The ids an operator narrowed the trial to, or an empty list meaning "use the curated ladder". Parsed by the
// pool's own operator-list reader, which is where the `#`-comment rule that both settings need already lives.
const trialModels = (config: Config): string[] => listed(config.trial.models);

// How long a capability answer is trusted. Long enough that a chat completion almost never pays for a catalog
// read, short enough that a model retired mid-day stops being offered within the hour.
const CAPABILITY_TTL_MS = 5 * 60_000;

export interface TrialLadder {
    // The models to try, in preference order. NEVER empty: a ladder with nothing on it is a trial that cannot
    // answer, and every rung of the fallback below exists so that state is unreachable.
    readonly candidates: () => Promise<readonly string[]>;
}

/* The live ladder for one route instance — cached beside the pool it asks, for the same reason the pool's own
 * rotation is per-instance: a test app gets an independent view of its own upstream.
 *
 * THE CAPABILITY READ NEVER BLOCKS A MESSAGE, and that is a correctness property rather than a tuning choice.
 * It goes through the same key pool as a chat, so a listing endpoint that has gone dark costs a walk of every
 * key at the attempt timeout — around sixteen seconds on a two-key pool — BEFORE the user's message is even
 * sent. Paying that on one message every five minutes, to apply a veto over a list we already trust, is a
 * terrible trade. So a stale cache refreshes in the BACKGROUND and the caller is answered from what is known
 * now: the unfiltered ladder on a cold start, the last confirmed set after that. The veto lands a few seconds
 * late and nobody waits for it.
 *
 * `inFlight` is what keeps a burst of messages from starting a read each. A failed read caches `undefined` like
 * any other answer — an upstream that will not talk should be asked again on the timer, not on every turn. */
export const createTrialLadder = (config: Config, pool: TrialPool, now: () => number = Date.now): TrialLadder => {
    let capable: { value: Set<string> | undefined; expiresAt: number } | undefined;
    let inFlight = false;

    const refresh = (): void => {
        if (inFlight) {
            return;
        }
        inFlight = true;
        void chatCapableIds(config, pool)
            .then((value) => {
                capable = { value, expiresAt: now() + CAPABILITY_TTL_MS };
            })
            .catch(() => undefined)
            .finally(() => {
                inFlight = false;
            });
    };

    return {
        candidates: async () => {
            /* AN OPERATOR'S LIST IS NOT FILTERED, and that is the difference between narrowing and replacing.
             * TRIAL_MODELS is the setting a platform pointed at a non-Google upstream uses, so its ids are meant
             * to be ones we have never heard of — checking them against Google's vocabulary would reject every
             * one of them. Whoever set it knows their upstream better than a listing endpoint we derive. It also
             * needs no capability read at all, so this returns before one is ever started. */
            const declared = trialModels(config);
            if (declared.length > 0) {
                return declared;
            }
            if (capable === undefined || now() >= capable.expiresAt) {
                refresh();
            }
            const known = capable?.value;
            if (known === undefined) {
                return TRIAL_LADDER;
            }
            const confirmed = TRIAL_LADDER.filter((model) => known.has(model));
            // Every rung retired at once is not a reason to serve nothing: the capability listing and the chat
            // surface are different endpoints, and we would rather send a message to a model we chose and let
            // the upstream refuse it than refuse it ourselves on second-hand information.
            return confirmed.length > 0 ? confirmed : TRIAL_LADDER;
        },
    };
};
