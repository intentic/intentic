// @vitest-environment jsdom
import type {
    CapabilityFacts,
    DocumentProviderRegistration,
    ExtensionContext,
    IntenticApi,
    RepoFacts,
    ViewRegistration,
} from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
import { ICON_SETS } from "@intentic-app/ui";
import * as activity from "@intentic/ext-activity";
import * as logs from "@intentic/ext-logs";
import { describe, expect, it, vi } from "vitest";

/* Exercises each compiled-in extension package the way loadBuiltins does — activate() against a minimal fake
 * IntenticApi — WITHOUT the app singletons createExtensionApi pulls in. Proves the packages register a working
 * view whose detect() behaves, so the builtin path contributes the same activations the old inline array did. */

// The builtins list's import chain pulls every extension package, and theirs pulls app-wide singletons that read
// browser globals at module scope (@intentic-app/ui's useDevice reads window.matchMedia, environment.ts reads
// window.env) — hence jsdom plus the stubs, and the dynamic import below so they are installed first.
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

const { builtinModules } = await import("./builtins");

/* A fake host that accepts every registration an extension can make and records what it was handed. It has to
 * accept ALL of them, not just the one a given test reads: activate() runs top to bottom, so a registry the stub
 * is missing throws halfway through and the extension's later registrations — the ones under test — never happen.
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
};

/* The whole-fleet guard. createExtensionApi refuses a view whose id AND surface the manifest doesn't declare,
 * and loadBuiltins swallows the throw into a console.error — so a registration that drifts from its manifest (a
 * view moved between surfaces, manifest updated, activate() call not) silently costs the extension EVERY view it
 * registers after the mismatch, with nothing failing but a console line. Checked for all builtins at once
 * because the drift is between two files that no single package's test compares. */
describe(`every builtin`, () => {
    for (const [id, module] of builtinModules) {
        it(`registers only views its manifest declares — ${id}`, () => {
            const { api, views } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (module.manifest.contributes?.views ?? []).map((view) => `${view.id} (${view.surface})`);
            for (const view of views) {
                expect(declared).toContain(`${view.id} (${view.surface})`);
            }
        });
        // Same drift, same silent cost, one contribution point over: a document provider the manifest never
        // declared is refused, and the extension loses every registration that would have followed it.
        it(`registers only documents its manifest declares — ${id}`, () => {
            const { api, documents } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (module.manifest.contributes?.documents ?? []).map((document) => document.id);
            for (const provider of documents) {
                expect(declared).toContain(provider.id);
            }
        });
        // The map's key IS how the loader pairs a daemon-listed manifest with the code compiled in here, so a
        // key that drifts from the manifest silently turns the extension into "missing" in the Extensions tab.
        it(`is keyed by its own manifest id — ${id}`, () => {
            expect(extensionIdOf(module.manifest)).toBe(id);
        });
        /* Every icon an activation names must exist. `Activation.icon` is an OPEN string in the public API — a
         * third-party bundle may name an icon this app has never heard of, and the rail renders its fallback
         * rather than failing — so a typo in a FIRST-PARTY extension is not a compile error and not a runtime
         * error either: the tile just comes up blank. That shipped once (`book`, which is not in the set), and
         * a blank tile is invisible in every test that only checks structure. */
        it(`names icons that exist — ${id}`, () => {
            const { api, views: registered } = capture();
            module.activate(api, { extensionId: id, subscriptions: [] });
            const known = new Set(Object.keys(ICON_SETS.phosphor));
            // Facts generous enough that a detect() gated on evidence still produces its activations.
            const icons = registered.flatMap((view) => view.detect([richRepo], [discordCap]).flatMap((a) => (a.icon === undefined ? [] : [a.icon])));
            expect(icons.filter((icon) => !known.has(icon))).toEqual([]);
        });
    }
});

describe(`ext-logs`, () => {
    it(`registers an always-present Logs tab on the sandbox hub`, () => {
        const view = activateAndCapture(logs);
        expect(view.id).toBe(`logs`);
        expect(view.surface).toBe(`sandbox`);
        expect(view.detect(noRepos, [])).toEqual([{ key: `logs`, title: `Logs`, icon: `file` }]);
    });
});

describe(`ext-activity`, () => {
    it(`activates its rail view only when a discord cli capability is connected`, () => {
        const view = activateAndCapture(activity);
        expect(view.id).toBe(`activity`);
        expect(view.detect(noRepos, [])).toEqual([]);
        expect(view.detect(noRepos, [discordCap])).toEqual([{ key: `activity`, title: `Activity`, icon: `wave-pulse` }]);
    });
});
