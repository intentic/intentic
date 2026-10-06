import type { User } from "@intentic/api-contract";
import { type Ref, readonly, ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { localFace } from "../../app/environments/local";
import { localHost } from "../../app/environments/localHost";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "../../lib/authLifecycle";
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
    readonly signOut: () => Promise<void>;
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
// no id, and nothing a local window does with the account needs one.
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

const localAccount: Account = {
    user: readonly(localUser),
    refresh: askPlatform,
    updateProfile: async (change) => {
        await localHost().updateAccount(change);
        await askPlatform();
    },
    signOut: async () => {
        await localHost().signOut();
        // Every local window hears it (authLifecycle.ts), each clearing its own account below.
        await invalidatePlatformAuth();
    },
    settled: startLocal,
    local: true,
};

if (localFace() !== undefined) {
    // A sign-out here or in another local window, or a relayed call the platform refused as signed out (useApi.ts): the
    // account is gone, and only the account. The folder's own session is not the platform's (useAuth.ts keeps it).
    onPlatformAuthInvalidated(() => {
        localUser.value = null;
    });
    // A sign-in finishing in the browser, or a sign-out in the workspace, is found out when the reader comes back.
    globalThis.addEventListener?.(`focus`, () => void recheckPlatform());
    void startLocal();
}

/* THE WORKSPACE'S ACCOUNT: the editor's session itself. */

const workspaceAccount = (): Account => {
    const { user, refresh, updateProfile, signOut } = useAuth();
    return { user, refresh, updateProfile, signOut, settled: () => Promise.resolve(), local: false };
};

export const useAccount = (): Account => (localFace() === undefined ? workspaceAccount() : localAccount);

// One account per window, as useAuth.ts keeps one user: a hot update re-running this module would otherwise leave
// components reading a `localUser` no listener writes any more.
reloadOnHotUpdate(import.meta);
