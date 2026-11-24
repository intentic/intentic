// Pins the windows a connection is finished in: which one a pending add opens at once (a device's command, a browser's
// code, a hand-driven sign-in) and on what, what each dialog is told, and the rosters and list re-read after each.
import "@intentic/testing/dom";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { CapabilityKind, CapabilityStatus, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import type { NoticeModel } from "@intentic/ui";
import { effectScope, type EffectScope, ref } from "vue";
import * as actualSandboxRpc from "../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";

// The one daemon call here: an ACP agent's sign-in, which answers with the job session to watch.
const login = jest.fn<(input: ProcedureInput<`capabilities.login`>) => Promise<{ session: string }>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ capabilities: { login } }) }));

const { handOffOf, useCapabilityPairing } = await import("./capabilityPairing");

const NOW = 1_700_000_000_000;
const connection = (
    id: string,
    kind: CapabilityKind,
    config: Record<string, string>,
    status: CapabilityStatus = { state: `pending` },
): CapabilitySummary => ({
    id,
    kind,
    status,
    config,
    secrets: [],
});
const host = (id: string, lastSeen: number | undefined): HostSummary => ({
    id,
    platform: `linux`,
    environments: [{ key: `native`, online: false }],
    online: false,
    ...(lastSeen === undefined ? {} : { lastSeen }),
});
const browser = (id: string, lastSeen: number | undefined): WebExtSummary => ({
    id,
    platform: `chrome`,
    online: false,
    ...(lastSeen === undefined ? {} : { lastSeen }),
});

describe(`the step a pending add still waits on`, () => {
    const signIn = connection(`reddit`, `browser`, { platform: `reddit` }, { state: `pending`, detail: `log in to connect your account` });
    const rebuild = connection(
        `reddit`,
        `browser`,
        { platform: `reddit` },
        { state: `pending`, detail: `rebuild the sandbox to install the browser` },
    );
    const cases: [string, CapabilityKind, CapabilitySummary, HostSummary | WebExtSummary | undefined, ReturnType<typeof handOffOf>][] = [
        [`a machine that never checked in`, `device`, connection(`linux`, `device`, {}), undefined, `pair`],
        [`a machine that checked in and sleeps`, `device`, connection(`linux`, `device`, {}), host(`linux`, NOW), undefined],
        [`a browser that never checked in`, `webext`, connection(`chrome`, `webext`, {}), browser(`chrome`, undefined), `pair`],
        [`a browser that checked in`, `webext`, connection(`chrome`, `webext`, {}), browser(`chrome`, NOW), undefined],
        [`a site account waiting on its login`, `browser`, signIn, undefined, `sign-in`],
        [`a site account waiting on a rebuild`, `browser`, rebuild, undefined, undefined],
        [`an identity waiting on its login`, `identity`, connection(`ada`, `identity`, {}), undefined, `sign-in`],
        [`a connector still applying`, `mcp`, connection(`tools`, `mcp`, {}), undefined, undefined],
    ];
    for (const [what, kind, added, peer, step] of cases) {
        it(`is ${String(step)} for ${what}`, () => {
            expect(handOffOf(kind, added, peer)).toBe(step);
        });
    }
});

describe(`a phone's pending add`, () => {
    const added = connection(`pixel`, `phone`, { platform: `android` });
    const summary = (lastSeen: number | undefined) => ({
        id: `pixel`,
        platform: `android`,
        online: false,
        wake: `none` as const,
        ...(lastSeen === undefined ? {} : { lastSeen }),
    });
    it(`waits on its code being scanned until the phone has checked in`, () => {
        expect(handOffOf(`phone`, added, undefined)).toBe(`pair`);
        expect(handOffOf(`phone`, added, summary(undefined))).toBe(`pair`);
        expect(handOffOf(`phone`, added, summary(NOW))).toBeUndefined();
    });
});

const DEVICE: CapabilityCatalogEntry = {
    id: `linux`,
    name: `Linux PC`,
    kind: `device`,
    category: `devices`,
    description: `Your Linux PC.`,
    fields: [{ key: `platform`, label: ``, value: `linux` }],
};
const CHROME: CapabilityCatalogEntry = {
    ...DEVICE,
    id: `chrome`,
    name: `Chrome`,
    kind: `webext`,
    fields: [{ key: `platform`, label: ``, value: `chrome` }],
};
const REDDIT: CapabilityCatalogEntry = {
    ...DEVICE,
    id: `reddit`,
    name: `Reddit`,
    kind: `browser`,
    fields: [{ key: `platform`, label: ``, value: `reddit` }],
};
// The Chrome family's card, carrying the store listing its connect dialog links to.
const STORE = `https://chromewebstore.google.com/detail/intentic`;
const CHROME_CARD: CapabilityContribution = {
    id: `chrome`,
    kind: `webext`,
    catalog: { name: `Chrome`, category: `devices`, description: `Your own Chrome.` },
    fields: [],
    install: STORE,
    skill: `skills/chrome/SKILL.md`,
};

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    login.mockReset();
});

