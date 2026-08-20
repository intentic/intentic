import type { TrialHealth } from "@intentic/sandbox-contract";
import type { Config } from "../config.js";

/* THE POOL OF INTENTIC'S OWN MODEL KEYS, and the rule for picking one that will actually answer.
 *
 * A free tier is sized for one developer. That is the whole problem this module exists for: a single Google AI
 * Studio key is a handful of requests a minute and a few thousand a day, which one launch-day thread exhausts —
 * and the user meets a 429 on the first message of a product they have not decided about yet. So the trial holds
 * several keys and moves to the next when one refuses.
 *
 * FAILOVER IS ON THE RESPONSE. A refusal briefly quarantines the (key, model) pair it was observed on, so the
 * next user does not pay again to rediscover a 401, quota window or dead connection; it is deliberately a
 * cooldown rather than a durable health table, because upstream is still the authority and every pair is retried
 * after the condition can have changed. Rotation spreads steady traffic across the healthy pool instead of
 * hammering the first key until it refuses.
 *
 * THE SECOND DIMENSION IS THE MODEL, and it is what makes the trial's single published id work. A caller hands
 * this pool a LADDER of models (trial-ladder.ts) rather than one, and the walk takes the first rung that
 * answers — so a Flash quota window that has closed costs a user the latency of one refusal rather than their
 * message. Quotas are metered per model upstream, so the two dimensions are genuinely independent and the
 * quarantine has to be keyed on both; see `bucket` below for what sidelining a whole key would have cost. */

/* A response worth trying the NEXT key for: a key the upstream rejects (401/403), quota refusals (429), and the
 * upstream's own failures (5xx). Anything else — a malformed request, an unsupported model, a rejected prompt —
 * is about THIS request and would be refused identically by every key in the pool, so it comes back as-is rather
 * than burning the whole pool.
 *
 * Read after the pool has been walked, the same predicate answers a second question the caller needs: whether
 * NOBODY served the message. That is why it is exported — the allowance must not be spent on a turn the pool
 * refused, and a user meeting intentic's quota ceiling has done nothing to be billed for. */
export const poolRefused = (status: number): boolean => status === 401 || status === 403 || status === 429 || status >= 500;

/* AN INLINE `#` COMMENT IS NOT PART OF THE VALUE, which the two settings below have to say themselves.
 *
 * TRIAL_MODELS reached a real deployment as the entire line an operator had been handed to paste — value,
 * padding and trailing note — and the picker showed `# optional allowlist; empty = whatever upstream serves`
 * as the name of the trial's only model: a row naming nothing, which no upstream would answer for. The env
 * file format has always meant that text as a comment, and it survives anyway, from both ends. The loader we
 * read `.env` through keeps everything after the `=` (its own document parser, used for editing and codegen,
 * drops the comment — this is the seam between them); and a value arriving through a compose `environment:`
 * block, a Komodo stack or a plain `export` never passes a dotenv parser at all.
 *
 * So it comes off here, at the one place operator text turns into ids and credentials we act on. A value that
 * is NOTHING but a comment reads as empty, which is what whoever pasted the line meant by it: blank is the
 * default for both settings, and each already knows what to do with it. */
const withoutInlineComment = (raw: string): string => {
    const text = raw.trimStart();
    if (text.startsWith(`#`)) {
        return ``;
    }
    const comment = text.search(/\s#/);
    return comment === -1 ? text : text.slice(0, comment);
};

// Both settings are comma-separated lists of things that cannot contain a space, so they read the same way.
// Exported for the ladder's TRIAL_MODELS, which is the other one and must read it identically.
export const listed = (raw: string): string[] =>
    withoutInlineComment(raw)
        .split(`,`)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ``);

const trialKeys = (config: Config): string[] => listed(config.trial.keys);

// Whether the trial is on at all. Empty keys is the default and the only sane one for a self-hosted platform:
// nothing to spend, so the routes 404 and the daemon provisions no trial endpoint.
export const trialEnabled = (config: Config): boolean => trialKeys(config).length > 0;

export type Fetcher = typeof fetch;

/* HOW THE SAME KEY IS PRESENTED, and why it is a choice rather than a constant.
 *
 * The compatibility shim is OpenAI-shaped and reads an `Authorization: Bearer`. Google's OWN surface beside it
 * does not: handed a bearer it stops looking for an API key at all and answers 401 "Expected OAuth 2 access
 * token", which is the wrong answer to the right credential. Sending both headers does not paper over it — the
 * bearer wins and the 401 stands — so each surface is asked in its own dialect. */
