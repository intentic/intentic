import type { SandboxSummary, User } from "@intentic/api-contract";
import { freshImport } from "@intentic/testing/bun";
import { ref } from "vue";
import type { DeviceSession } from "./useAuth";

// The browser's other accounts, as the account menu moves between them (deviceAccounts.ts). The platform's primitives
// are stubs a case scripts, and the boundary's ways out are spies: what is under test is which account the browser
// ends up on, what of the one left behind is forgotten, and that every road ends in leaving the page.

const person = (id: string): User => ({ id, email: `${id}@example.com`, name: id, image: null });
const signedIn = (id: string): DeviceSession => ({ token: `token-${id}`, user: person(id) });

const ADA = signedIn(`ada`);
const BEA = signedIn(`bea`);
const CAI = signedIn(`cai`);
const DEV = signedIn(`dev`);
const EVE = signedIn(`eve`);
const FAY = signedIn(`fay`);

// The platform's side, as useAuth hands it over.
const auth = {
    user: ref<User | null>(ADA.user),
    sessionToken: jest.fn((): string | undefined => ADA.token),
    listDeviceSessions: jest.fn(async (): Promise<readonly DeviceSession[]> => []),
    activateDeviceSession: jest.fn(async (_token: string): Promise<User> => BEA.user),
    revokeDeviceSession: jest.fn(async (_token: string): Promise<void> => undefined),
    activeAccount: jest.fn(async (): Promise<User | null> => null),
    signOut: jest.fn(async (): Promise<void> => undefined),
    deleteAccount: jest.fn(async (_sandboxes: readonly SandboxSummary[], _options?: { readonly continuing?: boolean }): Promise<void> => undefined),
};
jest.mock(`./useAuth`, () => ({ useAuth: () => auth }));
const forgetAccountTraces = jest.fn(async (): Promise<void> => undefined);
jest.mock(`./accountTeardown`, () => ({ forgetAccountTraces }));
const forgetAccount = jest.fn((_email: string): void => undefined);
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount }));
const leaveFor = jest.fn((_next: Pick<User, `id`> | undefined, _destination: string): void => undefined);
const leaveForNobody = jest.fn((): void => undefined);
jest.mock(`../../lib/accounts/accountBoundary`, () => ({ leaveFor, leaveForNobody }));
const invalidatePlatformAuth = jest.fn(async (): Promise<void> => undefined);
jest.mock(`../../lib/authLifecycle`, () => ({ invalidatePlatformAuth }));

// The module keeps the last list it heard and how many accounts the browser holds, so each case starts from its own.
const load = async () => {
    const { useDeviceAccounts } = await freshImport<typeof import("./deviceAccounts")>(`./deviceAccounts`, import.meta.url);
    return { accounts: useDeviceAccounts() };
};

beforeEach(() => {
    for (const spy of [
        auth.sessionToken,
        auth.listDeviceSessions,
        auth.activateDeviceSession,
        auth.revokeDeviceSession,
        auth.activeAccount,
        auth.signOut,
        auth.deleteAccount,
        forgetAccountTraces,
        forgetAccount,
        leaveFor,
        leaveForNobody,
        invalidatePlatformAuth,
    ]) {
        spy.mockClear();
    }
    auth.user.value = ADA.user;
    auth.sessionToken.mockImplementation(() => ADA.token);
    auth.listDeviceSessions.mockImplementation(async () => [ADA, BEA]);
    auth.activateDeviceSession.mockImplementation(async () => BEA.user);
    auth.activeAccount.mockImplementation(async () => null);
});

describe(`the other accounts`, () => {
    it(`lists every account but the one in front of the reader, and offers no more once five are held`, async () => {
        const { accounts } = await load();
        auth.listDeviceSessions.mockImplementation(async () => [ADA, BEA, CAI, DEV]);
        await accounts.refreshOthers();

        expect(accounts.others.value.map((entry) => entry.user.id)).toEqual([`bea`, `cai`, `dev`]);
        expect(accounts.canAdd.value).toBe(true);

        auth.listDeviceSessions.mockImplementation(async () => [ADA, BEA, CAI, DEV, EVE]);
        await accounts.refreshOthers();

        expect(accounts.others.value).toHaveLength(4);
        expect(accounts.canAdd.value).toBe(false);
    });

    it(`counts the account in front of the reader even when the platform did not list it`, async () => {
        // A sixth sign-in is active without being one of the five the platform lists.
        auth.user.value = FAY.user;
        auth.listDeviceSessions.mockImplementation(async () => [BEA, CAI, DEV, EVE]);
        const { accounts } = await load();

        await accounts.refreshOthers();

        expect(accounts.others.value).toHaveLength(4);
        expect(accounts.canAdd.value).toBe(false);
    });
});

