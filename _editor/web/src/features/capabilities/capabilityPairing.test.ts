// Pins the windows a connection is finished in: which one a pending add opens at once (a device's command, a browser's
// code, a hand-driven sign-in) and on what, what each dialog is told, and the rosters and list re-read after each.
import "@intentic/testing/dom";
import type { CapabilityStatus, CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import type { CapabilityKind, HostSummary, WebExtSummary } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { effectScope, type EffectScope, ref } from "vue";
import * as actualSandboxRpc from "../sandbox/client/sandboxRpc";
import type { ProcedureInput } from "../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";
import { useTerminalPanel } from "../terminal/useTerminalPanel";

// The one daemon call here: an ACP agent's sign-in, which answers with the job session to watch.
const login = jest.fn<(input: ProcedureInput<`capabilities.login`>) => Promise<{ session: string }>>();
// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../sandbox/client/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ capabilities: { login } }) }));

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
    const cases: [string, CapabilityKind, CapabilitySummary, HostSummary | undefined, WebExtSummary | undefined, ReturnType<typeof handOffOf>][] = [
        [`a machine that never checked in`, `device`, connection(`linux`, `device`, {}), undefined, undefined, `pair-device`],
        [`a machine that checked in and sleeps`, `device`, connection(`linux`, `device`, {}), host(`linux`, NOW), undefined, undefined],
        [`a browser that never checked in`, `webext`, connection(`chrome`, `webext`, {}), undefined, browser(`chrome`, undefined), `pair-browser`],
        [`a browser that checked in`, `webext`, connection(`chrome`, `webext`, {}), undefined, browser(`chrome`, NOW), undefined],
        [`a site account waiting on its login`, `browser`, signIn, undefined, undefined, `sign-in`],
        [`a site account waiting on a rebuild`, `browser`, rebuild, undefined, undefined, undefined],
        [`an identity waiting on its login`, `identity`, connection(`ada`, `identity`, {}), undefined, undefined, `sign-in`],
        [`a connector still applying`, `mcp`, connection(`tools`, `mcp`, {}), undefined, undefined, undefined],
    ];
    for (const [what, kind, added, onHost, onBrowser, step] of cases) {
        it(`is ${String(step)} for ${what}`, () => {
            expect(handOffOf(kind, added, onHost, onBrowser)).toBe(step);
        });
    }
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
        contributionOf: (kind: CapabilityKind, id: string) => (kind === CHROME_CARD.kind && id === CHROME_CARD.id ? CHROME_CARD : undefined),
        refetch: jest.fn(),
        error: ref<NoticeModel | null>(null),
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, pair: scope.run(() => useCapabilityPairing(state))! };
};

describe(`the device dialog`, () => {
    it(`opens on the machine with its platform, its grant in its tile's words, and whether it still wears the tile's name`, () => {
        const { pair } = pairing();

        pair.openPairing(DEVICE, connection(`linux-2`, `device`, { platform: `linux`, shell: `on`, write: `on` }));
        expect([pair.connectVisible.value, pair.connectId.value, pair.connectPlatform.value, pair.connectUnnamed.value]).toEqual([
            true,
            `linux-2`,
            `linux`,
            true,
        ]);
        expect(pair.connectPermissions.value).toBe(`run commands, read files, write and trash files, capture the screen`);

        pair.openPairing(DEVICE, connection(`build-box`, `device`, {}));
        expect([pair.connectId.value, pair.connectPlatform.value, pair.connectUnnamed.value]).toEqual([`build-box`, `linux`, false]);
    });

    it(`follows a machine renamed to its hostname, and re-reads the roster and the list`, () => {
        const { state, pair } = pairing();
        pair.openPairing(DEVICE, connection(`linux`, `device`, { platform: `linux` }));

        pair.onHostRenamed(`radarsu-rog`);
        expect([pair.connectId.value, pair.connectUnnamed.value]).toEqual([`radarsu-rog`, false]);
        pair.onHostConnected();
        expect([state.hosts.refresh.mock.calls.length, state.refetch.mock.calls.length]).toEqual([2, 2]);
    });
});

describe(`the browser dialog`, () => {
    it(`opens on the browser with its family's store listing and the sites its switches allow`, () => {
        const { state, pair } = pairing();

        pair.openPairing(CHROME, connection(`chrome`, `webext`, { platform: `chrome`, screenshot: `on` }));
        expect([pair.browserConnectVisible.value, pair.browserConnectId.value, pair.browserInstall.value, pair.browserPermissions.value]).toEqual([
            true,
            `chrome`,
            STORE,
            `read the pages you allow, click and type on them, take screenshots`,
        ]);
        expect(pair.connectVisible.value).toBe(false);

        pair.onBrowserExtConnected();
        expect([state.browsers.refresh.mock.calls.length, state.refetch.mock.calls.length]).toEqual([1, 1]);
    });

    it(`links no store for a family with no listing yet`, () => {
        const { pair } = pairing();

        pair.openPairing(CHROME, connection(`edge`, `webext`, { platform: `edge` }));
        expect(pair.browserInstall.value).toBe(``);
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
        expect([device.pair.connectVisible.value, device.pair.connectId.value]).toEqual([true, `linux`]);

        const own = pairing();
        own.pair.handOff(CHROME, connection(`chrome`, `webext`, { platform: `chrome` }));
        expect([own.pair.browserConnectVisible.value, own.pair.browserConnectId.value]).toEqual([true, `chrome`]);

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
        expect([pair.connectVisible.value, pair.browserConnectVisible.value, pair.profileVisible.value]).toEqual([false, false, false]);
    });
});
