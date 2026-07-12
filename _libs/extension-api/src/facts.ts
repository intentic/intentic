/* The PUBLIC detection facts — the stable subset of the daemon's wire schemas that extension `detect()`
 * functions may read. The daemon's own summaries (PanelSummary, CapabilitySummary) are structural supersets and
 * flow in unmapped, but only THESE fields are part of the extension API: everything else on the wire stays free
 * to change. Optional fields carry `| undefined` so zod-inferred wire types assign under
 * exactOptionalPropertyTypes. */

// Daemon-computed content facts for one repository under /work/repositories — evidence over identity: a repo is
// served because of what it CONTAINS (deploy.config.ts, pnpm-workspace.yaml + turbo.json, .intentic/ui), not
// what it happens to be named.
export interface RepoFacts {
    readonly repo: string;
    // The workspace role this repo dir occupies; absent for extra clones.
    readonly role?: "intent" | "desired-state" | "app" | undefined;
    // Whether the repo ships a runnable dev server (a package.json `dev` script at operator/ or the root).
    readonly hasPanel: boolean;
    readonly deployConfig: boolean;
    readonly desiredState: boolean;
    readonly directoryUi: boolean;
    readonly monorepo: boolean;
    readonly vitest: boolean;
}

// One connected capability's secret-free echo — `kind` is an open string: new kinds appear without an API bump,
// and matching on one couples the extension to that kind's continued existence.
export interface CapabilityFacts {
    readonly id: string;
    readonly kind: string;
    readonly config: Readonly<Record<string, string | number | boolean>>;
}
