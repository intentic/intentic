import type { IntenticApi, ViewRegistration } from "@intentic/extension-api";
import * as apps from "@intentic/ext-repo-apps";
import * as preview from "@intentic/ext-preview";
import type { PanelSummary } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { detectActivations, registerView } from "./registry";

// apps + preview are packaged extensions the app activates via loadBuiltins; the registry seeds only the still-
// static core views (infrastructure/live-status/directory-ui). Register the two packaged detects here so the
// cross-extension rules — apps claims a monorepo, preview is the dropped-when-claimed fallback — are exercised
// against the same registry the shell composes.
const registerApi = { views: { register: (view: ViewRegistration) => registerView(`test`, view) } } as unknown as IntenticApi;
apps.activate(registerApi, { extensionId: `intentic.repo-apps`, subscriptions: [] });
preview.activate(registerApi, { extensionId: `intentic.preview`, subscriptions: [] });

// A PanelSummary with everything false — override only the facts a case exercises.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
    hasPanel: false,
    running: false,
    healthy: false,
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
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
    it(`a monorepo-with-vitest gets ONE claiming tile (props.monorepo) — no duplicate ⚡ tile, preview suppressed`, () => {
        const panels = [panel({ repo: `mono`, monorepo: true, vitest: true, hasPanel: true })];
        const tile = appsTile(`mono`, panels);
        expect(tile?.repo).toBe(`mono`);
        expect(tile?.props).toEqual({ monorepo: true });
        expect(contributes(`preview`, `mono`, panels)).toBe(false);
    });

    it(`a vitest-only non-monorepo repo gets a non-claiming ⚡ tile and keeps its preview fallback`, () => {
        const panels = [panel({ repo: `lib`, vitest: true, hasPanel: true })];
        const tile = appsTile(`lib`, panels);
        expect(tile?.repo).toBeUndefined();
        expect(tile?.icon).toBe(`bolt`);
        expect(tile?.props).toEqual({ repo: `lib`, monorepo: false });
        expect(contributes(`preview`, `lib`, panels)).toBe(true);
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
