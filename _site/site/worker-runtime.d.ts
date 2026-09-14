/* THE TWO CLOUDFLARE-ONLY THINGS `worker.ts` USES, declared rather than depended on. */

interface RequestInit {
    /** Cloudflare request features. `cacheTtl` overrides the origin's own Cache-Control for this subrequest. */
    cf?: { cacheTtl?: number; cacheEverything?: boolean };
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