const pairing = (rosters: { hosts?: readonly HostSummary[]; browsers?: readonly WebExtSummary[] } = {}) => {
    const state = {
        hosts: {
            peerFor: (id: string) => rosters.hosts?.find((found) => found.id === id),
            revoke: jest.fn<(id: string) => Promise<void>>(async () => {}),
            refresh: jest.fn(async () => {}),
        },
        browsers: {
            peerFor: (id: string) => rosters.browsers?.find((found) => found.id === id),
            revoke: jest.fn<(id: string) => Promise<void>>(async () => {}),
            refresh: jest.fn(async () => {}),
        },
        phones: {
            peerFor: (_id: string) => undefined,
            revoke: jest.fn<(id: string) => Promise<void>>(async () => {}),
            refresh: jest.fn(async () => {}),
        },
        contributionOf: (kind: CapabilityKind, id: string) => (kind === CHROME_CARD.kind && id === CHROME_CARD.id ? CHROME_CARD : undefined),
        refetch: jest.fn(),
        error: ref<NoticeModel | null>(null),
    };
    const scope = effectScope();
    scopes.push(scope);
    const { hosts, browsers, phones, ...rest } = state;
    return { state, pair: scope.run(() => useCapabilityPairing({ ...rest, peers: { device: hosts, webext: browsers, phone: phones } }))! };
};

describe(`the device dialog`, () => {
    it(`is drawn under the row it pairs, and closing it ends the pairing`, () => {
        const { pair } = pairing();
        pair.openPairing(DEVICE, connection(`linux`, `device`, { platform: `linux` }));
        expect(pair.dialog.value).toMatchObject({ id: `linux`, props: { visible: true, inline: true, id: `linux`, platform: `linux` } });
        // A computer's dialog may take the machine's own name, so it is told to follow it.
        expect(pair.dialog.value?.props).toHaveProperty(`onRenamed`);

        pair.closePairing();
        expect([pair.pairing.value, pair.dialog.value]).toEqual([undefined, undefined]);
    });

    it(`opens on the machine with its platform, its grant in its tile's words, and whether it still wears the tile's name`, () => {
        const { pair } = pairing();

        pair.openPairing(DEVICE, connection(`linux-2`, `device`, { platform: `linux`, shell: `on`, write: `on` }));
        expect(pair.pairing.value).toEqual({
            kind: `device`,
            id: `linux-2`,
            props: { platform: `linux`, permissions: `run commands, read files, write and trash files, capture the screen`, unnamed: true, renamed: false },
        });

        pair.openPairing(DEVICE, connection(`build-box`, `device`, {}));
        expect(pair.pairing.value).toMatchObject({ id: `build-box`, props: { platform: `linux`, unnamed: false, renamed: false } });
    });

    it(`follows a machine renamed to its hostname, and re-reads the roster and the list`, () => {
        const { state, pair } = pairing();
        pair.openPairing(DEVICE, connection(`linux`, `device`, { platform: `linux` }));

        pair.renamed(`radarsu-rog`);
        expect(pair.pairing.value).toMatchObject({ id: `radarsu-rog`, props: { unnamed: false, renamed: true } });
        expect(pair.dialog.value).toMatchObject({ id: `radarsu-rog`, props: { id: `radarsu-rog`, visible: true, inline: true, renamed: true } });
        pair.paired();
        expect([state.hosts.refresh.mock.calls.length, state.refetch.mock.calls.length]).toEqual([2, 2]);
    });
});

describe(`the browser dialog`, () => {
    it(`opens on the browser with its family's store listing and the sites its switches allow`, () => {
        const { state, pair } = pairing();

        pair.openPairing(CHROME, connection(`chrome`, `webext`, { platform: `chrome`, screenshot: `on` }));
        expect(pair.pairing.value).toEqual({
            kind: `webext`,
            id: `chrome`,
            props: { install: STORE, permissions: `read the pages you allow, click and type on them, take screenshots` },
        });
        // A browser's dialog takes no new name, so it is not told to follow one.
        expect(pair.dialog.value?.props).not.toHaveProperty(`onRenamed`);

        pair.paired();
        expect([state.browsers.refresh.mock.calls.length, state.refetch.mock.calls.length]).toEqual([1, 1]);
    });

    it(`links no store for a family with no listing yet`, () => {
        const { pair } = pairing();

        pair.openPairing(CHROME, connection(`edge`, `webext`, { platform: `edge` }));
        expect(pair.pairing.value?.props).toMatchObject({ install: `` });
    });
});

