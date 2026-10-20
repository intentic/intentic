/* AI ASSISTANTS AND CRAWLERS READING THE SITE (2026-10-19).

   The browser half of the counter (visit.ts) never sees a model's fetcher, which runs no JavaScript. So the Worker
   notes, on its own side, when a page, a Markdown mirror, llms.txt or robots.txt is fetched by a known AI user agent,
   and sends PostHog one `site_ai_fetch` event naming the agent, the path and the status. A `*-User` agent is an
   assistant reading a page to answer someone right now; a `*SearchBot` builds an answer engine's index; the rest
   gather training data. Why this is worth counting: docs/marketing/llm-recommendation-factors.md.

   Bots are not people: the event carries no address and no person profile. A user agent can be faked, so
   `verified_bot_category` carries Cloudflare's own verdict when the request has one. */

import type { WireEnv } from "./site-wire";

// First match wins. Each vendor's agents run from answer time, to index, to training data.
const AGENTS: readonly (readonly [string, RegExp])[] = [
    ["ChatGPT-User", /ChatGPT-User/iu],
    ["OAI-SearchBot", /OAI-SearchBot/iu],
    ["GPTBot", /GPTBot/iu],
    ["Claude-User", /Claude-User/iu],
    ["Claude-SearchBot", /Claude-SearchBot/iu],
    ["ClaudeBot", /ClaudeBot/iu],
    ["Claude-Code", /claude-code/iu],
    ["Perplexity-User", /Perplexity-User/iu],
    ["PerplexityBot", /PerplexityBot/iu],
    ["MistralAI-User", /MistralAI-User/iu],
    ["DuckAssistBot", /DuckAssistBot/iu],
    ["meta-externalagent", /meta-external(agent|fetcher)/iu],
    ["Amazonbot", /Amazonbot/iu],
    ["Bytespider", /Bytespider/iu],
    ["CCBot", /CCBot/iu],
];

/** The AI agent a user agent names, or undefined for anything else (browsers, search engines, other bots). */
export const aiAgentOf = (userAgent: string): string | undefined => AGENTS.find(([, pattern]) => pattern.test(userAgent))?.[0];

export type FetchKind = "page" | "markdown" | "llms" | "robots";

/** What kind of reading a path is, or undefined for assets and anything else not worth a count. */
export const fetchKindOf = (pathname: string): FetchKind | undefined => {
    if (/^\/llms(-index|-full)?\.txt$/u.test(pathname)) {
        return "llms";
    }
    if (pathname === "/robots.txt") {
        return "robots";
    }
    if (pathname.endsWith(".md")) {
        return "markdown";
    }
    // Pages are slashed (trailingSlash: "always"); a bare path is a page about to be redirected to its slashed form.
    return pathname.endsWith("/") || !/\.[a-z0-9]+$/iu.test(pathname) ? "page" : undefined;
};

export interface AiFetch {
    readonly agent: string;
    readonly kind: FetchKind;
    readonly path: string;
    readonly status: number;
    readonly verifiedBotCategory: string | undefined;
}

interface AiFetchProperties {
    readonly $lib: "intentic-site";
    readonly $process_person_profile: false;
    readonly $geoip_disable: true;
    readonly $host: string;
    readonly $current_url: string;
    readonly $pathname: string;
    readonly agent: string;
    readonly kind: FetchKind;
    readonly status: number;
    verified_bot_category?: string;
}

/** PostHog's batch body for one fetch: the agent is the distinct id, so each one counts as a single "visitor". */
export const aiFetchBatch = (key: string, siteOrigin: string, fetched: AiFetch, now: Date) => {
    const properties: AiFetchProperties = {
        $lib: "intentic-site",
        $process_person_profile: false,
        $geoip_disable: true,
        $host: new URL(siteOrigin).host,
        $current_url: `${siteOrigin}${fetched.path}`,
        $pathname: fetched.path,
        agent: fetched.agent,
        kind: fetched.kind,
        status: fetched.status,
    };
    if (fetched.verifiedBotCategory !== undefined) {
        properties.verified_bot_category = fetched.verifiedBotCategory;
    }
    return { api_key: key, batch: [{ event: "site_ai_fetch", distinct_id: `ai-${fetched.agent}`, timestamp: now.toISOString(), properties }] };
};

/**
 * The fetch to count, or undefined when it is not an AI agent reading something. The Worker passes Cloudflare's
 * verified-bot category in, since `request.cf` exists only there.
 */
export const aiFetchOf = (userAgent: string, pathname: string, status: number, verifiedBotCategory: string | undefined): AiFetch | undefined => {
    const agent = aiAgentOf(userAgent);
    const kind = fetchKindOf(pathname);
    if (agent === undefined || kind === undefined) {
        return undefined;
    }
    return { agent, kind, path: pathname.slice(0, 300), status, verifiedBotCategory: verifiedBotCategory === "" ? undefined : verifiedBotCategory };
};

/** Sends one count; never throws, since a PostHog outage costs a count, never the page. */
export const sendAiFetch = async (env: WireEnv, siteOrigin: string, fetched: AiFetch, now: Date = new Date()): Promise<void> => {
    if (env.POSTHOG_KEY === undefined || env.POSTHOG_KEY === "") {
        return;
    }
    const host = env.POSTHOG_HOST ?? "https://us.i.posthog.com";
    try {
        await fetch(`${host}/batch/`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(aiFetchBatch(env.POSTHOG_KEY, siteOrigin, fetched, now)),
        });
    } catch {
        // allow(silent-catch): a PostHog outage costs a count, never the page.
    }
};
