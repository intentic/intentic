import type { Config } from "../config.js";

/* THE POOL OF INTENTIC'S OWN MODEL KEYS, and the rule for picking one that will actually answer.
 *
 * A free tier is sized for one developer. That is the whole problem this module exists for: a single Google AI
 * Studio key is a handful of requests a minute and a few thousand a day, which one launch-day thread exhausts —
 * and the user meets a 429 on the first message of a product they have not decided about yet. So the trial holds
 * several keys and moves to the next when one refuses.
 *
 * FAILOVER IS ON THE RESPONSE, not on a health table. A key's quota state is upstream's opinion and it changes
 * minute to minute, so anything we cached about it would be wrong by the time we read it; asking is one round
 * trip and it is always right. `keyOrder` supplies the only memory worth having — a rotating start index, so a
 * steady trickle of one-message trials spreads across the pool instead of hammering the first key until it
 * refuses and only then discovering the second. */

/* A response worth trying the NEXT key for: the quota refusals (429) and upstream's own failures (5xx). Anything
 * else — a malformed request, an unsupported model, a rejected prompt — is about THIS request and would be
 * refused identically by every key in the pool, so it comes back as-is rather than burning the whole pool.
 *
 * Read after the pool has been walked, the same predicate answers a second question the caller needs: whether
 * NOBODY served the message. That is why it is exported — the allowance must not be spent on a turn the pool
 * refused, and a user meeting intentic's quota ceiling has done nothing to be billed for. */
export const poolRefused = (status: number): boolean => status === 429 || status >= 500;

const trialKeys = (config: Config): string[] =>
    config.trial.keys
        .split(`,`)
        .map((key) => key.trim())
        .filter((key) => key !== ``);

// Whether the trial is on at all. Empty keys is the default and the only sane one for a self-hosted platform:
// nothing to spend, so the routes 404 and the daemon provisions no trial endpoint.
export const trialEnabled = (config: Config): boolean => trialKeys(config).length > 0;

// The ids an operator narrowed the trial to, or an empty list meaning "whatever the upstream publishes".
export const trialModels = (config: Config): string[] =>
    config.trial.models
        .split(`,`)
        .map((model) => model.trim())
        .filter((model) => model !== ``);

/* THE FLOOR UNDER THE CATALOG, and the reason the trial is offerable at all.
 *
 * Every other catalog in this product ends in a seed list; this one ended in whatever Google felt like
 * publishing, and one day that became nothing. Its OpenAI-compatible `/models` answers a fresh key with an
 * EMPTY list while chat on that same key answers normally — so the trial worked, no request anywhere failed,
 * and every picker showed a "Free trial" group with nothing in it. A feature is not shipped until it cannot be
 * silently emptied by the other end.
 *
 * ALIASES, not versions. A pinned id is retired out from under a free key — `gemini-2.5-flash` now answers
 * "no longer available to new users" — and a list of those would need re-shipping to notice; Google repoints
 * `-latest` itself. Flash only: the free tier serves Pro no quota at all, so a Pro row would be one that only
 * ever 429s. They name the DEFAULT upstream, so an operator who repoints TRIAL_BASE_URL elsewhere should name
 * their own ids in TRIAL_MODELS — those win here whenever they are set. */
const FALLBACK_TRIAL_MODELS: readonly string[] = [`gemini-flash-latest`, `gemini-flash-lite-latest`];

// What the trial offers when discovery publishes nothing it can serve. Never empty, which is the whole point:
// no combination of operator config and upstream silence may leave a user with no model to pick.
export const trialFloorModels = (config: Config): readonly string[] => {
    const declared = trialModels(config);
    return declared.length > 0 ? declared : FALLBACK_TRIAL_MODELS;
};

/* The pool, rotated so consecutive requests start on different keys. Module state rather than per-request,
 * because the whole point is that request N+1 remembers where request N started; a counter is enough — it needs
 * to be fair, not unpredictable. */
let cursor = 0;

const keyOrder = (keys: readonly string[]): string[] => {
    if (keys.length === 0) {
        return [];
    }
    const start = cursor % keys.length;
    cursor = (cursor + 1) % keys.length;
    return [...keys.slice(start), ...keys.slice(0, start)];
};

export type Fetcher = typeof fetch;

export interface UpstreamAttempt {
    readonly response: Response;
    // How many keys were tried before this answer. Logged, never returned to the caller: it describes intentic's
    // pool, which is nobody else's business and is exactly the kind of detail that makes a pool worth probing.
    readonly tried: number;
}

/* Send one request upstream, walking the pool until a key answers something worth returning.
 *
 * The LAST response wins when every key refuses, rather than a synthesized "all keys exhausted": upstream's own
 * 429 carries its own retry hint and its own words, and replacing them with ours would strip the one part of the
 * answer that tells the user when to come back. `body` is a string, not a stream, precisely because it may be
 * sent several times — a request body that can only be read once cannot be retried. */
export const callUpstream = async (
    config: Config,
    fetchFn: Fetcher,
    path: string,
    init: { method: string; body?: string },
): Promise<UpstreamAttempt | undefined> => {
    const keys = keyOrder(trialKeys(config));
    if (keys.length === 0) {
        return undefined;
    }
    let last: Response | undefined;
    let tried = 0;
    for (const key of keys) {
        tried += 1;
        const response = await fetchFn(`${config.trial.baseUrl}${path}`, {
            method: init.method,
            headers: { authorization: `Bearer ${key}`, "content-type": `application/json` },
            ...(init.body === undefined ? {} : { body: init.body }),
        }).catch(() => undefined);
        // A key whose request never completed is indistinguishable from a key that 503'd, and is treated the
        // same: try the next one. If it was the last, the caller gets the previous refusal, or a 502 below.
        if (response === undefined) {
            continue;
        }
        /* Drain the refusal this one supersedes — an unread body holds its connection open for the rest of the
         * pool's walk, which is the one way this loop could turn a slow upstream into a slow platform. Only ever
         * the SUPERSEDED one: the newest refusal is what the caller gets if no key answers, and a body that has
         * already been cancelled is a response that streams nothing. */
        await last?.body?.cancel().catch(() => undefined);
        if (!poolRefused(response.status)) {
            return { response, tried };
        }
        last = response;
    }
    return last === undefined ? undefined : { response: last, tried };
};
