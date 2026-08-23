/* Link harvesting for the crawler, off the ORIGINAL tree — pruning strips navigation, and navigation is
 * exactly where a site's structure lives, so the frontier reads the page before fit-mode touched it.
 * URLs are normalized to their crawl identity: fragment gone (same document), default port folded away,
 * http(s) only. The anchor text rides along because it is the best-first scorer's main signal. */
import { attr, elementsByTag, type Node, textOf } from "./dom.js";

export interface Link {
    readonly url: string;
    readonly text: string;
}

export const extractLinks = (root: Node, baseUrl: string): Link[] => {
    const seen = new Map<string, Link>();
    for (const anchor of elementsByTag(root, "a")) {
        const url = normalizeUrl(attr(anchor, "href"), baseUrl);
        if (url === undefined) {
            continue;
        }
        const existing = seen.get(url);
        const text = textOf(anchor).slice(0, 200);
        if (existing === undefined || (existing.text === "" && text !== "")) {
            seen.set(url, { url, text });
        }
    }
    return [...seen.values()];
};

export const normalizeUrl = (raw: string | undefined, base?: string): string | undefined => {
    if (raw === undefined || raw.trim() === "") {
        return undefined;
    }
    try {
        const url = base === undefined ? new URL(raw.trim()) : new URL(raw.trim(), base);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return undefined;
        }
        url.hash = "";
        return url.href;
    } catch {
        return undefined;
    }
};

export const sameOrigin = (a: string, b: string): boolean => {
    try {
        return new URL(a).origin === new URL(b).origin;
    } catch {
        return false;
    }
};
