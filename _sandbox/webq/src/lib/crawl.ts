/* The bounded crawl: a frontier under hard caps, worked by a small pool. Order is BFS until a query makes
 * it best-first — then links whose anchor text and URL share words with the query jump the queue (the
 * best-first idea, like the pruning weights, follows crawl4ai, Apache-2.0). The caps are the contract:
 * max-pages is absolute, depth bounds discovery, robots.txt is obeyed by default, and everything the crawl
 * did NOT do comes back as a per-reason count — a capped crawl that reads like a complete one is the
 * failure mode this report exists to prevent.
 *
 * Everything flows through the same page pipeline (and so the same cache) as `webq fetch`: re-crawling a
 * site an agent already touched this quarter-hour costs no network at all. */
import { setTimeout as sleep } from "node:timers/promises";
import { tokenize } from "./bm25.js";
import { closeBrowser } from "./browser.js";
import { httpFetch } from "./http.js";
import { normalizeUrl, sameOrigin } from "./links.js";
import { saveIndex, savePage, type IndexEntry } from "./output.js";
import { fetchPage, type FetchPageOptions } from "./page.js";
import { EVERYTHING_ALLOWED, isAllowed, parseRobots, type RobotsRules } from "./robots.js";
import { fetchSitemapUrls } from "./sitemap.js";

export interface CrawlOptions extends FetchPageOptions {
    readonly maxPages?: number;
    readonly maxDepth?: number;
    readonly concurrency?: number;
    /** Off only when the caller explicitly takes responsibility (--ignore-robots). */
    readonly robots?: boolean;
    readonly sitemap?: boolean;
    readonly external?: boolean;
    /** Substring (or *-glob) filters over the URL; include must match when given, exclude must not. */
    readonly include?: string[];
    readonly exclude?: string[];
    readonly delayMs?: number;
    readonly outDir: string;
}

export interface CrawlPageReport extends IndexEntry {
    readonly source: string;
    readonly notes: string[];
}

export interface CrawlReport {
    readonly pages: CrawlPageReport[];
    readonly skipped: Record<string, number>;
    readonly indexMarkdown: string;
    readonly indexJson: string;
    readonly sitemapCapped: boolean;
}

interface Candidate {
    readonly url: string;
    depth: number;
    score: number;
    readonly order: number;
}

const MAX_CRAWL_DELAY_MS = 10_000;

export const crawl = async (startUrl: string, options: CrawlOptions): Promise<CrawlReport> => {
    const maxPages = options.maxPages ?? 20;
    const maxDepth = options.maxDepth ?? 2;
    const concurrency = Math.max(1, options.concurrency ?? 4);
    const queryTerms = options.query === undefined ? [] : [...new Set(tokenize(options.query))];
    const skipped = { robots: 0, offsite: 0, filtered: 0, "beyond-depth": 0, "beyond-cap": 0, "http-errors": 0, errors: 0 };

    const robots = options.robots === false ? EVERYTHING_ALLOWED : await loadRobots(startUrl, options.timeoutMs);
    const delayMs = Math.max(options.delayMs ?? 0, Math.min((robots.crawlDelayS ?? 0) * 1000, MAX_CRAWL_DELAY_MS));

    const taken = new Set<string>();
    const pending = new Map<string, Candidate>();
    let order = 0;
    const admit = (raw: string | undefined, depth: number, anchorText: string): void => {
        const url = normalizeUrl(raw);
        if (url === undefined || taken.has(url)) {
            return;
        }
        const queued = pending.get(url);
        if (queued !== undefined) {
            // The same URL reached through a better door: a link whose anchor text finally says what the
            // page is about must be able to promote a candidate the sitemap seeded blind.
            const score = scoreCandidate(url, anchorText, depth, queryTerms);
            if (score > queued.score) {
                queued.score = score;
                queued.depth = Math.min(queued.depth, depth);
            }
            return;
        }
        if (options.external !== true && !sameOrigin(url, startUrl)) {
            skipped.offsite += 1;
            return;
        }
        if (!passesFilters(url, options.include, options.exclude)) {
            skipped.filtered += 1;
            return;
        }
        if (options.robots !== false && !isAllowed(robots, pathOf(url))) {
            skipped.robots += 1;
            return;
        }
        if (depth > maxDepth) {
            skipped["beyond-depth"] += 1;
            return;
        }
        pending.set(url, { url, depth, score: scoreCandidate(url, anchorText, depth, queryTerms), order: order++ });
    };

    admit(startUrl, 0, "");
    let sitemapCapped = false;
    if (options.sitemap === true) {
        const seed = await fetchSitemapUrls(startUrl, robots.sitemaps, sitemapFetcher(options.timeoutMs));
        sitemapCapped = seed.capped;
        for (const url of seed.urls) {
            admit(url, 1, "");
        }
    }

    const pages: CrawlPageReport[] = [];
    const fetchedAt = new Date();
    let inFlight = 0;
    let landed = 0;

    // The pool: pop the best candidate, work it, admit what it links to. Ends when the frontier is dry and
    // nothing is in flight, or the moment the page cap is reached — candidates still queued then are the
    // beyond-cap count, not a silent omission.
    await new Promise<void>((resolve) => {
        const pump = (): void => {
            if (landed >= maxPages || (pending.size === 0 && inFlight === 0)) {
                if (inFlight === 0) {
                    skipped["beyond-cap"] += landed >= maxPages ? pending.size : 0;
                    resolve();
                }
                return;
            }
            // Best-first needs signal before speed: until the first page lands, its links (the anchor
            // texts that score the frontier) don't exist yet, so a query crawl fans out only after the
            // scout page — otherwise the concurrency burst spends the page budget on blind seeds.
            const width = queryTerms.length > 0 && landed === 0 ? 1 : concurrency;
            while (inFlight < width && pending.size > 0 && landed + inFlight < maxPages) {
                const next = takeBest(pending);
                taken.add(next.url);
                inFlight += 1;
                void workOne(next).finally(() => {
                    inFlight -= 1;
                    pump();
                });
            }
        };
        const workOne = async (candidate: Candidate): Promise<void> => {
            try {
                if (delayMs > 0) {
                    await sleep(delayMs);
                }
                const page = await fetchPage(candidate.url, options);
                // A 4xx/5xx is a link that lied, not a page: counted, never written — a saved "nope" body
                // would sit in the index costing tokens and trust.
                if (page.status >= 400) {
                    skipped["http-errors"] += 1;
                    return;
                }
                const saved = await savePage(options.outDir, page, fetchedAt);
                landed += 1;
                pages.push({
                    url: candidate.url,
                    title: page.meta.title,
                    path: saved.path,
                    tokens: saved.tokens,
                    depth: candidate.depth,
                    source: page.source,
                    notes: page.notes,
                });
                for (const link of page.links) {
                    admit(link.url, candidate.depth + 1, link.text);
                }
            } catch {
                skipped.errors += 1;
            }
        };
        pump();
    });

    await closeBrowser();
    const index = await saveIndex(options.outDir, startUrl, pages, skipped);
    return { pages, skipped, indexMarkdown: index.markdownPath, indexJson: index.jsonPath, sitemapCapped };
};

