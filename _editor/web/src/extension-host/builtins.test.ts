// @vitest-environment jsdom
import type {
    CapabilityFacts,
    DocumentProviderRegistration,
    ExtensionContext,
    IntenticApi,
    RepoFacts,
    ViewRegistration,
} from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { isIconName } from "@intentic/ui/icons";
import * as activity from "@intentic/ext-activity";
import * as memory from "@intentic/ext-memory";
import { describe, expect, it } from "vitest";

/* Exercises each compiled-in extension package the way loadBuiltins does: activate() against a minimal fake
 * IntenticApi: WITHOUT the app singletons createExtensionApi pulls in. Proves the packages register a working
 * view whose detect() behaves, so the builtin path contributes the same activations the old inline array did. */

// The builtins list's import chain pulls every extension package, and theirs pulls app-wide singletons that read
// browser globals at module scope (@intentic/ui's useDevice reads window.matchMedia, environment.ts reads
// window.env): hence jsdom; vitest.setup.ts stands both up before this file loads.

const { builtinModules } = await import("./builtins");
// The core views register outside builtinModules but land in the SAME rail column, so the glyph check below has
// to see both.
const { coreViews } = await import("../core-views/coreViews");

/* A fake host that accepts every registration an extension can make and records what it was handed. It has to
 * accept ALL of them, not just the one a given test reads: activate() runs top to bottom, so a registry the stub
 * is missing throws halfway through and the extension's later registrations (the ones under test) never happen.
 * That is how adding a contribution point breaks tests that have nothing to do with it. */
const capture = () => {
    const views: ViewRegistration[] = [];
    const documents: DocumentProviderRegistration[] = [];
    const api = {
        views: { register: (view: ViewRegistration) => (views.push(view), { dispose: () => {} }) },
        viewers: { register: () => ({ dispose: () => {} }) },
        documents: { register: (provider: DocumentProviderRegistration) => (documents.push(provider), { dispose: () => {} }) },
        commands: { register: () => ({ dispose: () => {} }) },
    } as unknown as IntenticApi;
    return { api, views, documents };
};

const activateAndCapture = (module: { activate: (api: IntenticApi, ctx: ExtensionContext) => void }): ViewRegistration => {
    const { api, views } = capture();
    module.activate(api, { extensionId: `test`, subscriptions: [] });
    const registered = views[0];
    if (registered === undefined) {
        throw new Error(`activate() registered no view`);
    }
    return registered;
};

const noRepos: readonly RepoFacts[] = [];
const discordCap: CapabilityFacts = { id: `bot`, kind: `cli`, config: { provider: `discord` } };
/* One connected capability per provider any rail view gates on: discord (Activity), github (Pipelines), komodo
 * (Deployments). A single discord capability was NOT enough and the gap was silent: a detect() gated on a
 * provider the fixture never supplies returns nothing, so its icons are never collected and every check below
 * passes it by. That is precisely how the `sitemap` collision reached the rail: Pipelines' glyph had never once
 * been looked at by a test. Add a capability here whenever a rail view starts gating on a new provider. */
const richCapabilities: readonly CapabilityFacts[] = [
    discordCap,
    { id: `repos`, kind: `cli`, config: { provider: `github` } },
    { id: `production`, kind: `cli`, config: { provider: `komodo` } },
];
// Every fact true, so a detect() that gates on evidence still yields its activations and its icons can be checked.
const richRepo: RepoFacts = {
    repo: `demo`,
    role: `app`,
    hasPanel: true,
    deployConfig: true,
    desiredState: true,
    directoryUi: true,
    monorepo: true,
    vitest: true,
    userStories: true,
    docs: true,
};

/* The whole-fleet guard. createExtensionApi refuses a view whose id AND surface the manifest doesn't declare,
 * and loadBuiltins swallows the throw into a console.error, so a registration that drifts from its manifest (a
 * view moved between surfaces, manifest updated, activate() call not) silently costs the extension EVERY view it
 * registers after the mismatch, with nothing failing but a console line. Checked for all builtins at once
 * because the drift is between two files that no single package's test compares. */
