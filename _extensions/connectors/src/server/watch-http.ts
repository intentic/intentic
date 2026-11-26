import { errorMessage } from "@intentic/base/errors";

// One request of a watch's check: bounded, named, and its unread body released when it is refused, since a check reads
// a refusal by its status alone. What the npm and GitHub release checks share (npm-registry.ts, github-releases.ts).

export type CheckFetch = (url: string, init: RequestInit) => Promise<Response>;

// One request may take this long before the check reads as not passing; the daemon gives a whole check a minute.
const FETCH_TIMEOUT_MS = 20_000;
const USER_AGENT = "intentic-sandbox-watch";

// The answer, or what stood in the way, in a sentence the automation's run history shows.
export type Fetched = { readonly response: Response } | { readonly unreachable: string };

export const timedFetch = async (fetch: CheckFetch, url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Fetched> => {
    try {
        const deadline = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT, ...headers },
            signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
        });
        if (!response.ok) {
            // allow(silent-catch): cancelling cannot change the HTTP refusal the check already received.
            await response.body?.cancel().catch(() => undefined);
        }
        return { response };
    } catch (error) {
        return { unreachable: `could not reach ${new URL(url).host}: ${errorMessage(error)}` };
    }
};