describe(`switching`, () => {
    it(`makes the account active and leaves for it at Home`, async () => {
        const { accounts } = await load();
        await accounts.refreshOthers();

        await accounts.switchTo(BEA);

        expect(auth.activateDeviceSession).toHaveBeenCalledWith(BEA.token);
        expect(leaveFor).toHaveBeenCalledWith(BEA.user, `/`);
    });

    it(`drops a sign-in that has ended, says so, and stays where it is`, async () => {
        const { accounts } = await load();
        await accounts.refreshOthers();
        auth.activateDeviceSession.mockRejectedValue(new Error(`session not found`));

        await expect(accounts.switchTo(BEA)).rejects.toMatchObject({ name: `SignInEndedError` });

        expect(accounts.others.value).toEqual([]);
        expect(leaveFor).not.toHaveBeenCalled();
    });

    it(`leaves for the account just added, wherever the sign-in was headed`, async () => {
        auth.activeAccount.mockImplementation(async () => CAI.user);
        const { accounts } = await load();

        await accounts.arriveAsAdded(`/sandbox/sbx-9`);

        expect(leaveFor).toHaveBeenCalledWith(CAI.user, `/sandbox/sbx-9`);
    });
});

describe(`signing out of the account in front of the reader`, () => {
    it(`ends only its own sign-in, forgets only it, and carries on as the account the platform made active`, async () => {
        auth.activeAccount.mockImplementation(async () => BEA.user);
        const { accounts } = await load();

        expect(await accounts.signOutHere()).toBe(`switched`);

        expect(auth.revokeDeviceSession.mock.calls).toEqual([[ADA.token]]);
        expect(forgetAccount.mock.calls).toEqual([[ADA.user.email]]);
        // Its own traces only: called with no account named is the open one's, never every account's.
        expect(forgetAccountTraces.mock.calls).toEqual([[]]);
        expect(auth.signOut).not.toHaveBeenCalled();
        expect(leaveFor).toHaveBeenCalledWith(BEA.user, `/`);
    });

    it(`signs out of everything when it is the only account here`, async () => {
        auth.listDeviceSessions.mockImplementation(async () => [ADA]);
        const { accounts } = await load();

        expect(await accounts.signOutHere()).toBe(`signed-out`);

        expect(auth.signOut).toHaveBeenCalledTimes(1);
        expect(auth.revokeDeviceSession).not.toHaveBeenCalled();
        expect(leaveFor).not.toHaveBeenCalled();
    });

    it(`signs out of everything when the platform finds nobody left to carry on as`, async () => {
        auth.activeAccount.mockImplementation(async () => null);
        const { accounts } = await load();

        expect(await accounts.signOutHere()).toBe(`signed-out`);

        expect(auth.revokeDeviceSession).toHaveBeenCalledWith(ADA.token);
        expect(leaveForNobody).toHaveBeenCalledTimes(1);
        expect(invalidatePlatformAuth).toHaveBeenCalledTimes(1);
        expect(leaveFor).not.toHaveBeenCalled();
    });
});

describe(`deleting the account in front of the reader`, () => {
    const SANDBOXES: readonly SandboxSummary[] = [];

    it(`deletes it as one the browser carries on from, and leaves as the next account`, async () => {
        const { accounts } = await load();

        expect(await accounts.deleteAndContinue(SANDBOXES)).toBe(`switched`);

        expect(auth.deleteAccount).toHaveBeenCalledWith(SANDBOXES, { continuing: true });
        expect(auth.activateDeviceSession).toHaveBeenCalledWith(BEA.token);
        expect(leaveFor).toHaveBeenCalledWith(BEA.user, `/`);
    });

    it(`ends signed out when no other account is here`, async () => {
        auth.listDeviceSessions.mockImplementation(async () => [ADA]);
        const { accounts } = await load();

        expect(await accounts.deleteAndContinue(SANDBOXES)).toBe(`signed-out`);

        expect(auth.deleteAccount).toHaveBeenCalledWith(SANDBOXES, { continuing: false });
        expect(leaveFor).not.toHaveBeenCalled();
    });
});
