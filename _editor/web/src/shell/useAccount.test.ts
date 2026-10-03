import type { User } from "@intentic/api-contract";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { ref } from "vue";
import type { LocalFace } from "../app/environments/local";
import { LINK_HOST, type LocalAccount, type LocalHost } from "../app/environments/localHost";

// The workspace's own session, as useAuth.ts holds it: what the account is everywhere but a local window.
const workspaceUser = ref<User | null>({ id: `u1`, email: `ada@example.com`, name: `Ada`, image: null });
const workspaceSignOut = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`../features/auth/useAuth`, () => ({
    useAuth: () => ({ user: workspaceUser, refresh: () => Promise.resolve(workspaceUser.value), updateProfile: () => Promise.resolve(), signOut: workspaceSignOut }),
}));

const { invalidatePlatformAuth } = await import(`../features/auth/authLifecycle`);

const FACE: LocalFace = { daemonUrl: `http://127.0.0.1:47148`, token: `t`, id: `f1`, name: `Taxes`, path: `C:\\Taxes`, home: true };
const PLATFORM_USER: User = { id: `u1`, email: `ada@example.com`, name: `Ada Lovelace`, image: `https://example.com/ada.png` };
const NAMED: LocalAccount = { email: `ada@example.com`, name: `Ada` };

// The app's host, as far as the account goes: what the workspace last named, and what the platform answers now.
const hostWith = (named: LocalAccount | null, platform: () => Promise<User | null>): LocalHost & { readonly calls: string[] } => {
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
        await account.signOut();
        expect([host.calls, account.user.value, workspaceSignOut.mock.calls.length]).toEqual([[`account`, `sign-out`], null, 0]);
    });

    it(`forgets the account when a call the app carried was refused as signed out`, async () => {
        const account = (await load(hostWith(NAMED, () => Promise.resolve(PLATFORM_USER)))).useAccount();
        await account.settled();
        await invalidatePlatformAuth(false);
        expect(account.user.value).toBeNull();
    });
});
