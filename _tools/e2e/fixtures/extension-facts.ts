import type { CapabilitySummary, PanelSummary } from "@intentic/api-contract";

// Minimal facts under which every registration in `_extensions/*` and coreViews.ts activates at least once; a real
// fresh sandbox has nothing connected, so this is a seeded stand-in.

const repo = (name: string, facts: Partial<Omit<PanelSummary, `repo`>>): PanelSummary => ({
    repo: name,
    hasPanel: false,
    running: false,
    // Nothing runnable has nothing to install for; true even for the one repo below that ships a panel.
    installed: true,
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
    // → infrastructure; its deployConfig also keeps apps and dependencies off this repo.
    repo(`intent`, { role: `intent`, deployConfig: true }),
    // → `live-status`.
    repo(`desired-state`, { role: `desired-state`, desiredState: true }),
    // → apps (monorepo branch), dependencies, and acceptance (userStories).
    repo(`platform`, { monorepo: true, vitest: true, userStories: true }),
    // → preview (fallback view): kept unclaimed elsewhere, and not running, to avoid usePanels' 4s poll loop.
    repo(`site`, { hasPanel: true }),
    // → directory-ui (ships .intentic/ui/index.html).
    repo(`designer`, { directoryUi: true }),
    // → apps, via its other branch (vitest without monorepo); that activation carries no repo field.
    repo(`tools`, { vitest: true }),
];

const capability = (id: string, provider: string): CapabilitySummary => ({
    id,
    kind: `cli`,
    status: { state: `active` },
    config: { provider },
    // No credential keys: activation turns on the provider alone, and these specs don't mount an edit form.
    secrets: [],
});

export const FIXTURE_CAPABILITIES: CapabilitySummary[] = [
    // → pipelines (github or gitlab).
    capability(`github`, `github`),
    // → deployments, keyed by capability id, not view id; this name is the route segment below.
    capability(`production`, `komodo`),
    // → activity, which watches only providers with a live feed (discord, slack).
    capability(`discord`, `discord`),
];

// Every activation the fixture above must produce, hand-written since the registry has no runtime introspection hook. A
// view added without an entry here fails extension-views.spec.ts's rail-inventory check.
export interface ExpectedActivation {
    readonly id: string;
    // Activation key, the /ext/:ext/:key? segment; equal to the view id for a singleton, whose segment is dropped.
    readonly key: string;
    readonly surface: `rail` | `directory` | `sandbox`;
    readonly why: string;
}

export const EXPECTED_ACTIVATIONS: readonly ExpectedActivation[] = [
    // core views (in the app, not an extension package)
    { id: `infrastructure`, key: `intent`, surface: `rail`, why: `the intent repo's deploy.config.ts` },
    { id: `live-status`, key: `desired-state`, surface: `rail`, why: `the desired-state repo` },
    { id: `directory-ui`, key: `designer`, surface: `directory`, why: `designer ships .intentic/ui` },

    // An activation, not a seat: whether a tile is drawn is the app's own question (RAIL_GROUPS). "Always on" means the
    // area exists on every sandbox; most surface through the rail's More menu here.
    { id: `acceptance`, key: `acceptance`, surface: `rail`, why: `platform has user stories` },
    { id: `approvals`, key: `approvals`, surface: `rail`, why: `always on` },
    { id: `automations`, key: `automations`, surface: `rail`, why: `always on` },
    { id: `deployments`, key: `production`, surface: `rail`, why: `the komodo capability named production` },
    { id: `documentation`, key: `documentation`, surface: `rail`, why: `any repo at all` },
    { id: `maintenance`, key: `maintenance`, surface: `rail`, why: `any repo at all` },
    { id: `pipelines`, key: `pipelines`, surface: `rail`, why: `a github CLI capability is connected` },
    { id: `workflows`, key: `workflows`, surface: `rail`, why: `always on` },

    // directory extensions (per repo, the Workspace tree's panels, not the rail)
    { id: `apps`, key: `platform`, surface: `directory`, why: `platform is a pnpm+turbo monorepo` },
    { id: `apps`, key: `tools`, surface: `directory`, why: `tools has vitest but is not a monorepo` },
    { id: `dependencies`, key: `platform`, surface: `directory`, why: `platform is a monorepo` },
    { id: `preview`, key: `site`, surface: `directory`, why: `site runs a dev server and nothing claims it` },
    // Auxiliary, activates for every repo; one entry proves the mount, the rail-inventory check covers the rest.
    { id: `documentation-repo`, key: `platform`, surface: `directory`, why: `every repo gets a Docs panel` },

    // sandbox-surface extensions (tabs on the Sandbox hub): each extension.ts carries that argument, not rail.
    { id: `activity`, key: `activity`, surface: `sandbox`, why: `always on` },
    { id: `knowledge`, key: `knowledge`, surface: `sandbox`, why: `always on` },
    { id: `logs`, key: `logs`, surface: `sandbox`, why: `always on` },
    { id: `ports`, key: `ports`, surface: `sandbox`, why: `always on` },
    { id: `public`, key: `public`, surface: `sandbox`, why: `always on` },
];

// Deep-link path for an activation, mirroring extensionPath in the app: a singleton's sole segment is dropped.
export const activationPath = ({ id, key }: ExpectedActivation): string => (key === id ? `/ext/${id}` : `/ext/${id}/${encodeURIComponent(key)}`);

// Every rail tile the fixture should produce, in no particular order; the exhaustiveness guard's expectation.
export const EXPECTED_RAIL_IDS: readonly string[] = EXPECTED_ACTIVATIONS.filter((activation) => activation.surface === `rail`).map(
    (activation) => activation.id,
);
