import type { Router } from "vue-router";

/**
 * The route pattern a browser path matches, with the regex parts of each param dropped: `/workspace/src/a.ts` is
 * `/workspace/:path*` and `/agents/cnv_1` is `/agents/:id`. A param holds a file path, a conversation or a sandbox, so
 * analytics reports the pattern and never the value. Undefined when the router cannot match the path at all.
 *
 * `path` is what the browser shows, base included. The router's own base is cut off first, since `resolve` expects a
 * path inside the app.
 */
export const routePatternOf = (router: Pick<Router, "resolve" | "options">, path: string): string | undefined => {
    const { base } = router.options.history;
    const inApp = base !== `` && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || `/` : path;
    const matched = router.resolve(inApp).matched.at(-1);
    return matched?.path.replace(/\([^)]*\)/g, ``);
};