export type UpstreamAuth = "bearer" | "goog";

const authHeaders = (auth: UpstreamAuth, key: string): Record<string, string> =>
    auth === `goog` ? { "x-goog-api-key": key } : { authorization: `Bearer ${key}` };

export interface UpstreamAttempt {
    readonly response: Response;
    // How many (key, model) pairs were tried before this answer. Logged, never returned to the caller: it
    // describes intentic's pool, which is nobody else's business and is exactly the kind of detail that makes a
    // pool worth probing.
    readonly tried: number;
    // Which model answered — the one fact about the walk the caller DOES get, because the user is entitled to
    // know what wrote their message back. Undefined for a request with no model dimension (the catalog reads).
    readonly model?: string;
}

export interface TrialServiceStatus {
    readonly health: TrialHealth;
    readonly retryAt?: string;
}

export interface TrialCall {
    readonly method: string;
    readonly url?: string;
    readonly auth?: UpstreamAuth;
    readonly observeHealth?: boolean;
    /* The candidate models, in preference order — each its own quota bucket upstream, and therefore its own
     * rung of the walk. Omitted (or empty) for a request with no model dimension, which is one attempt set
     * against the keys alone. */
    readonly models?: readonly string[];
    // The request body for a given candidate, called once per attempt. Absent on a GET.
    readonly body?: (model: string | undefined) => string;
}

export interface TrialPool {
    readonly call: (path: string, init: TrialCall) => Promise<UpstreamAttempt | undefined>;
    readonly status: () => TrialServiceStatus;
}

// The pool is allowed several short attempts, but one bad upstream may not hold a trial turn open indefinitely.
const ATTEMPT_TIMEOUT_MS = 8_000;
const POOL_DEADLINE_MS = 20_000;
const AUTH_QUARANTINE_MS = 5 * 60_000;
const QUOTA_QUARANTINE_MS = 30_000;
const FAILURE_QUARANTINE_MS = 10_000;

const retryAfterMs = (response: Response, now: number): number | undefined => {
    const value = response.headers.get(`retry-after`)?.trim();
    if (value === undefined || value === ``) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1_000;
    }
    const at = Date.parse(value);
    return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

const quarantineMs = (response: Response, now: number): number | undefined => {
    if (response.status === 401 || response.status === 403) {
        return AUTH_QUARANTINE_MS;
    }
    if (response.status === 429) {
        return retryAfterMs(response, now) ?? QUOTA_QUARANTINE_MS;
    }
    return response.status >= 500 ? FAILURE_QUARANTINE_MS : undefined;
};

/* WHAT A QUARANTINE IS ABOUT — a key AND the model it was refused for, not a key alone.
 *
 * Google meters each model separately per project: a 429 on `gemini-flash-latest` with key A says nothing
 * about `gemini-flash-lite-latest` with key A, and the whole point of a ladder is to reach for the second
 * when the first is spent. Sidelining the key would throw away the one credential that could still answer,
 * and on a pool where every key runs out of Flash at roughly the same time it would take the trial down at
 * exactly the moment the fallback rung existed to save it.
 *
 * A 401/403 is genuinely about the key rather than the model, so it briefly quarantines only the pair it was
 * observed on — the next model retries it, is refused identically, and quarantines that pair too. One
 * wasted attempt per model against a dead key, in exchange for never inferring a model-wide fact from a
 * model-scoped refusal. */
const bucket = (key: string, model: string | undefined): string => `${key} ${model ?? ``}`;

/* One live pool. Its rotation, quarantine and health belong to the route instance rather than to the module: a
 * test app (and any future second platform app in one process) gets an independent view of its own keys.
 *
 * A timeout covers RESPONSE HEADERS only. Once fetch resolves, the timer is cleared and the streamed body is
 * allowed to live for the turn; aborting it on the pool deadline would cut off healthy long responses. */
