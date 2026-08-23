/* robots.txt, parsed the way Google documents it: rules grouped by user-agent (several agent lines can
 * share one group), the most specific matching rule wins (longest pattern), an allow beats a disallow of
 * equal length, `*` wildcards and `$` end-anchors supported. webq matches the "webq" group when a site
 * writes one and "*" otherwise. Crawl-delay and Sitemap lines are read too — the crawler paces itself with
 * the former (capped: a site asking for a day between requests has said "no", and the cap treats it as a
 * long delay rather than a bypass) and seeds from the latter. */

export interface RobotsRules {
    readonly allows: string[];
    readonly disallows: string[];
    readonly crawlDelayS: number | undefined;
    readonly sitemaps: string[];
}

export const EVERYTHING_ALLOWED: RobotsRules = { allows: [], disallows: [], crawlDelayS: undefined, sitemaps: [] };

const OUR_NAME = "webq";

export const parseRobots = (text: string): RobotsRules => {
    interface Group {
        agents: string[];
        allows: string[];
        disallows: string[];
        crawlDelayS: number | undefined;
    }
    const groups: Group[] = [];
    const sitemaps: string[] = [];
    let current: Group | undefined;
    let openForAgents = false;
    for (const rawLine of text.split("\n")) {
        const line = (rawLine.split("#")[0] ?? "").trim();
        const colon = line.indexOf(":");
        if (colon < 0) {
            continue;
        }
        const field = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (field === "sitemap") {
            sitemaps.push(value);
            continue;
        }
        if (field === "user-agent") {
            if (!openForAgents || current === undefined) {
                current = { agents: [], allows: [], disallows: [], crawlDelayS: undefined };
                groups.push(current);
                openForAgents = true;
            }
            current.agents.push(value.toLowerCase());
            continue;
        }
        openForAgents = false;
        if (current === undefined) {
            continue;
        }
        if (field === "allow") {
            current.allows.push(value);
        } else if (field === "disallow") {
            current.disallows.push(value);
        } else if (field === "crawl-delay") {
            const delay = Number(value);
            current.crawlDelayS = Number.isFinite(delay) ? delay : undefined;
        }
    }
    const named = groups.find((group) => group.agents.some((agent) => OUR_NAME.includes(agent) || agent.includes(OUR_NAME)));
    const wildcard = groups.find((group) => group.agents.includes("*"));
    const chosen = named ?? wildcard;
    return {
        allows: chosen?.allows ?? [],
        disallows: chosen?.disallows ?? [],
        crawlDelayS: chosen?.crawlDelayS,
        sitemaps,
    };
};

export const isAllowed = (rules: RobotsRules, path: string): boolean => {
    const disallow = longestMatch(rules.disallows, path);
    if (disallow === undefined) {
        return true;
    }
    const allow = longestMatch(rules.allows, path);
    // Ties go to allow, per the spec's "least restrictive" rule.
    return allow !== undefined && allow >= disallow;
};

/** Length of the longest pattern in `patterns` matching `path`, or undefined when none match. */
const longestMatch = (patterns: string[], path: string): number | undefined => {
    let longest: number | undefined;
    for (const pattern of patterns) {
        if (pattern === "") {
            continue;
        }
        if (matches(pattern, path) && (longest === undefined || pattern.length > longest)) {
            longest = pattern.length;
        }
    }
    return longest;
};

const matches = (pattern: string, path: string): boolean => {
    const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    const anchored = escaped.endsWith("$") ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
    try {
        return new RegExp(anchored).test(path);
    } catch {
        return false;
    }
};
