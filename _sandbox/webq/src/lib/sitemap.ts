/* Sitemap seeding: the URLs a site already published as its own map, so a crawl starts from the real
 * table of contents instead of discovering it hop by hop. Reads the sitemaps robots.txt names (falling
 * back to /sitemap.xml), follows one level of <sitemapindex>, inflates .gz payloads, and stops at a hard
 * cap — a million-URL commerce sitemap must not become the frontier. The "parser" is a <loc> scan, which
 * is all a urlset carries that we want. */
import { gunzipSync } from "node:zlib";
import { normalizeUrl } from "./links.js";

const URL_CAP = 2_000;
const CHILD_SITEMAP_CAP = 10;

export interface SitemapSeed {
    readonly urls: string[];
    /** True when the cap cut discovery short — the crawl capsule reports it instead of implying totality. */
    readonly capped: boolean;
}

export const fetchSitemapUrls = async (
    startUrl: string,
    robotsSitemaps: string[],
    fetchText: (url: string) => Promise<{ body: string; bytes?: Uint8Array } | undefined>,
): Promise<SitemapSeed> => {
    const origin = new URL(startUrl).origin;
    const roots = robotsSitemaps.length > 0 ? robotsSitemaps : [`${origin}/sitemap.xml`];
    const urls = new Set<string>();
    let capped = false;
    let childBudget = CHILD_SITEMAP_CAP;
    const queue = [...roots];
    while (queue.length > 0 && urls.size < URL_CAP) {
        const sitemapUrl = queue.shift();
        if (sitemapUrl === undefined) {
            break;
        }
        const fetched = await fetchText(sitemapUrl);
        if (fetched === undefined) {
            continue;
        }
        const xml = maybeGunzip(sitemapUrl, fetched);
        const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)].map((m) => m[1] ?? "");
        if (/<sitemapindex/i.test(xml)) {
            for (const loc of locs) {
                if (childBudget > 0) {
                    queue.push(loc);
                    childBudget -= 1;
                } else {
                    capped = true;
                }
            }
            continue;
        }
        for (const loc of locs) {
            const url = normalizeUrl(decodeXmlEntities(loc));
            if (url === undefined) {
                continue;
            }
            if (urls.size >= URL_CAP) {
                capped = true;
                break;
            }
            urls.add(url);
        }
    }
    return { urls: [...urls], capped };
};

const maybeGunzip = (url: string, fetched: { body: string; bytes?: Uint8Array }): string => {
    if (!url.endsWith(".gz") || fetched.bytes === undefined) {
        return fetched.body;
    }
    try {
        return gunzipSync(fetched.bytes).toString("utf8");
    } catch {
        return fetched.body;
    }
};

const decodeXmlEntities = (text: string): string =>
    text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'");
