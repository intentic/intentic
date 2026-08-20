import type { CapabilityFacts, Disposable, IntenticApi, ViewRegistration } from "@intentic/extension-api";
import * as acceptance from "@intentic/ext-acceptance";
import * as documentation from "@intentic/ext-documentation";
import * as apps from "@intentic/ext-repo-apps";
import * as preview from "@intentic/ext-preview";
import type { PanelSummary } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { RAIL_GROUPS, detectActivations, railRank, registerView } from "./registry";

// apps + preview are packaged extensions the app activates via loadBuiltins; the registry seeds only the still-
// static core views (infrastructure/live-status/directory-ui). Register the packaged detects here so the
// cross-extension rules — apps claims a monorepo, a fallback view is dropped when claimed — are exercised
// against the same registry the shell composes. (The fallback rule's exemplar is a local registration below:
// no first-party view ships as a fallback since the dev-server preview moved to the shell's Preview area.)
// Views are what this file is about; `commands` and `viewers` are here because activate() is one function — an
// extension that registers a command as well as a view must not fail to register the view.
const registerApi = {
    views: { register: (view: ViewRegistration) => registerView(`test`, view) },
    viewers: { register: (): Disposable => ({ dispose: () => {} }) },
    // The tree's per-directory documents. Accepted and dropped: this file is about what the RAIL shows, and an
    // activate() that reaches a registry the stub is missing stops there — taking the views under test with it.
    documents: { register: (): Disposable => ({ dispose: () => {} }) },
    commands: { register: (): Disposable => ({ dispose: () => {} }) },
} as unknown as IntenticApi;
apps.activate(registerApi, { extensionId: `intentic.repo-apps`, subscriptions: [] });
preview.activate(registerApi, { extensionId: `intentic.preview`, subscriptions: [] });
acceptance.activate(registerApi, { extensionId: `intentic.acceptance`, subscriptions: [] });
// Documentation too: the rail-order cases below need a listed rail view whose position was previously an accident
// of the builtins array. Its activate() also starts a badge poll, which is harmless here — every read inside it is
// guarded, so an unreachable host simply yields no badge.
documentation.activate(registerApi, { extensionId: `intentic.documentation`, subscriptions: [] });

// A PanelSummary with everything false — override only the facts a case exercises.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
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
    ...over,
});

// The extension ids that contributed an element rooted at `repo`.
const idsFor = (repo: string, panels: PanelSummary[]): string[] =>
    detectActivations(panels, [])
        .filter(({ activation }) => activation.repo === repo)
        .map(({ extension }) => extension.id);

describe(`apps extension`, () => {
    it(`excludes the intent/infrastructure repo — it surfaces as Infrastructure, not as an app monorepo`, () => {
        const ids = idsFor(`intentic-app`, [panel({ repo: `intentic-app`, deployConfig: true, monorepo: true })]);
        expect(ids).toContain(`infrastructure`);
        expect(ids).not.toContain(`apps`);
    });

    it(`still surfaces a plain monorepo as an app monorepo`, () => {
        expect(idsFor(`shop`, [panel({ repo: `shop`, monorepo: true })])).toContain(`apps`);
    });
});

// The `apps` extension's tile for a repo, whether it claims the repo (monorepo) or rides in props (vitest-only)
// — keyed by the tile key, which is always the repo name. `idsFor` above only sees claiming tiles.
const appsTile = (key: string, panels: PanelSummary[]) =>
    detectActivations(panels, []).find(({ extension, activation }) => extension.id === `apps` && activation.key === key)?.activation;
const contributes = (id: string, key: string, panels: PanelSummary[]): boolean =>
    detectActivations(panels, []).some(({ extension, activation }) => extension.id === id && activation.key === key);

describe(`apps extension — merged tests view`, () => {
    it(`a monorepo-with-vitest gets ONE claiming tile (props.monorepo) — no duplicate ⚡ tile`, () => {
        const panels = [panel({ repo: `mono`, monorepo: true, vitest: true, hasPanel: true })];
        const tile = appsTile(`mono`, panels);
        expect(tile?.repo).toBe(`mono`);
        expect(tile?.props).toEqual({ monorepo: true });
    });

    it(`a vitest-only non-monorepo repo gets a non-claiming ⚡ tile`, () => {
        const panels = [panel({ repo: `lib`, vitest: true, hasPanel: true })];
        const tile = appsTile(`lib`, panels);
        expect(tile?.repo).toBeUndefined();
        expect(tile?.icon).toBe(`bolt`);
        expect(tile?.props).toEqual({ repo: `lib`, monorepo: false });
    });

    it(`the intent monorepo's vitest surfaces as a tests-only tile beside Infrastructure, never a browsable app monorepo`, () => {
        const panels = [panel({ repo: `intent`, monorepo: true, vitest: true, deployConfig: true })];
        const tile = appsTile(`intent`, panels);
        expect(tile?.repo).toBeUndefined();
        expect(tile?.props).toEqual({ repo: `intent`, monorepo: false });
        expect(contributes(`infrastructure`, `intent`, panels)).toBe(true);
    });

    it(`the old vitest extension id is gone`, () => {
        const acts = detectActivations([panel({ repo: `mono`, monorepo: true, vitest: true })], []);
        expect(acts.some(({ extension }) => extension.id === `vitest`)).toBe(false);
    });
});