describe(`every builtin`, () => {
    for (const [id, module] of builtinModules) {
        it(`registers only views its manifest declares: ${id}`, () => {
            const { api, views } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (module.manifest.contributes?.views ?? []).map((view) => `${view.id} (${view.surface})`);
            for (const view of views) {
                expect(declared).toContain(`${view.id} (${view.surface})`);
            }
        });
        // Same drift, same silent cost, one contribution point over: a document provider the manifest never
        // declared is refused, and the extension loses every registration that would have followed it.
        it(`registers only documents its manifest declares: ${id}`, () => {
            const { api, documents } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (module.manifest.contributes?.documents ?? []).map((document) => document.id);
            for (const provider of documents) {
                expect(declared).toContain(provider.id);
            }
        });
        // The map's key IS how the loader pairs a daemon-listed manifest with the code compiled in here, so a
        // key that drifts from the manifest silently turns the extension into "missing" in the Extensions tab.
        it(`is keyed by its own manifest id: ${id}`, () => {
            expect(extensionIdOf(module.manifest)).toBe(id);
        });
        /* Every icon an activation names must exist. `Activation.icon` is an OPEN string in the public API: a
         * third-party bundle may name an icon this app has never heard of, and the rail renders its fallback
         * rather than failing, so a typo in a FIRST-PARTY extension is not a compile error and not a runtime
         * error either: the tile just comes up blank. That shipped once (`book`, which is not in the set), and
         * a blank tile is invisible in every test that only checks structure. */
        it(`names icons that exist: ${id}`, () => {
            const { api, views: registered } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            // Facts generous enough that a detect() gated on evidence still produces its activations.
            const icons = registered.flatMap((view) =>
                view.detect([richRepo], richCapabilities).flatMap((a) => (a.icon === undefined ? [] : [a.icon])),
            );
            expect(icons.filter((icon) => !isIconName(icon))).toEqual([]);
        });
    }
});

/* NO TWO RAIL TILES MAY SHARE A GLYPH. The rail is a column of ~44px squares with no labels: the icon IS the
 * name, so two tiles wearing the same one are two tiles the user cannot tell apart without hovering both. This
 * shipped as a THREE-way collision: `sitemap` on Workflows, Pipelines and Live status at once, which is how it
 * escaped the per-extension review that caught `cog` and `list-check` individually. No single package's test
 * could see it: a collision is a fact about the SET, so it is checked over the set.
 *
 * Rail only, deliberately. A `directory` panel is opened from the Workspace tree beside its repo's name and a
 * `sandbox` view is a labelled tab, so both carry their identity in words; only the rail asks a glyph to carry
 * it alone. Core views (Infrastructure, Live status) register outside builtinModules, so they are folded in
 * here: the user sees one column, not two registration paths. */
describe(`rail glyphs`, () => {
    it(`gives every rail tile an icon no other rail tile uses`, () => {
        const registrations = [...builtinModules.values()].flatMap((module) => {
            const { api, views } = capture();
            module.activate(api, { extensionId: `test`, subscriptions: [] });
            return views;
        });
        const owners = new Map<string, string[]>();
        for (const view of [...registrations, ...coreViews].filter((registered) => registered.surface === `rail`)) {
            for (const { icon } of view.detect([richRepo], richCapabilities)) {
                if (icon === undefined) {
                    continue;
                }
                owners.set(icon, [...(owners.get(icon) ?? []), view.id]);
            }
        }
        // Reported as the whole map of offenders rather than a count, so a failure names which tiles clash.
        expect(Object.fromEntries([...owners].filter(([, ids]) => ids.length > 1))).toEqual({});
    });
});

describe(`ext-activity`, () => {
    it(`always activates a sandbox-hub section, independent of privileged capability facts`, () => {
        const view = activateAndCapture(activity);
        expect(view.id).toBe(`activity`);
        // A hub section, not a rail tile: the feed never badges, so it could not earn a permanent icon seat.
        expect(view.surface).toBe(`sandbox`);
        expect(view.detect(noRepos, [])).toEqual([{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]);
        expect(view.detect(noRepos, [discordCap])).toEqual([{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]);
    });
});

describe(`ext-memory`, () => {
    it(`registers an always-present Memory section on the sandbox hub`, () => {
        const view = activateAndCapture(memory);
        expect(view.id).toBe(`memory`);
        // Same reasoning as logs and activity: the agent's notebook has nothing to announce.
        expect(view.surface).toBe(`sandbox`);
        expect(view.detect(noRepos, [])).toEqual([{ key: `memory`, title: `Memory`, icon: `sparkles` }]);
    });
});
