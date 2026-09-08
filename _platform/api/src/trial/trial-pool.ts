import type { TrialHealth } from "@intentic/sandbox-contract";
import type { Config } from "../config.js";

// Pool of intentic's own model keys, since a single free-tier key exhausts in minutes. A refusal quarantines just the
// (key, model) pair it was observed on, not the whole key, since quota is metered per model upstream too; rotation
// spreads traffic across the healthy pool.

// True for a status worth trying the next key on (401/403/429/5xx); anything else is about this request and fails
// identically everywhere. Read again after the walk to tell whether nobody served the message, so it isn't billed.
export const poolRefused = (status: number): boolean => status === 401 || status === 403 || status === 429 || status >= 500;

// Strips a trailing `# comment`: a dotenv loader keeps everything after `=`, but a compose/Komodo/`export` value never
// passes a dotenv parser, so the comment must be stripped here. A comment-only value reads as empty.
const withoutInlineComment = (raw: string): string => {
    const text = raw.trimStart();
    if (text.startsWith(`#`)) {
        return ``;
    }
    const comment = text.search(/\s#/);
    return comment === -1 ? text : text.slice(0, comment);
};

// Comma-separated list with no spaces in an entry; exported since TRIAL_MODELS must parse identically.
export const listed = (raw: string): string[] =>
    withoutInlineComment(raw)
        .split(`,`)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ``);

const trialKeys = (config: Config): string[] => listed(config.trial.keys);

// Empty keys is the correct off-state for self-hosting: nothing to spend, so the trial just 404s.
export const trialEnabled = (config: Config): boolean => trialKeys(config).length > 0;

export type Fetcher = typeof fetch;

// The compatibility shim wants `Authorization: Bearer`; Google's own surface rejects a bearer outright (401) and wants
// `x-goog-api-key` instead. Sending both doesn't help — the bearer wins.
export type UpstreamAuth = "bearer" | "goog";

const authHeaders = (auth: UpstreamAuth, key: string): Record<string, string> =>
    auth === `goog` ? { "x-goog-api-key": key } : { authorization: `Bearer ${key}` };

export interface UpstreamAttempt {
    readonly response: Response;
    // How many (key, model) pairs were tried; logged only, never returned to the caller.
    readonly tried: number;
    // Which model answered; the one walk detail the caller gets. Undefined for a request with no model dimension.
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
    // Candidate models in preference order, each its own quota bucket upstream; omitted with no model dimension.
    readonly models?: readonly string[];
    // Request body for a given candidate, called once per attempt; absent on a GET.
    readonly body?: (model: string | undefined) => string;
}

export interface TrialPool {
    readonly call: (path: string, init: TrialCall) => Promise<UpstreamAttempt | undefined>;
    readonly status: () => TrialServiceStatus;
}

// Attempt timeout covers response headers only: past any healthy answer, but short enough to abandon a hung one while
// the user waits. The pool deadline spans the whole walk, so a dead first rung can't consume the fallback's chance to
// answer.
const ATTEMPT_TIMEOUT_MS = 20_000;
const POOL_DEADLINE_MS = 60_000;
const AUTH_QUARANTINE_MS = 5 * 60_000;
const QUOTA_QUARANTINE_MS = 30_000;
const FAILURE_QUARANTINE_MS = 10_000;
// A timeout, unlike a refusal, is evidence about the model itself, not the key: it hangs identically everywhere, so the
// first one cools the whole model instead of being rediscovered per credential. A demotion, not a verdict; one answer
// restores it.
const MODEL_COOLDOWN_MS = 5 * 60_000;

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

// Quarantine keys on (key, model): Google meters each model separately, so a 429 on one model says nothing about
// another, and sidelining the whole key would waste a credential the fallback rung could still use.
const bucket = (key: string, model: string | undefined): string => `${key}\u0000${model ?? ``}`;