export const createTrialPool = (config: Config, fetchFn: Fetcher, now: () => number = Date.now): TrialPool => {
    const keys = trialKeys(config);
    const quarantine = new Map<string, number>();
    let cursor = 0;
    let service: { health: TrialHealth; retryAt?: number } = { health: `unknown` };

    // One rotation per call, reused across every rung: asking again per model would advance the cursor once per
    // rung and turn a fair rotation into a walk that favours whichever key the last model happened to stop on.
    const rotatedKeys = (): readonly string[] => {
        if (keys.length === 0) {
            return [];
        }
        const start = cursor % keys.length;
        cursor = (cursor + 1) % keys.length;
        return [...keys.slice(start), ...keys.slice(0, start)];
    };

    const healthyKeys = (rotation: readonly string[], model: string | undefined, at: number): readonly string[] =>
        rotation.filter((key) => (quarantine.get(bucket(key, model)) ?? 0) <= at);

    // Read off the live quarantine rather than recomputed per key, since a bucket is now a pair and the map is
    // the only thing that knows which pairs exist.
    const nextRetry = (at: number): number | undefined => {
        const times = [...quarantine.values()].filter((retry) => retry > at);
        return times.length === 0 ? undefined : Math.min(...times);
    };

    const unavailable = (at: number): void => {
        service = { health: `unavailable`, retryAt: nextRetry(at) ?? at + FAILURE_QUARANTINE_MS };
    };

    const responseWithin = async (
        key: string,
        path: string,
        init: { method: string; body?: string; url?: string; auth?: UpstreamAuth },
        timeoutMs: number,
    ): Promise<Response | undefined> => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => {
                controller.abort();
                resolve(undefined);
            }, timeoutMs);
        });
        const requested = Promise.resolve()
            .then(() =>
                fetchFn(init.url ?? `${config.trial.baseUrl}${path}`, {
                    method: init.method,
                    headers: { ...authHeaders(init.auth ?? `bearer`, key), "content-type": `application/json` },
                    ...(init.body === undefined ? {} : { body: init.body }),
                    signal: controller.signal,
                }),
            )
            .catch(() => undefined);
        try {
            return await Promise.race([requested, expired]);
        } finally {
            clearTimeout(timer);
        }
    };

    /* THE WALK: every candidate model, and within each the healthy keys, under ONE deadline for the whole thing.
     *
     * Models are the OUTER loop because the ladder is a preference: the second rung exists to be reached only
     * when the first cannot answer on any key, and interleaving them would hand a user the fallback model while
     * the one we would rather serve still had a working credential.
     *
     * The deadline spans the entire walk rather than each rung. A caller is waiting on one message, and two
     * rungs of twenty seconds is a forty-second silence that ends in a refusal — worse than the fast refusal it
     * was trying to avoid. Whatever the walk has reached when the clock runs out is what gets answered. */
    const call: TrialPool["call"] = async (path, init) => {
        const started = now();
        const deadline = started + POOL_DEADLINE_MS;
        const rotation = rotatedKeys();
        // A request with no model dimension is one rung whose model is `undefined` — the same walk, one bucket.
        const candidates: readonly (string | undefined)[] = init.models === undefined || init.models.length === 0 ? [undefined] : init.models;
        let last: Response | undefined;
        let lastModel: string | undefined;
        let tried = 0;
        for (const model of candidates) {
            for (const key of healthyKeys(rotation, model, started)) {
                const remaining = deadline - now();
                if (remaining <= 0) {
                    break;
                }
                tried += 1;
                const attempt = {
                    method: init.method,
                    ...(init.url === undefined ? {} : { url: init.url }),
                    ...(init.auth === undefined ? {} : { auth: init.auth }),
                    ...(init.body === undefined ? {} : { body: init.body(model) }),
                };
                const response = await responseWithin(key, path, attempt, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
                const at = now();
                if (response === undefined) {
                    quarantine.set(bucket(key, model), at + FAILURE_QUARANTINE_MS);
                    continue;
                }
                await last?.body?.cancel().catch(() => undefined);
                if (!poolRefused(response.status)) {
                    quarantine.delete(bucket(key, model));
                    if (init.observeHealth === true) {
                        service = { health: tried === 1 && quarantine.size === 0 ? `healthy` : `degraded` };
                    }
                    return { response, tried, ...(model === undefined ? {} : { model }) };
                }
                quarantine.set(bucket(key, model), at + (quarantineMs(response, at) ?? FAILURE_QUARANTINE_MS));
                last = response;
                lastModel = model;
            }
        }
        if (init.observeHealth === true) {
            unavailable(now());
        }
        return last === undefined ? undefined : { response: last, tried, ...(lastModel === undefined ? {} : { model: lastModel }) };
    };

    return {
        call,
        status: () => {
            const at = now();
            if (service.health === `unavailable` && service.retryAt !== undefined && service.retryAt <= at) {
                service = { health: `unknown` };
            }
            return {
                health: service.health,
                ...(service.retryAt === undefined ? {} : { retryAt: new Date(service.retryAt).toISOString() }),
            };
        },
    };
};
