/** The slice of CDP's `Profiler.ScriptCoverage` the totals read. */
export interface ScriptCoverage {
    readonly url: string;
    readonly functions: readonly { readonly ranges: readonly { readonly count: number }[] }[];
}

/** Whose code a script is: the editor's own source, the demo's fake backend, a dependency, or the harness itself. */
export type Owner = "app" | "fixture" | "dependency" | "harness";

/**
 * Classifies a script by the URL the demo's Vite serves it under: workspace source as `/@fs/<repo>/…`, the demo's own
 * files root-relative under `/demo/`, pre-bundled packages under `node_modules/.vite/deps`.
 */
export const ownerOf = (url: string): Owner => {
    // Playwright's evaluations and init scripts carry no URL, or one that is not the server's; Vite's client is the
    // dev server's, not the page's.
    if (!/^https?:\/\//u.test(url)) {
        return "harness";
    }
    const path = new URL(url).pathname;
    if (path.includes("/@vite/")) {
        return "harness";
    }
    if (path.includes("/node_modules/") || path.includes("/@id/")) {
        return "dependency";
    }
    if (path.includes("/_site/demo/") || /^\/demo\/(?:src|vendor)\//u.test(path)) {
        return "fixture";
    }
    return path.includes("/@fs/") ? "app" : "dependency";
};

/** Function calls per owner; with `detailed: false` each function reports one range whose count is its invocations. */
export const callsByOwner = (scripts: readonly ScriptCoverage[]): Readonly<Record<Owner, number>> => {
    const calls: Record<Owner, number> = { app: 0, fixture: 0, dependency: 0, harness: 0 };
    for (const script of scripts) {
        const owner = ownerOf(script.url);
        for (const fn of script.functions) {
            calls[owner] += fn.ranges[0]?.count ?? 0;
        }
    }
    return calls;
};
