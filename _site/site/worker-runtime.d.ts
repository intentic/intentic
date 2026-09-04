/* THE TWO CLOUDFLARE-ONLY THINGS `worker.ts` USES, declared rather than depended on.
 *
 * `@cloudflare/workers-types` is the obvious answer and the wrong one here: this package is an Astro site,
 * typechecked against `lib.dom`, and the workers types replace half of it — `Response`, `Request`, `fetch`,
 * `caches` — with their own incompatible shapes. Installing them to type one file would put every `.astro`
 * component in the package on a DOM that does not exist in a browser.
 *
 * So the runtime surface the worker actually touches is written out, and it is two things: the `cf` field on
 * a request (how a subrequest overrides what the origin asked us to cache it for) and HTMLRewriter (how the
 * built HTML is edited on its way past). Anything else the worker needs is standard and already typed.
 *
 * No import or export in this file, on purpose: that is what makes it a global script rather than a module,
 * and `interface RequestInit` below a MERGE into lib.dom's own rather than a second one that shadows it. */

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
