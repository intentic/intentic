import type { CapabilityFacts, Disposable, IntenticApi, ViewBadge, ViewRegistration } from "@intentic/extension-api";
import * as acceptance from "@intentic/ext-acceptance";
import * as documentation from "@intentic/ext-documentation";
import * as apps from "@intentic/ext-repo-apps";
import * as preview from "@intentic/ext-preview";
import type { PanelSummary } from "@intentic/api-contract";
import { describe, expect, it } from "vitest";
import { activationBadge, RAIL_GROUPS, detectActivations, railRank, railSeated, registerView, seatPolicy, seatedOnlyByVisit } from "./registry";
import { badgeChip } from "./viewBadge";

// Registers packaged extensions' detects against the same registry the shell composes, so cross-extension
// rules (claiming, fallback) are exercised for real. `commands`/`viewers` stubs just keep activate() from throwing.
const registerApi = {
    views: { register: (view: ViewRegistration) => registerView(`test`, view) },
    viewers: { register: (): Disposable => ({ dispose: () => {} }) },
    // Accepted and dropped: this file is about the rail, not a broken registry stopping tested views.
    documents: { register: (): Disposable => ({ dispose: () => {} }) },
    commands: { register: (): Disposable => ({ dispose: () => {} }) },
} as unknown as IntenticApi;
apps.activate(registerApi, { extensionId: `intentic.repo-apps`, subscriptions: [] });
preview.activate(registerApi, { extensionId: `intentic.preview`, subscriptions: [] });
acceptance.activate(registerApi, { extensionId: `intentic.acceptance`, subscriptions: [] });
// The rail-order cases need a listed rail view whose position wasn't accidental; the badge poll is harmless.
documentation.activate(registerApi, { extensionId: `intentic.documentation`, subscriptions: [] });

// A PanelSummary with everything false; override only the facts a case exercises.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
    hasPanel: false,
    installed: true,
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
    it(`excludes the intent/infrastructure repo: it surfaces as Infrastructure, not as an app monorepo`, () => {
        const ids = idsFor(`intentic-app`, [panel({ repo: `intentic-app`, deployConfig: true, monorepo: true })]);
        expect(ids).toContain(`infrastructure`);
        expect(ids).not.toContain(`apps`);
    });

    it(`still surfaces a plain monorepo as an app monorepo`, () => {
        expect(idsFor(`shop`, [panel({ repo: `shop`, monorepo: true })])).toContain(`apps`);
    });
});

// The `apps` extension's tile for a repo, whether it claims it (monorepo) or just rides in props
// (vitest-only), keyed by the tile key (always the repo name). `idsFor` above only sees claiming tiles.
const appsTile = (key: string, panels: PanelSummary[]) =>
    detectActivations(panels, []).find(({ extension, activation }) => extension.id === `apps` && activation.key === key)?.activation;
const contributes = (id: string, key: string, panels: PanelSummary[]): boolean =>
    detectActivations(panels, []).some(({ extension, activation }) => extension.id === id && activation.key === key);

