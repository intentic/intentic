/* One URL → one PageResult: the pipeline every command runs. Cache first, static HTTP second, the image's
 * Chromium only when the static HTML is visibly an empty app shell (or the caller forces it) — the cheap
 * path is the default and the expensive one has to be earned. The result carries its own honesty: where
 * the bytes came from, what the pruner removed, what a query filter kept, and every degradation (byte cap
 * hit, JS page with no browser in the image) as a note the capsule prints — a silent fallback reads as
 * "that was the whole page" to an agent, which is a lie with consequences. */
import { bm25Rank } from "./bm25.js";
import { chromiumAvailable, renderPage } from "./browser.js";
import { cacheRead, cacheWrite, DEFAULT_MAX_AGE_S, type RenderMode } from "./cache.js";
import { bodyOf, type Document, type Element, elementsByTag, metaOf, type PageMeta, parseHtml, remove, textOf, walk } from "./dom.js";
import { httpFetch, USER_AGENT } from "./http.js";
import { extractLinks, type Link } from "./links.js";
import { renderMarkdown } from "./markdown.js";
import { pruneTree } from "./prune.js";

export type BrowserMode = "auto" | "never" | "force";

export interface FetchPageOptions {
    readonly raw?: boolean;
    readonly query?: string | undefined;
    readonly browser?: BrowserMode;
    /** Cache freshness window in seconds; 0 means bypass reads (a write still lands). */
    readonly maxAgeS?: number;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly threshold?: number | undefined;
}

export interface PageResult {
    readonly url: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly markdown: string;
    readonly meta: PageMeta;
    readonly links: Link[];
    readonly source: "cache" | "network" | "browser";
    /** Share of text mass fit-pruning removed, when it ran. */
    readonly prunedShare: number | undefined;
    readonly notes: string[];
}

export const fetchPage = async (url: string, options: FetchPageOptions = {}): Promise<PageResult> => {
    const browserMode = options.browser ?? "auto";
    const maxAgeS = options.maxAgeS ?? DEFAULT_MAX_AGE_S;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const notes: string[] = [];

    let acquired = browserMode === "force" ? undefined : await acquireStatic(url, options, maxAgeS, timeoutMs, notes);
    if (acquired === undefined || (browserMode !== "never" && looksLikeAppShell(acquired.doc, acquired.body))) {
        const rendered = await acquireBrowser(url, maxAgeS, timeoutMs, notes);
        if (rendered !== undefined) {
            acquired = rendered;
        } else if (acquired === undefined) {
            throw new Error("browser rendering unavailable (no Chromium in this image) and --browser force was asked for");
        }
    }
    const { doc, body, finalUrl, status, contentType, source } = acquired;

    if (!isHtml(contentType)) {
        return {
            url,
            finalUrl,
            status,
            contentType,
            markdown: nonHtmlMarkdown(acquired.rawBody, contentType, notes),
            meta: { title: url, description: undefined, lang: undefined },
            links: [],
            source,
            prunedShare: undefined,
            notes,
        };
    }

    // Meta and links come off the tree BEFORE pruning mutates it: navigation is chrome to the reader but
    // structure to the crawler.
    const meta = metaOf(doc);
    const links = extractLinks(doc, finalUrl);

    let prunedShare: number | undefined;
    if (body !== undefined && options.raw !== true) {
        prunedShare = pruneTree(body, options.threshold === undefined ? {} : { threshold: options.threshold });
    }
    if (body !== undefined && options.query !== undefined && options.query !== "") {
        notes.push(applyQueryFilter(body, options.query));
    }
    const markdown = body === undefined ? "" : renderMarkdown(body, { baseUrl: finalUrl });
    return { url, finalUrl, status, contentType, markdown, meta, links, source, prunedShare, notes };
};

interface Acquired {
    readonly doc: Document;
    readonly body: Element | undefined;
    readonly rawBody: string;
    readonly finalUrl: string;
    readonly status: number;
    readonly contentType: string;
    readonly source: "cache" | "network" | "browser";
}

