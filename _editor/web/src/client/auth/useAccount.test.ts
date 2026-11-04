import type { User } from "@intentic/api-contract";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { ref } from "vue";
import type { LocalFace } from "../../app/environments/local";
import { LINK_HOST, type LocalAccount, type LocalDeviceAccount, type LocalHost } from "../../app/environments/localHost";

// The workspace's own session, as useAuth.ts holds it: what the account is everywhere but a local window.
const workspaceUser = ref<User | null>({ id: `u1`, email: `ada@example.com`, name: `Ada`, image: null });
const workspaceSignOut = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`./useAuth`, () => ({
    useAuth: () => ({
        user: workspaceUser,
        refresh: () => Promise.resolve(workspaceUser.value),
        updateProfile: () => Promise.resolve(),
        signOut: workspaceSignOut,
        // The browser's other accounts (deviceAccounts.ts): none, so a sign-out is of everything, as before there were several.
        listDeviceSessions: () => Promise.resolve([]),
        sessionToken: () => `t1`,
    }),
}));
// What a sign-out forgets of the account in this browser, which reaches the app's environment: not this suite's.
jest.mock(`./accountTeardown`, () => ({ forgetAccountTraces: () => Promise.resolve() }));
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount: () => undefined }));

const { invalidatePlatformAuth } = await import(`../../lib/authLifecycle`);

const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47148`, token: `t`, id: `f1`, name: `Taxes`, path: `C:\\Taxes`, home: true };
const PLATFORM_USER: User = { id: `u1`, email: `ada@example.com`, name: `Ada Lovelace`, image: `https://example.com/ada.png` };
const NAMED: LocalAccount = { email: `ada@example.com`, name: `Ada` };
const BO: User = { id: `u2`, email: `bo@example.com`, name: `Bo`, image: null };
// Ada and Bo, both signed in where the workspace signs in, Ada the one signed in now.
const ADA_AND_BO: readonly LocalDeviceAccount[] = [
    { token: `t1`, user: PLATFORM_USER },
    { token: `t2`, user: BO },
];

// The app's host, as far as the account goes: what the workspace last named, what the platform answers now, and every
// account signed in beside it.
const hostWith = (
    named: LocalAccount | null,
    platform: () => Promise<User | null>,
    listed: readonly LocalDeviceAccount[] = [],
): LocalHost & { readonly calls: string[] } => {
    const calls: string[] = [];
    return {
        ...LINK_HOST,
        native: true,
        calls,
        roster: () => Promise.resolve({ account: named, sandboxes: [] }),
        account: () => {
            calls.push(`account`);
            return platform();
        },
        deviceAccounts: () => {
            calls.push(`list`);
            return Promise.resolve(listed);
        },
        switchAccount: (token) => {
            calls.push(`switch ${token}`);
            return Promise.resolve();
        },
        revokeAccount: (token) => {
            calls.push(`revoke ${token}`);
            return Promise.resolve();
        },
        updateAccount: (change) => {
            calls.push(`update ${JSON.stringify(change)}`);
            return Promise.resolve();
        },
        signOut: () => {
            calls.push(`sign-out`);
            return Promise.resolve();
        },
    };
};

type Module = typeof import("./useAccount");
const load = (host?: LocalHost): Promise<Module> => {
    stubGlobal(`window`, host === undefined ? {} : { __INTENTIC_LOCAL__: FACE, __INTENTIC_LOCAL_HOST__: host });
    return freshImport<Module>(`./useAccount`, import.meta.url);
};

afterEach(() => {
    unstubAllGlobals();
    workspaceSignOut.mockClear();
});

describe(`in the workspace`, () => {
    it(`is the editor's own session, signed out the workspace's way`, async () => {
        const account = (await load()).useAccount();
        expect([account.local, account.user.value]).toEqual([false, workspaceUser.value]);
        await account.signOut();
        expect(workspaceSignOut).toHaveBeenCalledTimes(1);
    });
});