// Rotation, quarantine and health live on the route instance, so each app gets an independent view of its own keys. The
// timeout covers response headers only; once fetch resolves, a healthy streamed body is left to run.
export const createTrialPool = (config: Config, fetchFn: Fetcher, now: () => number = Date.now): TrialPool => {
    const keys = trialKeys(config);
    const quarantine = new Map<string, number>();
    // Rungs that answered nothing, by model; separate from quarantine, since only this is inferred from silence.
    const cooling = new Map<string, number>();
    let cursor = 0;
    let service: { health: TrialHealth; retryAt?: number } = { health: `unknown` };

    // One rotation per call, reused across every rung, or the cursor would advance once per rung and favor whichever
    // key the last model landed on.
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

    // A rung still cooling is skipped entirely: no key on it is worth the wait.
    const servable = (model: string | undefined, at: number): boolean => model === undefined || (cooling.get(model) ?? 0) <= at;

    // Expired quarantine/cooldown entries are deleted here, where every reader (health, retry, status) passes: leaving
    // them would turn one past refusal into a "degraded" reading nothing but a restart clears.
    const liveRetries = (at: number): readonly number[] => {
        const times: number[] = [];
        for (const sidelines of [quarantine, cooling]) {
            for (const [entry, retry] of sidelines) {
                if (retry <= at) {
                    sidelines.delete(entry);
                    continue;
                }
                times.push(retry);
            }
        }
        return times;
    };

    const nextRetry = (at: number): number | undefined => {
        const times = liveRetries(at);
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

    // Walks every candidate model (outer loop, so the ladder's preference order holds — no interleaving) and within
    // each, its healthy keys, under one deadline for the whole walk so a dead first rung can't starve the fallback.
    const call: TrialPool["call"] = async (path, init) => {
        const started = now();
        const deadline = started + POOL_DEADLINE_MS;
        const rotation = rotatedKeys();
        // A request with no model dimension is one rung whose model is `undefined`: same walk, one bucket.
        const candidates: readonly (string | undefined)[] = init.models === undefined || init.models.length === 0 ? [undefined] : init.models;
        let last: Response | undefined;
        let lastModel: string | undefined;
        let tried = 0;
        // If every rung is cooling, the cooldowns are dropped for this walk: refusing outright would turn one bad
        // minute into an instant failure for everyone.
        const warm = candidates.filter((model) => servable(model, started));
        // Judged per walk, not from the maps' overall contents: those also hold entries this request never needed (the
        // ladder's own capability listing rides this pool too), which would read as chat being unwell when it answered
        // on the first try.
        let obstructed = warm.length !== candidates.length;
        for (const model of warm.length > 0 ? warm : candidates) {
            // `now()`, not the walk's start: a rung this loop just sidelined must stay sidelined for the rest of it.
            const usable = healthyKeys(rotation, model, now());
            obstructed = obstructed || usable.length !== rotation.length;
            for (const key of usable) {
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
                // No response before the timer: cools the whole model (timeout is model-wide evidence) and quarantines
                // the pair too, so the rung resumes on a key that hasn't just failed.
                if (response === undefined) {
                    quarantine.set(bucket(key, model), at + FAILURE_QUARANTINE_MS);
                    if (model !== undefined) {
                        cooling.set(model, at + MODEL_COOLDOWN_MS);
                        break;
                    }
                    continue;
                }
                await last?.body?.cancel().catch(() => undefined);
                if (!poolRefused(response.status)) {
                    quarantine.delete(bucket(key, model));
                    // A rung that just answered isn't cooling, whatever an earlier walk concluded.
                    if (model !== undefined) {
                        cooling.delete(model);
                    }
                    // Healthy means nothing was in the way: the first attempt answered with nothing stepped over.
                    // Degraded means it answered, but only after working for it.
                    if (init.observeHealth === true) {
                        service = { health: tried === 1 && !obstructed ? `healthy` : `degraded` };
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
            const sidelined = liveRetries(at).length;
            if (service.health === `unavailable` && service.retryAt !== undefined && service.retryAt <= at) {
                service = { health: `unknown` };
            }
            // Degraded expires with its cause: once nothing is sitting out a window, the last thing the pool did was
            // answer, so it reads as healthy again rather than outliving the refusal for hours.
            if (service.health === `degraded` && sidelined === 0) {
                service = { health: `healthy` };
            }
            return {
                health: service.health,
                ...(service.retryAt === undefined ? {} : { retryAt: new Date(service.retryAt).toISOString() }),
            };
        },
    };
};
