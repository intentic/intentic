import "@intentic/testing/dom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { KeyringEntry, KeyringStatus } from "./keyringCommands";

// The Passwords app's port on this computer, against Tauri's own IPC mock standing in for keyring.rs: the machine's
// status read as the app's (no agent, an old one, not set up, ready), an entry's rules read as places and its shares as
// access by sandbox name, and every app verb sent as one command whose input is the call's argument, never its words.

const { registerDesktopCatalog } = await import("../i18n");
await registerDesktopCatalog();
const { itemOf, sandboxLabel, tauriPasswordsPort, vaultOf } = await import("./tauriPort");

const KEYS = { seal: `A`.repeat(43), inbox: `B`.repeat(43) };
const SHOP = `https://shop-574ea8038415.intentic.app`;
const READY: KeyringStatus = {
    installed: true,
    running: true,
    setUp: true,
    askpass: { installed: false },
    state: { version: `1.344.0`, locked: true, unlock: [`passphrase`], keys: KEYS, pendingInbox: 2 },
};
const SETTINGS = { remember: { browser: false, terminal: false, apps: false, phone: false, sandbox: false }, neverSave: [], autoLockMinutes: 15, lockOnSleep: true, rememberAskedAt: 1 };

describe(`vaultOf`, () => {
    it(`reads no agent, an agent too old, a computer not set up and a ready vault`, () => {
        expect(vaultOf(undefined, `rog`, true)).toMatchObject({ kind: `unavailable`, reason: expect.stringContaining(`no Intentic agent`) });
        const bare: KeyringStatus = { installed: true, running: true, setUp: false, askpass: { installed: false } };
        expect(vaultOf(bare, `rog`, true)).toMatchObject({ kind: `not-set-up`, canSetUp: false, why: expect.stringContaining(`too old`) });
        expect(vaultOf({ ...bare, support: { canSetUp: true, hello: true, platform: `windows` } }, `rog`, true)).toEqual({
            kind: `not-set-up`,
            canSetUp: true,
            why: undefined,
            hello: true,
            computer: `rog`,
        });
        const ready: KeyringStatus = {
            installed: true,
            running: true,
            setUp: true,
            askpass: { installed: true },
            state: { version: `1`, locked: true, unlock: [`hello`], keys: KEYS, pendingInbox: 0, pendingCaptures: 2 },
        };
        expect(vaultOf(ready, `rog`, false)).toMatchObject({ kind: `ready`, locked: true, pendingCaptures: 2, rememberAsked: false, computer: `rog` });
    });
});

describe(`itemOf`, () => {
    const entry: KeyringEntry = {
        name: `GIT_GITHUB_COM`,
        kind: `password`,
        programs: [],
        packages: [],
        hosts: [`github.com`],
        anyField: false,
        askpass: [`git:https://github.com`],
        source: `keyring`,
        shares: [{ sandbox: `574ea8038415`, machine: `rog`, mode: `while-here`, sharedAt: 5 }],
        createdAt: 1,
        updatedAt: 2,
        fresh: true,
    };

    it(`names the places it works, its kind, and each sandbox that may use it`, () => {
        const item = itemOf(entry, (sandbox) => ({ url: sandbox === `574ea8038415` ? SHOP : sandbox, label: `shop` }));
        expect(item.origins).toEqual([{ kind: `git`, url: `https://github.com` }]);
        expect(item.title).toBe(`git github.com`);
        expect(item.category).toBe(`terminal`);
        expect(item.fresh).toBe(true);
        expect(item.access).toEqual([{ sandbox: { url: SHOP, label: `shop` }, level: `while-here`, since: 5 }]);
        expect(sandboxLabel(SHOP)).toBe(`shop`);
    });
});