/* THE CLAIM RULE'S THREE POSITIONS, exercised against a local fallback view (no first-party view ships as one
 * any more — the dev-server preview moved to the shell's Preview area — but the rule stays for third-party
 * bundles): a claiming view suppresses a fallback for its repo, and an AUXILIARY view sets `activation.repo`
 * (so the directory panel renders it and the tree marks the dir manageable) yet leaves the fallback standing,
 * because it adds a surface beside the repo's main one instead of subsuming it. */
describe(`auxiliary views`, () => {
    const register = (id: string, extra: Partial<ViewRegistration>): Disposable =>
        registerView(`test`, {
            id,
            label: id,
            surface: `directory`,
            detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: repo.repo, repo: repo.repo })),
            view: async () => await Promise.resolve({}),
            ...extra,
        });

    it(`renders for its repo AND leaves a fallback in place`, () => {
        const fallback = register(`stand-in`, { fallback: true });
        const disposable = register(`aux`, { auxiliary: true });
        const panels = [panel({ repo: `site`, hasPanel: true })];
        expect(contributes(`aux`, `site`, panels)).toBe(true);
        expect(contributes(`stand-in`, `site`, panels)).toBe(true);
        disposable.dispose();
        fallback.dispose();
    });

    it(`the same view without the flag claims the repo and suppresses the fallback`, () => {
        const fallback = register(`stand-in`, { fallback: true });
        const disposable = register(`claimer`, {});
        const panels = [panel({ repo: `site`, hasPanel: true })];
        expect(contributes(`claimer`, `site`, panels)).toBe(true);
        expect(contributes(`stand-in`, `site`, panels)).toBe(false);
        disposable.dispose();
        fallback.dispose();
    });
});

/* ACCEPTANCE is the workspace-scoped shape: ONE rail tile for the whole workspace, rooted at no repo, because a
 * user story is a promise about the product and a product is rarely one repository. That makes its detect a
 * question about the workspace ("is there anything here to test?") rather than about each repo in turn — the
 * opposite of every directory view above. */
describe(`acceptance extension`, () => {
    const tiles = (panels: PanelSummary[]) => detectActivations(panels, []).filter(({ extension }) => extension.id === `acceptance`);

    it(`contributes ONE tile for the workspace, rooted at no repo`, () => {
        const found = tiles([panel({ repo: `site`, userStories: true }), panel({ repo: `api`, userStories: true })]);
        expect(found).toHaveLength(1);
        expect(found[0]?.activation.key).toBe(`acceptance`);
        expect(found[0]?.activation.repo).toBeUndefined();
    });

    // The view is where stories are WRITTEN, so "a repo runs an app" is enough evidence to offer it: gating on
    // stories alone would mean a workspace with none could never reach the surface that creates the first one.
    it(`activates on a repo that only runs an app, so the first story can be authored`, () => {
        expect(tiles([panel({ repo: `site`, hasPanel: true })])).toHaveLength(1);
    });

    it(`stays away from a workspace with neither stories nor a runnable app`, () => {
        expect(tiles([panel({ repo: `docs` })])).toHaveLength(0);
    });

    // Rooted at no repo ⇒ it claims none: a fallback view for a repo with stories still stands.
    it(`costs no repo its own surface`, () => {
        const fallback = registerView(`test`, {
            id: `stand-in`,
            label: `Stand-in`,
            surface: `directory`,
            fallback: true,
            detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: repo.repo, repo: repo.repo })),
            view: async () => await Promise.resolve({}),
        });
        const panels = [panel({ repo: `site`, hasPanel: true, userStories: true })];
        expect(tiles(panels)).toHaveLength(1);
        expect(contributes(`stand-in`, `site`, panels)).toBe(true);
        fallback.dispose();
    });
});

// The registry outlives the host modules that write to it (it is their leaf dependency), so under a dev-server
// hot reload an extension activates a SECOND time against the SAME registry. Appending there is what put a
// duplicate of every icon on the rail.
describe(`re-activation`, () => {
    const panels = [panel({ repo: `shop`, monorepo: true })];

    it(`activating an extension again replaces its views instead of stacking duplicates`, () => {
        const before = detectActivations(panels, []);
        apps.activate(registerApi, { extensionId: `intentic.repo-apps`, subscriptions: [] });
        preview.activate(registerApi, { extensionId: `intentic.preview`, subscriptions: [] });
        expect(detectActivations(panels, []).map(({ extension }) => extension.id)).toEqual(before.map(({ extension }) => extension.id));
    });

    it(`a superseded registration's disposable cannot evict the live replacement`, () => {
        const view = (): ViewRegistration => ({
            id: `ghost`,
            label: `Ghost`,
            surface: `rail`,
            detect: () => [{ key: `ghost`, title: `Ghost` }],
            view: async () => ({}),
        });
        const stale = registerView(`test`, view());
        const live = registerView(`test`, view());
        stale.dispose();
        expect(detectActivations(panels, []).some(({ extension }) => extension.id === `ghost`)).toBe(true);
        live.dispose();
        expect(detectActivations(panels, []).some(({ extension }) => extension.id === `ghost`)).toBe(false);
    });
});