describe(`in a desktop window on a folder`, () => {
    it(`is the platform's answer, once it comes, over the account the workspace last named`, async () => {
        const host = hostWith(NAMED, () => Promise.resolve(PLATFORM_USER));
        const account = (await load(host)).useAccount();
        await account.settled();
        expect([account.local, account.user.value, host.calls]).toEqual([true, PLATFORM_USER, [`account`]]);
    });

    it(`keeps the named account while the platform is out of reach, without its id`, async () => {
        const account = (await load(hostWith(NAMED, () => Promise.reject(new Error(`offline`))))).useAccount();
        await account.settled();
        expect(account.user.value).toEqual({ id: ``, email: `ada@example.com`, name: `Ada`, image: null });
    });

    it(`is nobody once the platform says so, whatever the workspace last named`, async () => {
        const account = (await load(hostWith(NAMED, () => Promise.resolve(null)))).useAccount();
        await account.settled();
        expect(account.user.value).toBeNull();
    });

    it(`saves a change through the app and reads the account again`, async () => {
        const host = hostWith(null, () => Promise.resolve(PLATFORM_USER));
        const account = (await load(host)).useAccount();
        await account.settled();
        await account.updateProfile({ name: `Ada L.` });
        expect(host.calls).toEqual([`account`, `update {"name":"Ada L."}`, `account`]);
    });

    it(`signs out through the app and forgets only the account, never the workspace's session`, async () => {
        const host = hostWith(NAMED, () => Promise.resolve(PLATFORM_USER));
        const account = (await load(host)).useAccount();
        await account.settled();
        expect(await account.signOut()).toBe(`signed-out`);
        expect([host.calls, account.user.value, workspaceSignOut.mock.calls.length]).toEqual([[`account`, `list`, `sign-out`], null, 0]);
    });

    it(`forgets the account when a call the app carried was refused as signed out`, async () => {
        const account = (await load(hostWith(NAMED, () => Promise.resolve(PLATFORM_USER)))).useAccount();
        await account.settled();
        await invalidatePlatformAuth(false);
        expect(account.user.value).toBeNull();
    });
});

describe(`in a desktop window on a folder, with another account signed in beside it`, () => {
    // Who the platform answers as, in turn: Ada first, then whoever it moved to.
    const answering = (...users: readonly (User | null)[]): (() => Promise<User | null>) => {
        const queue = [...users];
        return () => Promise.resolve(queue.length > 1 ? (queue.shift() ?? null) : (queue[0] ?? null));
    };

    it(`offers the other accounts, never its own`, async () => {
        const account = (await load(hostWith(NAMED, answering(PLATFORM_USER), ADA_AND_BO))).useAccount();
        await account.settled();
        await account.refreshOthers();
        expect(account.others.value).toEqual([{ token: `t2`, user: BO }]);
    });

    it(`tells its own from the others by address while all it has is the workspace's record`, async () => {
        const listed: readonly LocalDeviceAccount[] = [{ token: `t1`, user: { ...PLATFORM_USER, email: `Ada@Example.com` } }, ...ADA_AND_BO.slice(1)];
        const account = (await load(hostWith(NAMED, () => Promise.reject(new Error(`offline`)), listed))).useAccount();
        await account.settled();
        await account.refreshOthers();
        expect([account.user.value?.id, account.others.value]).toEqual([``, [{ token: `t2`, user: BO }]]);
    });

    it(`switches through the app, and asks the platform who it is now`, async () => {
        const host = hostWith(NAMED, answering(PLATFORM_USER, BO), ADA_AND_BO);
        const account = (await load(host)).useAccount();
        await account.settled();
        await account.refreshOthers();
        await account.switchTo({ token: `t2`, user: BO });
        expect(host.calls).toEqual([`account`, `list`, `switch t2`, `account`]);
        // The one it left is offered in its place, without asking again.
        expect([account.user.value, account.others.value]).toEqual([BO, [{ token: `t1`, user: PLATFORM_USER }]]);
    });

    it(`signs out of its own account alone and carries on as the other`, async () => {
        const host = hostWith(NAMED, answering(PLATFORM_USER, BO), ADA_AND_BO);
        const account = (await load(host)).useAccount();
        await account.settled();
        expect(await account.signOut()).toBe(`switched`);
        expect(host.calls).toEqual([`account`, `list`, `revoke t1`, `account`]);
        expect([account.user.value, account.others.value, workspaceSignOut.mock.calls.length]).toEqual([BO, [], 0]);
    });

    it(`signs out of everything when it is the only account signed in`, async () => {
        const host = hostWith(NAMED, answering(PLATFORM_USER), ADA_AND_BO.slice(0, 1));
        const account = (await load(host)).useAccount();
        await account.settled();
        expect(await account.signOut()).toBe(`signed-out`);
        expect([host.calls, account.user.value]).toEqual([[`account`, `list`, `sign-out`], null]);
    });

    it(`signs out of every account at once when asked to, whoever else is signed in`, async () => {
        const host = hostWith(NAMED, answering(PLATFORM_USER), ADA_AND_BO);
        const account = (await load(host)).useAccount();
        await account.settled();
        await account.signOutAll();
        expect([host.calls, account.user.value]).toEqual([[`account`, `sign-out`], null]);
    });
});