describe(`tauriPasswordsPort`, () => {
    let calls: { command: string; args: Record<string, unknown> }[] = [];
    beforeEach(() => {
        calls = [];
        mockIPC((command, args) => {
            // SAFETY: every command here is invoked with a plain object of arguments, or none.
            calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
            if (command === `machine_report`) {
                return JSON.stringify({ device: { links: [{ sandboxUrl: SHOP, id: `574ea8038415` }] }, sync: { hostname: `rog` } });
            }
            return JSON.stringify({ ok: true, outcome: `saved`, name: `GITHUB_COM`, saved: 1, updated: 0, unchanged: 0, skipped: 0 });
        });
    });
    afterEach(() => clearMocks());

    it(`detects the separately outdated keyring before loading, and updates only at the person's word`, async () => {
        let outdated = true;
        mockIPC((command, args) => {
            // SAFETY: these commands send a plain argument object, or no arguments, through Tauri IPC.
            calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
            if (command === `keyring_status`) {
                return JSON.stringify({ ok: true, ...READY });
            }
            if (command === `keyring_upgrade`) {
                outdated = false;
                return JSON.stringify({ ok: true, upgraded: true, from: `1.344.0`, to: `1.345.0` });
            }
            if (command === `keyring_app`) {
                return JSON.stringify(outdated
                    ? { ok: false, code: `bad-grant`, refusal: `That is not a request this keyring reads: is the caller a different version?` }
                    : { ok: true, settings: SETTINGS });
            }
            return JSON.stringify({ device: { links: [] }, sync: { hostname: `rog` } });
        });
        const port = tauriPasswordsPort();
        const status = await port.status();
        expect(status.kind).toBe(`unavailable`);
        if (status.kind !== `unavailable`) {
            throw new Error(`An old keyring must offer its update before loading the app.`);
        }
        expect(status.reason).toContain(`version 1.344.0`);
        expect(status.fix?.label).toBe(`Update Passwords`);
        expect(calls.map((call) => call.command)).toEqual([`machine_report`, `keyring_status`, `keyring_app`]);
        expect(calls[2]?.args).toEqual({ op: `settings`, input: {} });
        await status.fix?.run();
        expect(calls[3]?.command).toBe(`keyring_upgrade`);
        expect(await port.status()).toMatchObject({ kind: `ready`, locked: true, rememberAsked: true });
    });

    it(`uses the protocol probe, so a compatible keyring can be a different release`, async () => {
        mockIPC((command) => {
            if (command === `keyring_status`) {
                return JSON.stringify({ ok: true, ...READY });
            }
            if (command === `keyring_app`) {
                return JSON.stringify({ ok: true, settings: SETTINGS });
            }
            return JSON.stringify({ device: { links: [] }, sync: { hostname: `rog` } });
        });
        expect(await tauriPasswordsPort().status()).toMatchObject({ kind: `ready`, locked: true, rememberAsked: true });
    });

    it(`keeps an ordinary refusal and an update refusal in the keyring's own words`, async () => {
        mockIPC((command) => {
            if (command === `keyring_status`) {
                return JSON.stringify({ ok: true, ...READY });
            }
            if (command === `machine_report`) {
                return JSON.stringify({ device: { links: [] }, sync: { hostname: `rog` } });
            }
            return JSON.stringify({ ok: false, code: `busy`, refusal: `Another prompt is open on this computer.` });
        });
        const port = tauriPasswordsPort();
        await expect(port.status()).rejects.toMatchObject({ code: `busy`, message: `Another prompt is open on this computer.` });
        mockIPC((command) => {
            if (command === `keyring_status`) {
                return JSON.stringify({ ok: true, ...READY });
            }
            return JSON.stringify(command === `keyring_upgrade`
                ? { ok: false, code: `declined`, refusal: `You declined the keyring update.` }
                : { ok: false, code: `bad-grant`, refusal: `Unknown request.` });
        });
        const status = await port.status();
        if (status.kind !== `unavailable` || status.fix === undefined) {
            throw new Error(`The old keyring must offer an update.`);
        }
        await expect(status.fix.run()).rejects.toMatchObject({ code: `declined`, message: `You declined the keyring update.` });
    });

    it(`sends a manual add, an answer and an import as the input of one command`, async () => {
        const port = tauriPasswordsPort();
        expect(await port.add({ title: `github.com`, value: `hunter2`, kind: `password`, origins: [{ kind: `site`, host: `github.com` }] })).toEqual({ name: `GITHUB_COM` });
        await port.answer(`need-1`, `once`, { value: `typed-once` });
        await port.importRows([{ origin: { kind: `site`, host: `a.example` }, value: `x` }], `Chrome, Edge or Brave`);
        const app = calls.filter((call) => call.command === `keyring_app`);
        expect(app.map((call) => call.args[`op`])).toEqual([`save`, `answer-need`, `import`]);
        expect(app[0]?.args[`input`]).toMatchObject({ title: `github.com`, value: `hunter2` });
        expect(app[1]?.args[`input`]).toEqual({ id: `need-1`, answer: `once`, value: `typed-once` });
    });

    it(`gives access by sharing, and takes it away by unsharing`, async () => {
        const port = tauriPasswordsPort();
        await port.setAccess(`GITHUB_COM`, SHOP, `always`);
        await port.setAccess(`GITHUB_COM`, SHOP, `off`);
        expect(calls.map((call) => [call.command, call.args[`mode`]])).toEqual([
            [`keyring_share`, `copy`],
            [`keyring_unshare`, undefined],
        ]);
    });
});
