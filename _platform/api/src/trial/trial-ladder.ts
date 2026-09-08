import type { Config } from "../config.js";
import { listed, type TrialPool } from "./trial-pool.js";

// Which real models a trial message may land on, in try order. The trial publishes one id (`TRIAL_MODEL_ID`), picked
// from a curated ladder here; discovery only vetoes rungs it can prove don't work, it never adds new ones.

// Aliases, not pinned ids: a pin gets retired out from under a free key. Flash first (the only tier with real free
// quota), Lite as fallback; TRIAL_MODELS replaces this wholesale for another upstream.
const TRIAL_LADDER: readonly string[] = [`gemini-flash-latest`, `gemini-flash-lite-latest`];

// Derives Google's native listing endpoint, which carries `supportedGenerationMethods` the OpenAI-compatible surface
// lacks; undefined for any other upstream. `pageSize=1000` avoids silent truncation (this surface pages at 50 by
// default).
export const nativeModelsUrl = (config: Config): string | undefined => {
    const compat = config.trial.baseUrl.replace(/\/+$/, ``);
    return compat.endsWith(`/openai`) ? `${compat.slice(0, -`/openai`.length)}/models?pageSize=1000` : undefined;
};

// Google prefixes ids with `models/` on its listing surfaces; the harness uses the bare id.
const bareId = (name: unknown): string | undefined => (typeof name === `string` ? name.replace(/^models\//, ``) : undefined);

// Ids the upstream says it can generate with. `undefined` means it wouldn't say (no surface, unreachable, unrecognized
// shape) — treated oppositely from a known set: unknown leaves the ladder alone, known removes missing rungs.
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
    // Naming nothing chat-capable is as uninformative as no answer; this key demonstrably serves generateContent.
    return capable.size > 0 ? capable : undefined;
};

// Operator's narrowed model list, or empty meaning "use the curated ladder" (pool's own list reader).
const trialModels = (config: Config): string[] => listed(config.trial.models);

// Long enough that a chat rarely pays for a catalog read; short enough a retired model drops within the hour.
const CAPABILITY_TTL_MS = 5 * 60_000;

export interface TrialLadder {
    // Models to try, in order; never empty, since a ladder with nothing on it is a trial that cannot answer.
    readonly candidates: () => Promise<readonly string[]>;
}

// Capability checks never block a message: on a stale or missing answer, the ladder serves unfiltered while a refresh
// happens in the background — walking a dead listing endpoint would otherwise cost seconds before every send.
// `inFlight` dedupes a burst into one read; a failed read caches `undefined` and retries on the timer, not every turn.
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
            // An operator's TRIAL_MODELS list is never filtered against Google's capability list: it's meant for ids we
            // don't recognize on another upstream, and needs no capability read at all.
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
            // If every rung gets vetoed at once, serve the curated ladder anyway: the listing and chat endpoints can
            // disagree, and a wrong veto is worse than letting the upstream itself refuse.
            return confirmed.length > 0 ? confirmed : TRIAL_LADDER;
        },
    };
};