const takeBest = (pending: Map<string, Candidate>): Candidate => {
    let best: Candidate | undefined;
    for (const candidate of pending.values()) {
        if (best === undefined || candidate.score > best.score || (candidate.score === best.score && candidate.order < best.order)) {
            best = candidate;
        }
    }
    pending.delete((best as Candidate).url);
    return best as Candidate;
};

/* Without a query this reduces to plain BFS (depth is the only signal). With one, a link advertising the
 * query's own words — in what it says or where it points — is worth visiting before its siblings. */
const scoreCandidate = (url: string, anchorText: string, depth: number, queryTerms: string[]): number => {
    if (queryTerms.length === 0) {
        return -depth;
    }
    const haystack = new Set(tokenize(`${anchorText} ${pathOf(url).replaceAll(/[/\-_.]/g, " ")}`));
    const overlap = queryTerms.filter((term) => haystack.has(term)).length / queryTerms.length;
    return overlap - depth * 0.05;
};

const passesFilters = (url: string, include: string[] | undefined, exclude: string[] | undefined): boolean => {
    const test = (pattern: string): boolean =>
        pattern.includes("*")
            ? new RegExp(pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("\\*", ".*")).test(url)
            : url.includes(pattern);
    if (include !== undefined && include.length > 0 && !include.some(test)) {
        return false;
    }
    return !(exclude ?? []).some(test);
};

const pathOf = (url: string): string => {
    try {
        const parsed = new URL(url);
        return `${parsed.pathname}${parsed.search}`;
    } catch {
        return url;
    }
};

const loadRobots = async (startUrl: string, timeoutMs: number | undefined): Promise<RobotsRules> => {
    try {
        const origin = new URL(startUrl).origin;
        const response = await httpFetch(`${origin}/robots.txt`, { timeoutMs: Math.min(timeoutMs ?? 10_000, 10_000) });
        // A missing robots.txt allows everything; an unreachable SITE will fail loudly on the first page.
        return response.status >= 200 && response.status < 300 ? parseRobots(response.body) : EVERYTHING_ALLOWED;
    } catch {
        return EVERYTHING_ALLOWED;
    }
};

const sitemapFetcher =
    (timeoutMs: number | undefined) =>
    async (url: string): Promise<{ body: string; bytes?: Uint8Array } | undefined> => {
        try {
            if (url.endsWith(".gz")) {
                const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs ?? 10_000) });
                if (!response.ok) {
                    return undefined;
                }
                const bytes = new Uint8Array(await response.arrayBuffer());
                return { body: "", bytes };
            }
            const response = await httpFetch(url, { timeoutMs: timeoutMs ?? 10_000 });
            return response.status >= 200 && response.status < 300 ? { body: response.body } : undefined;
        } catch {
            return undefined;
        }
    };
