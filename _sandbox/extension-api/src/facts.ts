/* The stable DETECTION facts — the subset of the daemon's wire schemas an extension's `detect()` reads to decide
 * when to activate a view. This is deliberately narrow (evidence over identity) so activation logic doesn't
 * couple to the daemon's fuller summaries. It is NOT the data plane: an activated extension reads real data over
 * `api.sandbox.request/json` against the `@intentic/sandbox-contract` schemas — the first-party wire contract,
 * gated per-route by the manifest's `permissions.sandbox` allowlist. (Because every first-party extension is
 * in-repo and compiled together, a wire change there is caught by the compiler and fixed atomically, so there is
 * no separate "stable data API" to promote — only detection is version-stable.) The daemon's own summaries
 * (PanelSummary, CapabilitySummary) are structural supersets and flow into `detect()` unmapped, but only THESE
 * fields are guaranteed to it. Optional fields carry `| undefined` so zod-inferred wire types assign under
 * exactOptionalPropertyTypes. */

// Daemon-computed content facts for one discovered repository under /work (`repo` is its root-relative dir) —
// evidence over identity: a repo is served because of what it CONTAINS (deploy.config.ts, pnpm-workspace.yaml
// + turbo.json, .intentic/ui), not what it happens to be named.
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
    // Whether the repo describes its features as user stories (a docs/user-stories directory) — the one fact
    // here that is language-agnostic, and the evidence an acceptance-testing surface activates on.
    readonly userStories: boolean;
    /* Whether the repo carries architecture documentation (a docs/architecture directory).
     *
     * Here so that a surface which READS documentation can tell, without asking the file routes, which repos
     * have any. The alternative was a read per repo on a poll — an answer the daemon already has from the same
     * one-pass scan that produces every other fact on this interface. */
    readonly docs: boolean;
}

// One connected capability's secret-free echo — `kind` is an open string: new kinds appear without an API bump,
// and matching on one couples the extension to that kind's continued existence.
export interface CapabilityFacts {
    readonly id: string;
    readonly kind: string;
    readonly config: Readonly<Record<string, string | number | boolean>>;
}
