import type { TrialHealth } from "@intentic/sandbox-contract";
import type { Config } from "../config.js";

/* THE POOL OF INTENTIC'S OWN MODEL KEYS, and the rule for picking one that will actually answer.
 *
 * A free tier is sized for one developer. That is the whole problem this module exists for: a single Google AI
 * Studio key is a handful of requests a minute and a few thousand a day, which one launch-day thread exhausts —
 * and the user meets a 429 on the first message of a product they have not decided about yet. So the trial holds
 * several keys and moves to the next when one refuses.
 *
 * FAILOVER IS ON THE RESPONSE. A refusal briefly quarantines that key so the next user does not pay again to
 * rediscover a 401, quota window or dead connection; it is deliberately a cooldown rather than a durable health
 * table, because upstream is still the authority and every key is retried after the condition can have changed.
 * Rotation spreads steady traffic across the healthy pool instead of hammering the first key until it refuses. */

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
const listed = (raw: string): string[] =>
    withoutInlineComment(raw)
        .split(`,`)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ``);

const trialKeys = (config: Config): string[] => listed(config.trial.keys);

// Whether the trial is on at all. Empty keys is the default and the only sane one for a self-hosted platform:
// nothing to spend, so the routes 404 and the daemon provisions no trial endpoint.
export const trialEnabled = (config: Config): boolean => trialKeys(config).length > 0;

// The ids an operator narrowed the trial to, or an empty list meaning "whatever the upstream publishes".
export const trialModels = (config: Config): string[] => listed(config.trial.models);

/* WHERE THE UPSTREAM SAYS WHAT EACH MODEL CAN DO — the one question its OpenAI-compatible surface cannot answer.
 *
 * `/v1beta/openai/models` publishes a bare list of ids: 54 of them on a fresh Google key, and only a third are
 * things a chat can be had with. The rest are Imagen, Veo, Lyria, the embedding and TTS endpoints, the Live and
 * computer-use previews, and models that answer "This model only supports Interactions API" — every one of them
 * a picker row whose first message fails. That is not a list to filter by name: `nano-banana-pro-preview` draws
 * pictures and `antigravity-preview-05-2026` reads like the flagship, and a regex over ids gets both wrong.
 *
 * Google's OWN listing carries `supportedGenerationMethods`, and `generateContent` is exactly the capability
 * the trial spends. It sits one path segment up from the compatibility shim, so it is derived rather than
 * configured — an upstream that is not Google has no such surface, answers nothing, and the catalog falls back
 * to the floor below (trial.routes), which is the same thing the operator's own TRIAL_MODELS does better.
 *
 * `pageSize` is not a nicety: this surface pages at 50 by default where the shim beside it returns everything,
 * and a key already listing 54 models would have had four of them silently read as "cannot chat". 1000 is the
 * documented maximum and leaves no second page to forget about. */
export const nativeModelsUrl = (config: Config): string | undefined => {
    const compat = config.trial.baseUrl.replace(/\/+$/, ``);
    return compat.endsWith(`/openai`) ? `${compat.slice(0, -`/openai`.length)}/models?pageSize=1000` : undefined;
};

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
    // How many keys were tried before this answer. Logged, never returned to the caller: it describes intentic's
    // pool, which is nobody else's business and is exactly the kind of detail that makes a pool worth probing.
    readonly tried: number;
}

export interface TrialServiceStatus {
    readonly health: TrialHealth;
    readonly retryAt?: string;
}

export interface TrialPool {
    readonly call: (
        path: string,
        init: { method: string; body?: string; url?: string; auth?: UpstreamAuth; observeHealth?: boolean },
    ) => Promise<UpstreamAttempt | undefined>;
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

    const orderedKeys = (at: number): string[] => {
        if (keys.length === 0) {
            return [];
        }
        const start = cursor % keys.length;
        cursor = (cursor + 1) % keys.length;
        return [...keys.slice(start), ...keys.slice(0, start)].filter((key) => (quarantine.get(key) ?? 0) <= at);
    };

    const nextRetry = (at: number): number | undefined => {
        const times = keys.map((key) => quarantine.get(key) ?? at).filter((retry) => retry > at);
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

    const call: TrialPool["call"] = async (path, init) => {
        const started = now();
        const deadline = started + POOL_DEADLINE_MS;
        const ordered = orderedKeys(started);
        if (ordered.length === 0) {
            if (init.observeHealth === true) {
                unavailable(started);
            }
            return undefined;
        }
        let last: Response | undefined;
        let tried = 0;
        for (const key of ordered) {
            const remaining = deadline - now();
            if (remaining <= 0) {
                break;
            }
            tried += 1;
            const response = await responseWithin(key, path, init, Math.min(ATTEMPT_TIMEOUT_MS, remaining));
            const at = now();
            if (response === undefined) {
                quarantine.set(key, at + FAILURE_QUARANTINE_MS);
                continue;
            }
            await last?.body?.cancel().catch(() => undefined);
            if (!poolRefused(response.status)) {
                quarantine.delete(key);
                if (init.observeHealth === true) {
                    service = { health: tried === 1 && quarantine.size === 0 ? `healthy` : `degraded` };
                }
                return { response, tried };
            }
            quarantine.set(key, at + (quarantineMs(response, at) ?? FAILURE_QUARANTINE_MS));
            last = response;
        }
        if (init.observeHealth === true) {
            unavailable(now());
        }
        return last === undefined ? undefined : { response: last, tried };
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
