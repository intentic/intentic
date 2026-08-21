import type { ExtensionManifest } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { sandboxRef } from "@intentic/extension-api";
import { beforeEach, expect, test, vi } from "vitest";

/* THE SWITCH, AT THE LOADER'S GRAIN: that pointing the browser at another sandbox drops everything this host
 * was holding on the last one's behalf, and that a load pass overtaken by a switch cannot put any of it back.
 *
 * The second half is the one worth a test. A pass is several awaits long (the list, then a settings read, a
 * bundle fetch and an activate() per extension), so the retire can land in the middle of one, and a pass that
 * carried on would interleave two sandboxes' extensions rather than replacing one with the other. It is
 * timing-dependent by nature, which is precisely why it is pinned here rather than left to be noticed. */

const state = vi.hoisted(() => ({
    activated: [] as string[],
    deactivatedAll: 0,
    // The compiled-in modules the loader finds. Populated per test, so an extension activates without the blob
    // import a bundle fetch would need, which no node test environment can perform.
    builtins: new Map<string, { manifest: ExtensionManifest; activate: () => void }>(),
    // The daemon's extension list, as a thunk so a test can hold the answer and stage a switch mid-pass.
    list: (): Promise<unknown> => Promise.resolve({ extensions: [], invalid: [] }),
    // What runActivate awaits before it registers: the seam the overtaking test squeezes into.
    settingsLoad: (): Promise<void> => Promise.resolve(),
}));

vi.mock(`./apiImpl`, () => ({
    createExtensionApi: (summary: { id: string }) => {
        state.activated.push(summary.id);
        return { api: {}, context: { extensionId: summary.id, subscriptions: [] } };
    },
    deactivateExtension: () => {},
    deactivateAllExtensions: () => void (state.deactivatedAll += 1),
}));
vi.mock(`./builtins`, () => ({ builtinModules: state.builtins }));
vi.mock(`../composables/extensions/useExtensionSettings`, () => ({
    extensionSettingsStore: () => ({ load: () => state.settingsLoad() }),
}));
vi.mock(`../composables/sandbox/sandboxClient`, () => ({
    sandboxJson: () => state.list(),
    sandboxRequest: () => Promise.resolve(new Response(``)),
    sandboxError: (response: Response) => new Error(String(response.status)),
}));

const { extensionsLoaded, extensionStatuses, loadExtensions, retireExtensions } = await import("./loader");

const manifest = (name: string, settings = false): ExtensionManifest =>
    ({
        publisher: `intentic`,
        name,
        version: `1.0.0`,
        category: `workflow`,
        engines: { intentic: `^2.0.0` },
        contributes: { views: [{ id: name, label: name, surface: `rail` }], ...(settings ? { settings: [{ key: `a` }] } : {}) },
    }) as unknown as ExtensionManifest;

// A listed extension whose code is compiled in: the first-party shape, and the one that needs no bundle fetch.
const compiled = (name: string, settings = false): ExtensionSummary => {
    const declared = manifest(name, settings);
    state.builtins.set(`intentic.${name}`, { manifest: declared, activate: () => {} });
    return { id: name, manifest: declared, commit: `abc`, source: `builtin`, enabled: true };
};

const bindings = { repos: () => [], capabilities: () => [] };

beforeEach(() => {
    state.builtins.clear();
    state.list = () => Promise.resolve({ extensions: [], invalid: [] });
    state.settingsLoad = () => Promise.resolve();
    retireExtensions();
    state.activated.length = 0;
    state.deactivatedAll = 0;
});

test(`an ordinary pass activates what the sandbox lists and reports it as final`, async () => {
    const only = compiled(`maintenance`);
    state.list = () => Promise.resolve({ extensions: [only], invalid: [] });

    await loadExtensions(bindings);

    expect(state.activated).toEqual([`maintenance`]);
    expect(extensionsLoaded.value).toBe(true);
    expect(extensionStatuses.value.map((status) => status.state)).toEqual([`active`]);
});

test(`retiring drops the activations, the record of them, and the extensions' own state`, async () => {
    const badge = sandboxRef(() => 0);
    state.list = () => Promise.resolve({ extensions: [compiled(`maintenance`)], invalid: [] });
    await loadExtensions(bindings);
    badge.value = 21;

    retireExtensions();

    expect(state.deactivatedAll).toBe(1);
    // The reported bug, in one assertion: the count the previous sandbox filled in is gone before the next
    // sandbox has been asked anything.
    expect(badge.value).toBe(0);
    expect(extensionStatuses.value).toEqual([]);
    expect(extensionsLoaded.value).toBe(false);
});

test(`a pass whose list arrives after a switch activates nothing`, async () => {
    const only = compiled(`maintenance`);
    let answer = (): void => {};
    state.list = () =>
        new Promise((resolve) => {
            answer = () => resolve({ extensions: [only], invalid: [] });
        });

    const pass = loadExtensions(bindings);
    retireExtensions();
    answer();
    await pass;

    expect(state.activated).toEqual([]);
    expect(extensionsLoaded.value).toBe(false);
});

test(`a pass overtaken while activating registers nothing and publishes nothing`, async () => {
    // A settings read is the pass's own await inside runActivate; holding it puts the switch exactly where the
    // race lives: after the list has been believed, before anything reaches the rail.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    state.settingsLoad = () => held;
    state.list = () => Promise.resolve({ extensions: [compiled(`maintenance`, true)], invalid: [] });

    const pass = loadExtensions(bindings);
    // Let the list resolve and the activation reach its held read.
    await Promise.resolve();
    await Promise.resolve();
    retireExtensions();
    release();
    await pass;

    expect(state.activated).toEqual([]);
    expect(extensionsLoaded.value).toBe(false);
});

test(`the pass after a switch is the one that counts: its writes land`, async () => {
    const badge = sandboxRef(() => 0);
    badge.value = 21;

    retireExtensions();
    state.list = () => Promise.resolve({ extensions: [compiled(`maintenance`)], invalid: [] });
    await loadExtensions(bindings);
    badge.value = 3;

    expect(state.activated).toEqual([`maintenance`]);
    expect(badge.value).toBe(3);
    expect(extensionsLoaded.value).toBe(true);
});