describe(`apps extension, merged tests view`, () => {
    it(`a monorepo-with-vitest gets ONE claiming tile (props.monorepo): no duplicate ⚡ tile`, () => {
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

// The claim rule's three positions: a claiming view suppresses a fallback for its repo; an auxiliary view
// sets `activation.repo` but leaves the fallback standing, adding a surface beside the main one rather than subsuming
// it.
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

// Acceptance is workspace-scoped: one rail tile for the whole workspace, rooted at no repo, since a user
// story is a promise about the product, not one repository. Its detect asks about the workspace, not each repo in turn.
describe(`acceptance extension`, () => {
    const tiles = (panels: PanelSummary[]) => detectActivations(panels, []).filter(({ extension }) => extension.id === `acceptance`);

    it(`contributes ONE tile for the workspace, rooted at no repo`, () => {
        const found = tiles([panel({ repo: `site`, userStories: true }), panel({ repo: `api`, userStories: true })]);
        expect(found).toHaveLength(1);
        expect(found[0]?.activation.key).toBe(`acceptance`);
        expect(found[0]?.activation.repo).toBeUndefined();
    });

    // The view is where stories are written, so "a repo runs an app" is enough evidence to offer it: gating on
    // stories alone would strand a workspace with none.
    it(`activates on a repo that only runs an app, so the first story can be authored`, () => {
        expect(tiles([panel({ repo: `site`, hasPanel: true })])).toHaveLength(1);
    });

    it(`stays away from a workspace with neither stories nor a runnable app`, () => {
        expect(tiles([panel({ repo: `docs` })])).toHaveLength(0);
    });

    // Rooted at no repo means it claims none: a fallback view for a repo with stories still stands.
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

// The registry outlives the host modules that write to it, so a dev-server hot reload activates an
// extension a second time against the same registry. Appending there is what put a duplicate of every icon on the rail.
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

// The rail's order is a product decision, not an accident of registration order (Acceptance landed between
// Automations and Documentation for no reason). RAIL_GROUPS declares it; checked here since the rail and mobile menu
// must agree.
describe(`rail order`, () => {
    const railIds = (): string[] =>
        detectActivations([panel({ repo: `demo`, hasPanel: true, userStories: true })], [])
            .filter(({ extension }) => extension.surface === `rail`)
            .map(({ extension }) => extension.id);

    it(`puts what summons you above what you go and consult`, () => {
        const ids = railIds();
        const rank = (id: string): number => ids.indexOf(id);
        expect(rank(`acceptance`)).toBeGreaterThanOrEqual(0);
        // Acceptance badges to fetch you; Documentation is read on your own initiative, not before verifying a system.
        expect(rank(`acceptance`)).toBeLessThan(rank(`documentation`));
    });

    // The regression that motivated the rewrite: `workflows` and `deployments` were added after the first table
    // shipped and never listed, so they fell through below every core view. Every compiled-in rail view must appear in
    // it.
    it(`ranks every compiled-in rail view, so none falls through to the end unnoticed`, () => {
        const listed = new Set(RAIL_GROUPS.flatMap((group) => group.items.map((item) => item.id)));
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

    // The top of the column is the scarce thing. Checked on railRank rather than a detected run, since two of
    // the four ids are core shell tiles that contribute no activation.
    it(`keeps the busy permanent pair adjacent, with nothing seated between them`, () => {
        // Start a turn, read what it did: the loop the rail serves. Approvals/Workflows used to sit between them.
        expect(railRank(`workspace`)).toBe(railRank(`agents`) + 1);
    });

    it(`seats configuration below everything that lights up`, () => {
        // Workflows never badges; it held the third seat only by being filed beside Agents.
        expect(railRank(`workflows`)).toBe(railRank(`automations`) - 1);
        for (const summons of [`approvals`, `acceptance`, `pipelines`, `deployments`, `maintenance`]) {
            expect(railRank(summons)).toBeLessThan(railRank(`workflows`));
        }
    });

    it(`heads the decisions band with Approvals, the only one where nothing moves until the owner acts`, () => {
        const judge = RAIL_GROUPS.find((group) => group.id === `judge`);
        expect(judge?.items[0]?.id).toBe(`approvals`);
    });

    it(`keeps an unlisted view at the end instead of letting it jump the queue`, () => {
        // A third-party extension appends; it can't land between two first-party tiles by registering early.
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

    it(`keeps the seat table and the rank table naming the same ids, so no tile sorts into a band it can't sit in`, () => {
        // Both are read off RAIL_GROUPS, so this fails only if an id is added to one derived list, not the other.
        for (const item of RAIL_GROUPS.flatMap((group) => group.items)) {
            expect(railRank(item.id)).toBeLessThan(RAIL_GROUPS.flatMap((group) => group.items).length);
            expect([`always`, `signal`]).toContain(seatPolicy(item.id));
        }
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

// Which tiles are on the column at all: the rail's scarce resource is seats, roughly nine fit above a
// 945px viewport. The rule is stated in registry.ts; this is it holding.
describe(`rail seats`, () => {
    const resting = { pinned: false, active: false };

    it(`seats a permanent area with nothing to report: it is where you GO`, () => {
        expect(railSeated({ id: `agents` }, resting)).toBe(true);
        expect(railSeated({ id: `workspace` }, resting)).toBe(true);
        expect(railSeated({ id: `chat` }, resting)).toBe(true);
        // Preview's badge is an inventory ("2 running"), not a claim; it holds its seat on the other half of the rule.
        expect(railSeated({ id: `preview` }, resting)).toBe(true);
    });

    it(`keeps a quiet queue off the rail, and seats it the moment it owes the owner something`, () => {
        // The whole complaint this table answers: Approvals was permanent, carrying a tile for an empty queue all day.
        expect(railSeated({ id: `approvals` }, resting)).toBe(false);
        expect(railSeated({ id: `approvals`, badge: { count: 3, tooltip: `3 waiting on you` } }, resting)).toBe(true);
    });

    it(`keeps the surfaces you author once and leave alone off it until a run needs you`, () => {
        for (const shelf of [`workflows`, `automations`]) {
            expect(railSeated({ id: shelf }, resting)).toBe(false);
            expect(railSeated({ id: shelf, badge: { count: 1 } }, resting)).toBe(true);
        }
    });

    it(`never retires the area the reader is standing in`, () => {
        // Opened from More, a silent area would otherwise have no tile lit while its own view is on screen.
        expect(railSeated({ id: `automations` }, { pinned: false, active: true })).toBe(true);
    });

    it(`lets a pin overrule the table for one route without touching the others`, () => {
        expect(railSeated({ id: `deployments` }, { pinned: true, active: false })).toBe(true);
        expect(railSeated({ id: `deployments` }, resting)).toBe(false);
    });

    it(`knows which seat is only a visit, so the tile can say so before it goes`, () => {
        const visiting = { pinned: false, active: true };
        // The case the label is for: opened from More, nothing else holding it up, gone when the reader leaves.
        expect(seatedOnlyByVisit({ id: `automations` }, visiting)).toBe(true);
        // Everything with a second clause behind it keeps its seat after the visit: permanent, pinned, or badging.
        expect(seatedOnlyByVisit({ id: `workspace` }, visiting)).toBe(false);
        expect(seatedOnlyByVisit({ id: `automations` }, { pinned: true, active: true })).toBe(false);
        expect(seatedOnlyByVisit({ id: `approvals`, badge: { count: 3 } }, visiting)).toBe(false);
        // A claim about the tile you're ON: an area you aren't in is either seated for its own reason or not at all.
        expect(seatedOnlyByVisit({ id: `automations` }, resting)).toBe(false);
    });

    it(`says only-a-visit exactly where railSeated rests on the visit alone`, () => {
        // The two are one rule read twice, checked against each other rather than a list copied from the table.
        const cases = [
            { id: `workspace` },
            { id: `automations` },
            { id: `documentation` },
            { id: `some-third-party-view` },
            { id: `approvals`, badge: { count: 1 } },
        ] as const;
        for (const pinned of [false, true]) {
            for (const tile of cases) {
                const stillSeatedAfterwards = railSeated(tile, { pinned, active: false });
                expect(seatedOnlyByVisit(tile, { pinned, active: true })).toBe(!stillSeatedAfterwards);
            }
        }
    });

    it(`gives an unlisted third-party view the same terms as a first-party one`, () => {
        // Not `always`: a bundle can't take one of nine seats by registering; it's seated exactly when it badges.
        expect(seatPolicy(`some-third-party-view`)).toBe(`signal`);
        expect(railSeated({ id: `some-third-party-view` }, resting)).toBe(false);
        expect(railSeated({ id: `some-third-party-view`, badge: { mark: `arrow-up` } }, resting)).toBe(true);
    });

    it(`seats a tile whose only news is that something is running there`, () => {
        // The rail has always seated live work — an open browser, a subagent, a workflow run — so a pipeline in
        // flight earns the same seat. Waiting for it to FAIL before showing a tile hides the half hour when
        // watching it is the point.
        expect(railSeated({ id: `pipelines`, badge: { running: `1 running` } }, resting)).toBe(true);
        // And it is a seat of its own, so it outlives the visit exactly like a count does.
        expect(seatedOnlyByVisit({ id: `pipelines`, badge: { running: `1 running` } }, { pinned: false, active: true })).toBe(false);
    });

    it(`spends permanent seats on the work loop and nowhere else`, () => {
        // The count is the point: four fits above the fold, room for what lights up. A fifth means editing this.
        const permanent = RAIL_GROUPS.flatMap((group) => group.items)
            .filter((item) => item.seat === `always`)
            .map((item) => item.id);
        expect(permanent).toEqual([`chat`, `agents`, `workspace`, `preview`]);
    });
});

// Two claims a tile can make, and the rule that keeps them apart: what is OWED wears the chip, what is HAPPENING wears
// the turning mark. Both are the same badge, so a view says both at once instead of one evicting the other.
describe(`what a badge says`, () => {
    const badgeOf = (badge: ViewBadge | undefined): ViewBadge | undefined =>
        activationBadge({
            extension: { id: `probe`, label: `Probe`, surface: `rail`, detect: () => [], view: async () => ({}), badge: () => badge },
            activation: { key: `probe`, title: `Probe` },
        });

    it(`drops one with nothing to say, so every surface can go on testing presence alone`, () => {
        expect(badgeOf(undefined)).toBeUndefined();
        expect(badgeOf({ count: 0 })).toBeUndefined();
        expect(badgeOf({ tooltip: `a sentence about nothing` })).toBeUndefined();
    });

    it(`keeps one whose only news is a run in flight`, () => {
        expect(badgeOf({ running: `2 running` })?.running).toBe(`2 running`);
    });

    it(`carries the count and the run together, since a red branch is usually red WHILE its fix runs`, () => {
        expect(badgeOf({ count: 2, tone: `danger`, tooltip: `main is broken`, running: `1 running` })).toMatchObject({
            count: 2,
            running: `1 running`,
        });
    });

    it(`gives the running mark no chip to draw: a plate is what an errand wears`, () => {
        expect(badgeChip({ running: `2 running` })).toBe(false);
        expect(badgeChip({ count: 2 })).toBe(true);
        expect(badgeChip({ mark: `arrow-up` })).toBe(true);
        expect(badgeChip({ count: 0, running: `2 running` })).toBe(false);
    });
});
