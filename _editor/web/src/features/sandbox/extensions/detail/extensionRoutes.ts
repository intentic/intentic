import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";

// The sandbox routes an extension declared, each with what the per-route call ledger saw it do. The method is split off
// so a reader's eye lands on the path, which is the part that says what it touches.

export interface ExtensionRoute {
    /** As declared: `GET /settings`. */
    readonly route: string;
    /** `GET`, `POST`…, or empty for a route declared without one. */
    readonly method: string;
    readonly path: string;
    readonly calls: number;
    /** Observed and never called. Not observed at all is not this: then every route reads as declared. */
    readonly unused: boolean;
}

export const routesOf = (extension: ExtensionSummary): ExtensionRoute[] =>
    (extension.manifest.permissions?.sandbox ?? []).map((route) => {
        const calls = extension.usage?.[route]?.calls ?? 0;
        const space = route.indexOf(` `);
        return {
            route,
            method: space === -1 ? `` : route.slice(0, space),
            path: space === -1 ? route : route.slice(space + 1),
            calls,
            unused: extension.usage !== undefined && calls === 0,
        };
    });