const acquireStatic = async (url: string, options: FetchPageOptions, maxAgeS: number, timeoutMs: number, notes: string[]): Promise<Acquired> => {
    const cached = maxAgeS > 0 ? await cacheRead(url, "static", maxAgeS) : undefined;
    if (cached !== undefined) {
        return parsed(cached.body, cached.finalUrl, cached.status, cached.contentType, "cache");
    }
    const fetched = await httpFetch(url, {
        timeoutMs,
        userAgent: USER_AGENT,
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
    if (fetched.truncated) {
        notes.push("byte cap hit mid-body: this page is cut short");
    }
    await cacheWrite({
        url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        body: fetched.body,
        mode: "static",
        fetchedAt: Date.now(),
    });
    return parsed(fetched.body, fetched.finalUrl, fetched.status, fetched.contentType, "network");
};

const acquireBrowser = async (url: string, maxAgeS: number, timeoutMs: number, notes: string[]): Promise<Acquired | undefined> => {
    const mode: RenderMode = "browser";
    const cached = maxAgeS > 0 ? await cacheRead(url, mode, maxAgeS) : undefined;
    if (cached !== undefined) {
        return parsed(cached.body, cached.finalUrl, cached.status, cached.contentType, "browser");
    }
    if (!(await chromiumAvailable())) {
        notes.push("page looks JS-rendered but this image has no Chromium (browser feature pack): static HTML served best-effort");
        return undefined;
    }
    const rendered = await renderPage(url, timeoutMs);
    await cacheWrite({ url, finalUrl: rendered.finalUrl, status: 200, contentType: "text/html", body: rendered.html, mode, fetchedAt: Date.now() });
    return parsed(rendered.html, rendered.finalUrl, 200, "text/html", "browser");
};

const parsed = (html: string, finalUrl: string, status: number, contentType: string, source: Acquired["source"]): Acquired => {
    const doc = isHtml(contentType) ? parseHtml(html) : parseHtml("");
    return { doc, body: bodyOf(doc), rawBody: html, finalUrl, status, contentType, source };
};

const isHtml = (contentType: string): boolean => contentType === "" || /text\/html|application\/xhtml/i.test(contentType);

/* The JS-shell tell: a body with almost no text next to scripts that were clearly meant to produce some.
 * Thresholded on text, not on framework fingerprints — the fingerprints age, the emptiness does not. */
const looksLikeAppShell = (doc: Document, body: Element | undefined): boolean => {
    if (body === undefined) {
        return false;
    }
    const text = textOf(body);
    if (text.length >= 200) {
        return false;
    }
    return elementsByTag(doc, "script").length > 0;
};

const nonHtmlMarkdown = (rawBody: string, contentType: string, notes: string[]): string => {
    if (/json/i.test(contentType)) {
        return `\`\`\`json\n${rawBody.trim()}\n\`\`\`\n`;
    }
    if (/xml/i.test(contentType)) {
        return `\`\`\`xml\n${rawBody.trim()}\n\`\`\`\n`;
    }
    if (/^text\//i.test(contentType)) {
        return `${rawBody.trim()}\n`;
    }
    notes.push(`unsupported content type ${contentType.split(";")[0] ?? contentType}: no markdown produced`);
    return "";
};

// Blocks a query filter may drop; headings stay put so the survivors keep their skeleton.
const FILTERABLE = new Set(["p", "li", "pre", "table", "blockquote", "dd"]);

const applyQueryFilter = (body: Element, query: string): string => {
    const candidates: Element[] = [];
    walk(body, (el) => {
        if (FILTERABLE.has(el.tagName) && !hasFilterableAncestorWithin(el, body)) {
            candidates.push(el);
        }
    });
    const ranked = bm25Rank(candidates, (el) => textOf(el), query);
    const keep = new Set(ranked.map((entry) => entry.block));
    // A query matching almost nothing means the filter would erase the page; keeping everything and saying
    // so beats returning three sentences that happen to share a word with the query.
    if (keep.size < Math.min(3, candidates.length)) {
        return `query matched too little (${keep.size}/${candidates.length} blocks): kept the whole page`;
    }
    for (const candidate of candidates) {
        if (!keep.has(candidate)) {
            remove(candidate);
        }
    }
    return `query kept ${keep.size}/${candidates.length} blocks`;
};

/* <li> inside a kept <table>'s cell (or nested lists) must not be scored twice — only top-most filterable
 * blocks compete, so removal never yanks a child out of a parent that already won. */
const hasFilterableAncestorWithin = (el: Element, root: Element): boolean => {
    let parent = el.parentNode;
    while (parent !== null && parent !== root) {
        if ("tagName" in parent && FILTERABLE.has(parent.tagName)) {
            return true;
        }
        parent = "parentNode" in parent && parent.parentNode !== undefined ? parent.parentNode : null;
    }
    return false;
};
