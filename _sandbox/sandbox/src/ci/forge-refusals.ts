import { retryAfterMs } from "@intentic/base/async";
import { z } from "zod";

// HOW A FORGE'S REFUSAL IS READ (providers.ts calls the forge; this says what its "no" meant): a spent rate limit, by
// the headers and the docs link GitHub and GitLab send with one, or any other refusal, carried with its HTTP status so a
// caller branches on the number rather than on the sentence around it (logs/ci-failure-log.ts).

/** The forge refused because the token's API rate limit is spent, not because of anything about the request: nothing
 *  on this account is asked again until `until` (epoch ms). Every caller shares one token with the agents' own `gh`. */
export class CiRateLimited extends Error {
    constructor(
        what: string,
        readonly until: number,
    ) {
        super(`${what} is rate-limited until ${new Date(until).toISOString()}`);
        this.name = "CiRateLimited";
    }
}

/** The forge answered with a refusal other than a spent limit: its HTTP status, and the head of its body for the log. */
export class CiRefused extends Error {
    constructor(
        what: string,
        readonly status: number,
        body: string,
    ) {
        super(`${what} failed (${status}): ${body}`);
        this.name = "CiRefused";
    }
}

// How long to hold off when a forge says its limit is spent but not until when.
const RATE_LIMIT_FALLBACK_MS = 60_000;

// GitHub's refusal body links the docs page of the limit it hit (`…/rate-limits-for-the-rest-api#…`, `…#rate-limiting`
// before that), under the primary limit and the secondary one alike.
const GithubRefusalSchema = z.object({ documentation_url: z.string() });
const linksRateLimitDocs = (body: string): boolean => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        // allow(silent-catch): a body that is not JSON links no docs page; the headers and the words still say it.
        return false;
    }
    const refusal = GithubRefusalSchema.safeParse(parsed);
    return refusal.success && /rate-?limit/i.test(refusal.data.documentation_url);
};

// When a refusal is a spent rate limit, the moment it lifts. GitHub says it with a 403 or a 429: X-RateLimit-Remaining 0
// for the primary limit, Retry-After for the secondary one, and its body's docs link for both; any other 403 is about
// the token or the repository. GitLab says it with a 429 and RateLimit-Reset.
const rateLimitLifts = (response: Response, body: string, now: number): number | undefined => {
    if (response.status !== 403 && response.status !== 429) {
        return undefined;
    }
    const headers = response.headers;
    const retryAfter = headers.get("retry-after");
    if (
        response.status === 403 &&
        (headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining")) !== "0" &&
        retryAfter === null &&
        !linksRateLimitDocs(body) &&
        // allow(dependency-text): GitHub's REST refusal message, the last resort; an unmatched wording is a plain 403, thrown with its status and body.
        !/rate limit|abuse detection/i.test(body)
    ) {
        return undefined;
    }
    const wait = retryAfterMs(retryAfter, { now });
    if (wait !== undefined) {
        return now + wait;
    }
    const reset = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset") ?? Number.NaN);
    return Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + RATE_LIMIT_FALLBACK_MS;
};

const BODY_TAIL = 300;

// A forge answer as a value, or its refusal thrown: a spent limit as CiRateLimited, anything else as CiRefused.
export const throwOn = async (response: Response, what: string): Promise<Response> => {
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const lifts = rateLimitLifts(response, body, Date.now());
        if (lifts !== undefined) {
            throw new CiRateLimited(what, lifts);
        }
        throw new CiRefused(what, response.status, body.slice(0, BODY_TAIL));
    }
    return response;
};
