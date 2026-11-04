import type { User } from "@intentic/api-contract";
import { computed, type Ref, ref } from "vue";
import { desktopVersion, signInThroughBrowser } from "../../app/environments/desktop";
import { embedded } from "../../app/environments/nativeApp";
import { ADD_ACCOUNT_PATH, type SignedOutAs, useDeviceAccounts } from "./deviceAccounts";
import type { DeviceSession } from "./useAuth";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { localFace } from "../../app/environments/local";
import { localHost } from "../../app/environments/localHost";
import { announceAccountChanged, invalidatePlatformAuth, onAccountChangedElsewhere, onPlatformAuthInvalidated } from "../../lib/authLifecycle";
import { useAuth } from "./useAuth";

// THE ACCOUNT, as the account menu and Settings read it: who is signed in to the platform, renaming them, signing them
// out. In the workspace that is the editor's own session (useAuth.ts). A desktop app's window on a folder of this
// computer (app/environments/local.ts) has no platform session of its own: its editor runs as a placeholder for the
// folder, and the account is the one the workspace signed in with, which the app asks the platform about for it
// (localHost.ts `account`). Kept apart from the placeholder, so nothing about the account can reach the folder's session.

export interface Account {
    readonly user: Readonly<Ref<User | null>>;
    /** Asks again who is signed in; resolves to them, or rejects when that cannot be found out right now. */
    readonly refresh: () => Promise<User | null>;
    readonly updateProfile: (change: { name?: string; image?: string }) => Promise<void>;
    /** Signs out of this account; another still signed in on this browser carries on (`switched`, already leaving). */
    readonly signOut: () => Promise<SignedOutAs>;
    /** Signs out of every account this browser holds. */
    readonly signOutAll: () => Promise<void>;
    /** The other accounts signed in on this browser, as last asked (`refreshOthers`); the current one is never among them. */
    readonly others: Readonly<Ref<readonly DeviceSession[]>>;
    readonly refreshOthers: () => Promise<void>;
    /** Makes another of the browser's accounts the active one, leaving this page for it. */
    readonly switchTo: (other: DeviceSession) => Promise<void>;
    /**
     * How another account is added beside this one: a path in this window to go to, the desktop app's sign-in through
     * the browser, or nothing where this window cannot add one (the Android app owns sign-in there).
     */
    readonly add: { readonly path: string } | { readonly run: () => void } | undefined;
    /** Whether the browser has room for one more account. */
    readonly canAdd: Readonly<Ref<boolean>>;
    /** Resolves once who is signed in is known as well as it can be: a guard's wait, never longer than one ask. */
    readonly settled: () => Promise<void>;
    /** A local window's: signing out leaves the window where it is, and nothing here can delete the account. */
    readonly local: boolean;
}

/* A LOCAL WINDOW'S ACCOUNT. */

// allow(module-state): the account above every local window's folder, one per window like useAuth's
const localUser = ref<User | null>(null);
let asking: Promise<User | null> | undefined;
let first: Promise<void> | undefined;

// The platform's answer replaces whatever was shown; a platform out of reach changes nothing, so a window opened offline
// keeps the account the workspace last named rather than reading as signed out.
const askPlatform = (): Promise<User | null> =>
    (asking ??= localHost()
        .account()
        .then((user) => {
            localUser.value = user;
            return user;
        })
        .finally(() => {
            asking = undefined;
        }));

// The platform's answer, asked again without failing the caller: it is asked once more on the next focus.
const recheckPlatform = async (): Promise<void> => {
    try {
        await askPlatform();
    } catch (error) {
        console.warn(`[local] the platform could not be asked who is signed in:`, error);
    }
};

// Who the workspace last named comes first, from the app's own record (localHost.ts `roster`) and with no wait on the
// network, so the rail's foot is the account from the first paint; the platform's answer follows. That record carries
// no id, so until the platform answers, the window tells its account from the others signed in beside it by address.
const startLocal = (): Promise<void> =>
    (first ??= (async () => {
        try {
            const { account } = await localHost().roster();
            if (account !== null && localUser.value === null) {
                localUser.value = { id: ``, email: account.email, name: account.name ?? ``, image: account.image ?? null };
            }
        } catch (error) {
            console.error(`[local] who is signed in could not be read:`, error);
        }
        await recheckPlatform();
    })());

// THE ACCOUNTS SIGNED IN BESIDE IT, where the workspace signs in (localHost.ts `deviceAccounts`): the app keeps them in
// the workspace's browser profile, so a local window lists, switches and signs out of them through it, and the app
// reloads the workspace as the account it moved to. This window stays on its folder and asks who it is now. Adding one
// is the workspace's, whose sign-in screen it is, so a local window offers no room for one.
// allow(module-state): every account signed in, this window's own among them, one list per window like the account above
const deviceAccounts = ref<readonly DeviceSession[]>([]);
let listing: Promise<void> | undefined;
const noRoom = computed(() => false);

