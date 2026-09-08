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
import { describe, expect, it } from "vitest";

// Exercises each compiled-in extension package the way loadBuiltins does: activate() against a minimal fake
// IntenticApi, without the app singletons createExtensionApi pulls in. Proves the packages register a working view
// whose detect() behaves.

// The builtins list's import chain pulls every extension package, and theirs pulls app-wide singletons that read
// browser globals at module scope: hence jsdom, stood up by vitest.setup.ts before this file loads.

const { builtinModules } = await import("./builtins");
// The core views register outside builtinModules but land in the same rail column, so the glyph check below has to see
// both.
const { coreViews } = await import("../core-views/coreViews");

// A fake host that accepts every registration an extension can make. It must accept all of them, not just the one a
// test reads: activate() runs top to bottom, so a registry the stub is missing throws halfway through and later
// registrations never happen.
const capture = () => {
    const views: ViewRegistration[] = [];
    const documents: DocumentProviderRegistration[] = [];
    const api = {
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => {} };
            },
        },
        viewers: { register: () => ({ dispose: () => {} }) },
        documents: {
            register: (provider: DocumentProviderRegistration) => {
                documents.push(provider);
                return { dispose: () => {} };
            },
        },
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
// One connected capability per provider any rail view gates on. A single discord capability was not enough: a detect()
// gated on a provider the fixture never supplies returns nothing, so its icons are never collected and checks pass it
// by silently. Add a capability here whenever a rail view starts gating on a new provider.
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

// The whole-fleet guard: createExtensionApi refuses a view whose id and surface the manifest doesn't declare, and
// loadBuiltins swallows the throw into a console.error, so a drifted registration silently costs an extension every
// view registered after it. Checked across all builtins since the drift is between two files no single package's test
// compares.
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
        // Same drift, same silent cost, one contribution point over: an undeclared document provider is refused, and
        // the extension loses every registration that would have followed it.
        it(`registers only documents its manifest declares: ${id}`, () => {
            const { api, documents } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (module.manifest.contributes?.documents ?? []).map((document) => document.id);
            for (const provider of documents) {
                expect(declared).toContain(provider.id);
            }
        });
        // The map's key is how the loader pairs a daemon-listed manifest with the code compiled in here, so a key that
        // drifts from the manifest silently turns the extension into "missing" in the Extensions tab.
        it(`is keyed by its own manifest id: ${id}`, () => {
            expect(extensionIdOf(module.manifest)).toBe(id);
        });
        // Every icon an activation names must exist. `Activation.icon` is an open string in the public API, so a typo
        // in a first-party extension is not a compile or runtime error, just a blank tile invisible to any test that
        // only checks structure.
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

// No two rail tiles may share a glyph: the rail is a column of unlabelled squares, so two tiles with the same icon are
// indistinguishable without hovering both. Checked over the whole set, since a collision is a fact about the set that
// no single package's test can see.
//
// Rail only, deliberately: a directory panel and a sandbox view both carry their identity in words; only the rail asks
// a glyph to carry it alone. Core views register outside builtinModules, so they are folded in here too.
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
