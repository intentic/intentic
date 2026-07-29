import type { CapabilityFacts, ExtensionContext, IntenticApi, RepoFacts, ViewRegistration } from "@intentic/extension-api";
import * as activity from "@intentic/ext-activity";
import * as logs from "@intentic/ext-logs";
import { describe, expect, it } from "vitest";

/* Exercises each compiled-in extension package the way loadBuiltins does — activate() against a minimal fake
 * IntenticApi — WITHOUT the app singletons createExtensionApi pulls in. Proves the packages register a working
 * view whose detect() behaves, so the builtin path contributes the same activations the old inline array did. */

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