// Whether `user` is the account this window shows: by id, or by address while it has only the workspace's record.
const isLocalUser = (user: User): boolean => {
    const own = localUser.value;
    if (own === null) {
        return false;
    }
    return own.id === `` ? own.email.toLowerCase() === user.email.toLowerCase() : own.id === user.id;
};

// Computed from the account shown, so the one switched to leaves the list the moment the window knows it.
const localOthers = computed(() => deviceAccounts.value.filter((entry) => !isLocalUser(entry.user)));

// An unanswered ask keeps the last list, as the workspace's does (deviceAccounts.ts `refreshOthers`).
const listDeviceAccounts = (): Promise<void> =>
    (listing ??= (async () => {
        try {
            deviceAccounts.value = await localHost().deviceAccounts();
        } catch (error) {
            console.warn(`[local] the accounts signed in could not be listed:`, error);
        } finally {
            listing = undefined;
        }
    })());

// Who this window is now, once the platform moved to another account: every other local window asks too. An
// unanswered ask is not the move's failure, which has happened; it is asked again on the next focus.
const movedAccount = async (): Promise<void> => {
    await recheckPlatform();
    announceAccountChanged(localUser.value?.id);
};

// A refused move (that sign-in ended, or the workspace moved first): the window catches up with what the platform holds.
const refusedMove = (): void => {
    void recheckPlatform();
    void listDeviceAccounts();
};

const signOutEverywhere = async (): Promise<void> => {
    await localHost().signOut();
    // Every local window hears it (authLifecycle.ts), each clearing its own account below.
    await invalidatePlatformAuth();
};

// This window's account alone, while another is signed in beside it: the platform carries on as that one. The only
// account signs out of everything, as before there were several.
const signOutHere = async (): Promise<SignedOutAs> => {
    await listDeviceAccounts();
    const own = deviceAccounts.value.find((entry) => isLocalUser(entry.user));
    if (own === undefined || localOthers.value.length === 0) {
        await signOutEverywhere();
        return `signed-out`;
    }
    try {
        await localHost().revokeAccount(own.token);
    } catch (error) {
        refusedMove();
        throw error;
    }
    deviceAccounts.value = deviceAccounts.value.filter((entry) => entry.token !== own.token);
    await movedAccount();
    return `switched`;
};

const switchLocal = async (other: DeviceSession): Promise<void> => {
    if (isLocalUser(other.user)) {
        return;
    }
    try {
        await localHost().switchAccount(other.token);
    } catch (error) {
        refusedMove();
        throw error;
    }
    await movedAccount();
};

const localAccount: Account = {
    // A read-only view of the one ref this module writes: computed rather than `readonly`, whose deep conversion makes
    // the account's list of sign-in methods a type the Account's own field does not take.
    user: computed(() => localUser.value),
    refresh: askPlatform,
    updateProfile: async (change) => {
        await localHost().updateAccount(change);
        await askPlatform();
    },
    signOut: signOutHere,
    signOutAll: signOutEverywhere,
    others: localOthers,
    refreshOthers: listDeviceAccounts,
    switchTo: switchLocal,
    add: undefined,
    canAdd: noRoom,
    settled: startLocal,
    local: true,
};

if (localFace() !== undefined) {
    // A sign-out here or in another local window, or a relayed call the platform refused as signed out (useApi.ts): the
    // account is gone, and only the account. The folder's own session is not the platform's (useAuth.ts keeps it).
    onPlatformAuthInvalidated(() => {
        localUser.value = null;
        deviceAccounts.value = [];
    });
    // Another local window moved the platform to another account: this one asks who it is now.
    onAccountChangedElsewhere(() => void recheckPlatform());
    // A sign-in finishing in the browser, or a sign-out in the workspace, is found out when the reader comes back.
    globalThis.addEventListener?.(`focus`, () => void recheckPlatform());
    void startLocal();
}

/* THE WORKSPACE'S ACCOUNT: the editor's session itself. */

// How this window adds an account: the sign-in screen in a browser, the desktop app's sign-in through the browser with
// Google's chooser up (its webview cannot ask Google), and nowhere inside the Android app, whose own screens sign in.
const workspaceAdd = (): Account[`add`] => {
    if (embedded()) {
        return undefined;
    }
    if (desktopVersion() !== undefined) {
        return { run: () => signInThroughBrowser({ pickAccount: true }) };
    }
    return { path: ADD_ACCOUNT_PATH };
};

const workspaceAccount = (): Account => {
    const { user, refresh, updateProfile } = useAuth();
    const accounts = useDeviceAccounts();
    return {
        user,
        refresh,
        updateProfile,
        signOut: accounts.signOutHere,
        signOutAll: accounts.signOutEverywhere,
        others: accounts.others,
        refreshOthers: accounts.refreshOthers,
        switchTo: accounts.switchTo,
        add: workspaceAdd(),
        canAdd: accounts.canAdd,
        settled: () => Promise.resolve(),
        local: false,
    };
};

export const useAccount = (): Account => (localFace() === undefined ? workspaceAccount() : localAccount);

// One account per window, as useAuth.ts keeps one user: a hot update re-running this module would otherwise leave
// components reading a `localUser` no listener writes any more.
reloadOnHotUpdate(import.meta);