describe(`a paired machine or browser`, () => {
    it(`loses its access through its own door, and the list is re-read after`, async () => {
        const { state, pair } = pairing();

        await pair.removePairedAccess(CHROME, `chrome`);
        await pair.removePairedAccess(DEVICE, `linux`);
        expect([state.browsers.revoke.mock.calls, state.hosts.revoke.mock.calls, state.refetch.mock.calls.length]).toEqual([
            [[`chrome`]],
            [[`linux`]],
            2,
        ]);
    });

    it(`says so when the revoke is refused, and still re-reads the list`, async () => {
        const { state, pair } = pairing();
        state.hosts.revoke.mockRejectedValueOnce(new Error(`that machine is offline`));

        await pair.removePairedAccess(DEVICE, `linux`);
        expect([state.error.value, state.refetch.mock.calls.length]).toEqual([
            { tone: `danger`, title: `Access could not be removed.`, detail: `that machine is offline` },
            1,
        ]);
    });
});

describe(`the sign-in windows`, () => {
    it(`opens the live browser on one account, to sign in or to use it`, () => {
        const { pair } = pairing();

        pair.openBrowser(`reddit-2`, `reddit-2`);
        expect([pair.profileVisible.value, pair.profileCapability.value, pair.profileLabel.value, pair.profileMode.value]).toEqual([
            true,
            `reddit-2`,
            `reddit-2`,
            `login`,
        ]);
        pair.openBrowser(`reddit`, `reddit`, `browse`);
        expect([pair.profileCapability.value, pair.profileMode.value]).toEqual([`reddit`, `browse`]);
    });

    it(`starts an agent's own sign-in and opens its terminal, or says it could not`, async () => {
        const { state, pair } = pairing();
        login.mockResolvedValueOnce({ session: `job-claude-login` });

        await pair.startAgentLogin(`claude`);
        expect(login.mock.calls).toEqual([[{ id: `claude` }]]);
        expect(useTerminalPanel().requested.value).toEqual({ name: `job-claude-login` });

        login.mockRejectedValueOnce(new Error(`no login command`));
        await pair.startAgentLogin(`claude`);
        expect(state.error.value).toEqual({ tone: `danger`, title: `Sign-in could not start.`, detail: `no login command` });
    });
});

describe(`a pending add`, () => {
    it(`hands over the device command, the browser code or the sign-in window, on the connection just added`, () => {
        const device = pairing();
        device.pair.handOff(DEVICE, connection(`linux`, `device`, { platform: `linux` }));
        expect(device.pair.pairing.value).toMatchObject({ kind: `device`, id: `linux` });

        const own = pairing();
        own.pair.handOff(CHROME, connection(`chrome`, `webext`, { platform: `chrome` }));
        expect(own.pair.pairing.value).toMatchObject({ kind: `webext`, id: `chrome` });

        const account = pairing();
        account.pair.handOff(REDDIT, connection(`reddit-2`, `browser`, { platform: `reddit` }, { state: `pending`, detail: `log in` }));
        expect([account.pair.profileVisible.value, account.pair.profileCapability.value, account.pair.profileMode.value]).toEqual([
            true,
            `reddit-2`,
            `login`,
        ]);
    });

    it(`opens nothing for a machine that already checked in, whose row names what is left`, () => {
        const { pair } = pairing({ hosts: [host(`linux`, NOW)] });

        pair.handOff(DEVICE, connection(`linux`, `device`, { platform: `linux` }));
        expect([pair.pairing.value, pair.profileVisible.value]).toEqual([undefined, false]);
    });
});

it(`a Wear OS watch's Connect opens the same dialog knowing it is a watch, whose code the phone beside it scans`, () => {
    const { pair } = pairing();
    const watch = connection(`wrist`, `phone`, { platform: `wearos`, screen: `on`, control: `off`, apps: `on` });
    const WEAROS: CapabilityCatalogEntry = { id: `wearos`, name: `Wear OS watch`, kind: `phone`, category: `devices`, description: ``, fields: [] };
    pair.openPairing(WEAROS, watch);
    expect(pair.pairing.value).toMatchObject({ kind: `phone`, id: `wrist`, props: { platform: `wearos` } });
});

it(`a phone's Connect opens the phone dialog with its install link and grant, and its revoke reaches the phone roster`, async () => {
    const { state, pair } = pairing();
    const pixel = connection(`pixel`, `phone`, { platform: `android`, screen: `on`, control: `on`, apps: `on`, files: `off` });
    const ANDROID = {
        id: `android`,
        name: `Android phone`,
        kind: `phone`,
        category: `devices`,
        description: ``,
        fields: [],
    } as unknown as CapabilityCatalogEntry;
    pair.openPairing(ANDROID, pixel);
    expect(pair.pairing.value).toEqual({
        kind: `phone`,
        id: `pixel`,
        props: { install: ``, platform: `android`, permissions: `see the screen, tap, swipe and type in the apps you allow, open apps and links` },
    });
    await pair.removePairedAccess(ANDROID, `pixel`);
    expect(state.phones.revoke).toHaveBeenCalledWith(`pixel`);
    expect(state.hosts.revoke).not.toHaveBeenCalled();
});