/* The rail's order is a product decision, and it used to be an accident: whatever order the core views and the
 * `builtins.ts` array happened to register in. That put Acceptance between Automations and Documentation, which
 * is not a sequence a user can infer from anything. RAIL_GROUPS now declares it — checked here rather than in a
 * surface because BOTH the desktop rail and the mobile menu render this list and must agree. */
describe(`rail order`, () => {
    const railIds = (): string[] =>
        detectActivations([panel({ repo: `demo`, hasPanel: true, userStories: true })], [])
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension }) => extension.id);

    it(`puts what summons you above what you go and consult`, () => {
        const ids = railIds();
        const rank = (id: string): number => ids.indexOf(id);
        expect(rank(`acceptance`)).toBeGreaterThanOrEqual(0);
        // Acceptance badges to fetch you; Documentation is read on your own initiative. The old table had this
        // the other way round, on the theory that you read about a system before verifying it — true of a first
        // afternoon, false of every day after.
        expect(rank(`acceptance`)).toBeLessThan(rank(`documentation`));
    });

    /* The regression that motivated the rewrite: `workflows` and `deployments` were added after the first table
     * shipped and never listed in it, so the fall-through put the two NEWEST surfaces below every core view. A
     * table that silently demotes what it does not mention is worse than no table, so every rail view a build
     * compiles in has to appear in it. */
    it(`ranks every compiled-in rail view, so none falls through to the end unnoticed`, () => {
        const listed = new Set(RAIL_GROUPS.flatMap((group) => group.ids));
        const capabilities: CapabilityFacts[] = [
            { id: `bot`, kind: `cli`, config: { provider: `discord` } },
            { id: `repos`, kind: `cli`, config: { provider: `github` } },
            { id: `production`, kind: `cli`, config: { provider: `komodo` } },
        ];
        const rail = detectActivations(
            [panel({ repo: `demo`, hasPanel: true, userStories: true, deployConfig: true, desiredState: true })],
            capabilities,
        )
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension }) => extension.id);
        expect(rail.filter((id) => !listed.has(id))).toEqual([]);
    });

    /* THE TOP OF THE COLUMN IS THE SCARCE THING, and both of these were spent badly before. Checked on railRank
     * rather than on a detected run because two of the four ids are core shell tiles, which contribute no
     * activation — the table ranks them all the same way, which is the whole reason it names them. */
    it(`keeps the busy permanent pair adjacent, with nothing seated between them`, () => {
        // Start a turn, then read what it did: the loop the rail exists to serve. Drafts and Workflows used to
        // sit in between, and both are touched by the week rather than by the minute.
        expect(railRank(`workspace`)).toBe(railRank(`agents`) + 1);
    });

    it(`seats configuration below everything that lights up`, () => {
        // Workflows is a permanent tile that never badges — it held the third seat purely by having been filed
        // beside Agents, and it belongs with the other thing you author once and leave alone.
        expect(railRank(`workflows`)).toBe(railRank(`automations`) - 1);
        for (const summons of [`drafts`, `acceptance`, `pipelines`, `deployments`, `maintenance`]) {
            expect(railRank(summons)).toBeLessThan(railRank(`workflows`));
        }
    });

    it(`heads the decisions band with Drafts, the only one where nothing moves until the owner acts`, () => {
        const judge = RAIL_GROUPS.find((group) => group.id === `judge`);
        expect(judge?.ids[0]).toBe(`drafts`);
    });

    it(`keeps an unlisted view at the end instead of letting it jump the queue`, () => {
        // A third-party extension appends; it cannot land itself between two first-party tiles by registering early.
        const stray = registerView(`test`, {
            id: `stray`,
            label: `Stray`,
            surface: `rail`,
            detect: () => [{ key: `stray`, title: `Stray` }],
            view: async () => ({}),
        });
        const ids = railIds();
        expect(ids.at(-1)).toBe(`stray`);
        stray.dispose();
    });

    it(`leaves per-repo directory panels in registration order, which the rail table says nothing about`, () => {
        // Only rail ids are ranked, and the sort is stable, so directory activations pass through untouched.
        const panels = [panel({ repo: `mono`, monorepo: true, hasPanel: true })];
        const directory = detectActivations(panels, [])
            .filter(({ extension }) => extension.surface === `directory`)
            .map(({ extension }) => extension.id);
        expect(directory).toEqual(directory.toSorted((left, right) => directory.indexOf(left) - directory.indexOf(right)));
        expect(directory.length).toBeGreaterThan(0);
    });
});
