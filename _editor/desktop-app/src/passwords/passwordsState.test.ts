import "@intentic/testing/dom";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { KeyringStatus } from "./keyringCommands";

// Whether Passwords has a tile on this computer's rail, and whether This device offers its setup: no tile and the offer
// while the vault is not set up, the tile and no offer once it is.

const { registerDesktopCatalog } = await import("../i18n");
await registerDesktopCatalog();
const { passwordsInRail, passwordsOffered, passwordsPort } = await import("./passwordsState");

const KEYS = { seal: `A`.repeat(43), inbox: `B`.repeat(43) };
const NOT_SET_UP: KeyringStatus = {
    installed: true,
    running: true,
    setUp: false,
    askpass: { installed: false },
    support: { canSetUp: true, hello: false, platform: `linux` },
};
const READY: KeyringStatus = {
    installed: true,
    running: true,
    setUp: true,
    askpass: { installed: true },
    state: { version: `1`, locked: false, unlock: [`passphrase`], keys: KEYS, pendingInbox: 0, pendingCaptures: 0 },
};

const answering = (status: KeyringStatus): void => {
    mockIPC((command) => {
        if (command === `keyring_status`) {
            return JSON.stringify({ ok: true, ...status });
        }
        if (command === `machine_report`) {
            return JSON.stringify({ device: { links: [] }, sync: { hostname: `rog` } });
        }
        return JSON.stringify({ ok: true, settings: { rememberAskedAt: 1 } });
    });
};

describe(`the Passwords tile`, () => {
    afterEach(() => clearMocks());

    it(`is off the rail before anything is read, and nothing is offered yet`, () => {
        expect(passwordsInRail.value).toBe(false);
        expect(passwordsOffered.value).toBe(false);
    });

    it(`stays off the rail on a computer without a vault, which This device offers to set up`, async () => {
        answering(NOT_SET_UP);
        expect((await passwordsPort().status()).kind).toBe(`not-set-up`);
        expect(passwordsInRail.value).toBe(false);
        expect(passwordsOffered.value).toBe(true);
    });

    it(`comes onto the rail once the vault is set up, and the offer goes`, async () => {
        answering(READY);
        expect((await passwordsPort().status()).kind).toBe(`ready`);
        expect(passwordsInRail.value).toBe(true);
        expect(passwordsOffered.value).toBe(false);
    });
});
