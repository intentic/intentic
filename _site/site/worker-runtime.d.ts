/* THE TWO CLOUDFLARE-ONLY THINGS `worker.ts` USES, declared rather than depended on. */

/**
 * Cloudflare's `cf` object, one type both ways so a Request can be handed to another as its init: on a subrequest,
 * options (`cacheTtl` overrides the origin's own Cache-Control); on an incoming request, facts about it (`country` is
 * ISO 3166-1 alpha-2, or `XX` when unknown; `verifiedBotCategory` names a bot Cloudflare has verified).
 */
interface CloudflareProperties {
    cacheTtl?: number;
    cacheEverything?: boolean;
    readonly country?: string;
    /** Set when Cloudflare recognises a verified bot ("AI Crawler", "Search Engine Crawler", …); empty or absent otherwise. */
    readonly verifiedBotCategory?: string;
}

interface Request {
    readonly cf?: CloudflareProperties;
}

interface RequestInit {
    cf?: CloudflareProperties;
}

interface HTMLRewriterElement {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    /** Escaped unless `html` is set. It is never set in this codebase; see `withLiveContent` for why. */
    setInnerContent(content: string, options?: { html?: boolean }): void;
}

interface HTMLRewriterHandlers {
    element?: (element: HTMLRewriterElement) => void;
}

declare class HTMLRewriter {
    on(selector: string, handlers: HTMLRewriterHandlers): HTMLRewriter;
    transform(response: Response): Response;
}
