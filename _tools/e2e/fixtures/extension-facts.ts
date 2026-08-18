import type { CapabilitySummary, PanelSummary } from "@intentic-app/api-contract";

/* A WORKSPACE THAT ACTIVATES EVERY EXTENSION VIEW AT ONCE.
 *
 * Views are not always-on: each `detect(repos, capabilities)` fires on evidence — a repo containing
 * deploy.config.ts, a connected komodo CLI, a docs/user-stories directory. A real fresh sandbox has an empty
 * workspace and no connected capabilities, so most of the rail does not exist there. "Every view loads" is
 * therefore a property of a SEEDED workspace, and this file is that seed: the smallest set of facts under which
 * every registration in `_extensions/*` and `_editor/web/src/core-views/coreViews.ts` yields at least one
 * activation.
 *
 * THE REPOS ARE SEPARATE ON PURPOSE. registry.ts drops a `fallback` view's activation for any repo a claiming
 * view already serves, so facts piled onto one repo would silently hide the views that lose the claim. Each
 * repo below carries the minimum evidence for its own views and nothing else, which is what keeps the fallback
 * (`preview`) and the claimers (`apps`, `dependencies`, `directory-ui`, `infrastructure`, `live-status`) all
 * visible in the same run.
 *
 * Kept as WIRE-SHAPED records typed by the daemon's own summaries rather than by the narrower `RepoFacts` —
 * that is what the browser actually receives, so a required field added to the schema fails here at compile
 * time instead of at `PanelsListSchema.parse` inside the running app. */

const repo = (repo: string, facts: Partial<Omit<PanelSummary, `repo`>>): PanelSummary => ({
    repo,
    hasPanel: false,
    running: false,
    healthy: false,
    servers: [],
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
    userStories: false,
    docs: false,
    ...facts,
});

export const FIXTURE_PANELS: PanelSummary[] = [
    // The intent ledger → `infrastructure`. Claims itself, and its deployConfig is also what keeps `apps` and
    // `dependencies` off it (both exclude the ledger explicitly).
    repo(`intent`, { role: `intent`, deployConfig: true }),
    // → `live-status`.
    repo(`desired-state`, { role: `desired-state`, desiredState: true }),
    // → `apps` (monorepo branch), `dependencies`, and `acceptance` (userStories).
    repo(`platform`, { monorepo: true, vitest: true, userStories: true }),
    // → `preview`. Deliberately NOT a monorepo and NOT vitest: preview is a `fallback` view, so this repo has
    // to stay unclaimed by anything else or its activation is dropped and the view never renders. Left NOT
    // running, because usePanels polls every 4s while any panel is — a perpetual request loop the specs would
    // then have to race.
    repo(`site`, { hasPanel: true }),
    // → `directory-ui` (a repo shipping .intentic/ui/index.html).
    repo(`designer`, { directoryUi: true }),
    // → `apps` again, through its OTHER branch: vitest without monorepo. That branch returns an activation with
    // no `repo` field, so it claims nothing — a difference worth exercising rather than assuming.
    repo(`tools`, { vitest: true }),
];

const capability = (id: string, provider: string): CapabilitySummary => ({
    id,
    kind: `cli`,
    status: { state: `active` },
    config: { provider },
    // The credential keys this connection holds — none here, because activation turns on the provider alone and
    // an edit form is not what these specs mount.
    secrets: [],
});

export const FIXTURE_CAPABILITIES: CapabilitySummary[] = [
    // → `pipelines` (github or gitlab).
    capability(`github`, `github`),
    // → `deployments`. The activation is keyed by the CAPABILITY ID, not by the view id, so this name is the
    // route segment below.
    capability(`production`, `komodo`),
    // → `activity`, which watches only the providers with a live feed (discord, slack).
    capability(`discord`, `discord`),
];

/* THE INVENTORY — every activation the fixture above must produce.
 *
 * Written out rather than derived from the running app: the registry is module state inside the SPA with no
 * runtime introspection hook, and adding one to be testable would be a worse trade than maintaining this list.
 * The list is also the point — a view added without a line here fails the rail-inventory check in
 * extension-views.spec.ts, which is what makes "every view" hold as views are added, and mirrors the
 * same-commit rule RAIL_GROUPS already states in registry.ts. */
export interface ExpectedActivation {
    readonly id: string;
    // The activation key — the `/ext/:ext/:key?` segment. Equal to the view id for a singleton, in which case
    // `extensionPath` drops the segment entirely.
    readonly key: string;
    readonly surface: `rail` | `directory` | `sandbox`;
    readonly why: string;
}

export const EXPECTED_ACTIVATIONS: readonly ExpectedActivation[] = [
    // ── core views (in the app, not an extension package) ──
    { id: `infrastructure`, key: `intent`, surface: `rail`, why: `the intent repo's deploy.config.ts` },
    { id: `live-status`, key: `desired-state`, surface: `rail`, why: `the desired-state repo` },
    { id: `directory-ui`, key: `designer`, surface: `directory`, why: `designer ships .intentic/ui` },

    // ── rail extensions ──
    { id: `acceptance`, key: `acceptance`, surface: `rail`, why: `platform has user stories` },
    { id: `activity`, key: `activity`, surface: `rail`, why: `a discord CLI capability is connected` },
    { id: `automations`, key: `automations`, surface: `rail`, why: `always on` },
    { id: `deployments`, key: `production`, surface: `rail`, why: `the komodo capability named production` },
    { id: `documentation`, key: `documentation`, surface: `rail`, why: `any repo at all` },
    { id: `maintenance`, key: `maintenance`, surface: `rail`, why: `any repo at all` },
    { id: `memory`, key: `memory`, surface: `rail`, why: `always on` },
    { id: `pipelines`, key: `pipelines`, surface: `rail`, why: `a github CLI capability is connected` },
    { id: `workflows`, key: `workflows`, surface: `rail`, why: `always on` },

    // ── directory extensions (per repo — the Workspace tree's panels, not the rail) ──
    { id: `apps`, key: `platform`, surface: `directory`, why: `platform is a pnpm+turbo monorepo` },
    { id: `apps`, key: `tools`, surface: `directory`, why: `tools has vitest but is not a monorepo` },
    { id: `dependencies`, key: `platform`, surface: `directory`, why: `platform is a monorepo` },
    { id: `preview`, key: `site`, surface: `directory`, why: `site runs a dev server and nothing claims it` },
    // `documentation-repo` is auxiliary and activates for EVERY repo; one is enough to prove the view mounts,
    // and the rail-inventory check covers the rest.
    { id: `documentation-repo`, key: `platform`, surface: `directory`, why: `every repo gets a Docs panel` },

    // ── sandbox-surface extensions (tabs on the Sandbox hub) ──
    { id: `logs`, key: `logs`, surface: `sandbox`, why: `always on` },
    { id: `ports`, key: `ports`, surface: `sandbox`, why: `always on` },
    { id: `public`, key: `public`, surface: `sandbox`, why: `always on` },
];

// The deep-link path for an activation, mirroring `extensionPath` in the app: a singleton view names its sole
// activation after itself, and that segment would just repeat the view id — so it is dropped.
export const activationPath = ({ id, key }: ExpectedActivation): string => (key === id ? `/ext/${id}` : `/ext/${id}/${encodeURIComponent(key)}`);

// Every rail tile the fixture should produce, in no particular order — the exhaustiveness guard's expectation.
export const EXPECTED_RAIL_IDS: readonly string[] = EXPECTED_ACTIVATIONS.filter((activation) => activation.surface === `rail`).map(
    (activation) => activation.id,
);
