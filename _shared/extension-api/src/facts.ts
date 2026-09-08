// Stable detection facts `detect()` reads to decide when to activate a view: narrow and evidence-based, not the data
// plane (real data comes via `api.sandbox.request/json` against sandbox-contract schemas). Optional fields carry `|
// undefined` for exactOptionalPropertyTypes.

// Daemon-computed content facts for one repo under /work (`repo` is its root-relative dir); evidence over identity,
// based on what the repo contains, not its name.
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
    // Whether the repo has a docs/user-stories directory; what an acceptance-testing surface activates on.
    readonly userStories: boolean;
    // Whether the repo has a docs/architecture directory.
    readonly docs: boolean;
}

// One connected capability's secret-free echo. `kind` is an open string; matching on one couples the extension to it
// continuing to exist.
export interface CapabilityFacts {
    readonly id: string;
    readonly kind: string;
    readonly config: Readonly<Record<string, string | number | boolean>>;
}
