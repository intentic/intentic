import "@intentic/testing/dom";
import { forgetAccount, rememberListed } from "../directory/deviceDirectory";
import { noteAppAccount, otherAccountInApp } from "./appAccounts";

// Pins how the app tells its first account from a switch of accounts: only sign-ins inside the app count, an address is
// never kept as itself, a sign-out does not wipe the record, and an account the device directory still remembers counts.

const FIRST = `first@example.com`;
const SECOND = `second@example.com`;

const inApp = (): void => {
    window.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `i`, update: null };
};

beforeEach(() => {
    localStorage.clear();
    forgetAccount(FIRST);
    forgetAccount(SECOND);
});

afterEach(() => {
    delete window.__INTENTIC_DESKTOP__;
});

describe(`the accounts this app has been signed in as`, () => {
    it(`call the app's first account its first, however often it signs in again`, async () => {
        inApp();
        await noteAppAccount(FIRST);
        await noteAppAccount(` First@Example.com `);
        expect(await otherAccountInApp(FIRST)).toBe(false);
    });

    it(`call the next account a switch, and the first one too once the next has been here`, async () => {
        inApp();
        await noteAppAccount(FIRST);
        expect(await otherAccountInApp(SECOND)).toBe(true);
        await noteAppAccount(SECOND);
        expect(await otherAccountInApp(FIRST)).toBe(true);
    });

    it(`record nothing a browser signs in as`, async () => {
        await noteAppAccount(FIRST);
        expect(await otherAccountInApp(SECOND)).toBe(false);
    });

    it(`keep a fingerprint, never the address`, async () => {
        inApp();
        await noteAppAccount(FIRST);
        const kept = Object.keys(localStorage).map((key) => `${key}=${localStorage.getItem(key)}`);
        expect(kept.join(`\n`)).not.toContain(`example.com`);
    });

    it(`count an account the device directory still remembers`, async () => {
        rememberListed({ id: `u1`, email: FIRST, name: `First`, image: null }, [], undefined);
        expect(await otherAccountInApp(SECOND)).toBe(true);
        expect(await otherAccountInApp(FIRST)).toBe(false);
    });

    it(`tell nothing without an account to compare`, async () => {
        inApp();
        await noteAppAccount(FIRST);
        expect(await otherAccountInApp(undefined)).toBe(false);
    });
});
