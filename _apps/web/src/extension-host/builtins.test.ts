// @vitest-environment jsdom
import type { CapabilityFacts, ExtensionContext, IntenticApi, RepoFacts, ViewRegistration } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-api";
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

const { builtins } = await import("./builtins");

const activateAndCapture = (module: { activate: (api: IntenticApi, ctx: ExtensionContext) => void }): ViewRegistration => {
    let registered: ViewRegistration | undefined;
    const api = { views: { register: (view: ViewRegistration) => ((registered = view), { dispose: () => {} }) } } as unknown as IntenticApi;
    module.activate(api, { extensionId: `test`, subscriptions: [] });
    if (registered === undefined) {
        throw new Error(`activate() registered no view`);
    }
    return registered;
};

const noRepos: readonly RepoFacts[] = [];
const discordCap: CapabilityFacts = { id: `bot`, kind: `cli`, config: { provider: `discord` } };

/* The whole-fleet guard. createExtensionApi refuses a view whose id AND surface the manifest doesn't declare,
 * and loadBuiltins swallows the throw into a console.error — so a registration that drifts from its manifest (a
 * view moved between surfaces, manifest updated, activate() call not) silently costs the extension EVERY view it
 * registers after the mismatch, with nothing failing but a console line. Checked for all builtins at once
 * because the drift is between two files that no single package's test compares. */
describe(`every builtin`, () => {
    for (const { manifest, module } of builtins) {
        const id = extensionIdOf(manifest);
        it(`registers only views its manifest declares — ${id}`, () => {
            const registered: ViewRegistration[] = [];
            const api = {
                views: { register: (view: ViewRegistration) => (registered.push(view), { dispose: () => {} }) },
                viewers: { register: () => ({ dispose: () => {} }) },
                commands: { register: () => ({ dispose: () => {} }) },
            } as unknown as IntenticApi;
            module.activate(api, { extensionId: id, subscriptions: [] });
            const declared = (manifest.contributes?.views ?? []).map((view) => `${view.id} (${view.surface})`);
            for (const view of registered) {
                expect(declared).toContain(`${view.id} (${view.surface})`);
            }
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
