import { MAX_DEVICE_ACCOUNTS, type SandboxSummary, type User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { leaveFor, leaveForNobody } from "../../lib/accounts/accountBoundary";
import { invalidatePlatformAuth } from "../../lib/authLifecycle";
import { toTop } from "../../lib/routes/links";
import { forgetAccount } from "../directory/deviceDirectory";
import { forgetAccountTraces } from "./accountTeardown";
import { type DeviceSession, useAuth } from "./useAuth";

// THE OTHER ACCOUNTS SIGNED IN ON THIS BROWSER, as the account menu offers them: switching to one, adding one, signing out
// of only the one in front of the reader, or of all of them. The platform keeps each as a device session (Better Auth's
// multi-session, at most MAX_DEVICE_ACCOUNTS) with one active; every road here ends in a full navigation as the account
// now active (lib/accounts/accountBoundary.ts `leaveFor`), so no view, cache or credential of one account reaches the next.

/** Where the reader lands as the account they moved to: Home, since the address they were on may be another's sandbox. */
const ACCOUNT_HOME = `/`;
/** The sign-in screen as it adds an account beside the one signed in (features/auth/Login.vue). */
export const ADD_ACCOUNT_PATH = toTop(`login`, {}, { add: `1` });

/** A sign-in that ended since it was listed (signed out elsewhere, expired): it is not switched to. */
class SignInEndedError extends Error {
    constructor(readonly email: string) {
        super(t(`auth.accounts.switchEnded`, { email }));
        this.name = `SignInEndedError`;
    }
}

/** How a sign-out ended: nobody signed in now, or the browser carries on as another account. */
export type SignedOutAs = `signed-out` | `switched`;

const auth = useAuth();

// allow(module-state): the browser's other accounts as last listed, for the one page drawn for one of them
const others = ref<readonly DeviceSession[]>([]);
// allow(module-state): how many accounts the browser holds, this one included (it may be active without being listed)
const held = ref(1);
let asking: Promise<void> | undefined;

/** Asks the platform which other accounts this browser holds; an unanswered ask keeps the last list. */
const refreshOthers = (): Promise<void> =>
    (asking ??= (async () => {
        try {
            const listed = await auth.listDeviceSessions();
            const own = auth.user.value?.id;
            others.value = listed.filter((entry) => entry.user.id !== own);
            held.value = others.value.length + (own === undefined ? 0 : 1);
        } catch (error) {
            console.warn(`[accounts] the browser's other accounts could not be listed:`, error);
        } finally {
            asking = undefined;
        }
    })());

/** Makes `target` the active account and leaves for it. An ended sign-in drops from the list and throws SignInEndedError. */
const switchTo = async (target: DeviceSession): Promise<void> => {
    if (target.user.id === auth.user.value?.id) {
        return;
    }
    let active: User;
    try {
        active = await auth.activateDeviceSession(target.token);
    } catch {
        others.value = others.value.filter((entry) => entry.token !== target.token);
        held.value = Math.max(1, held.value - 1);
        throw new SignInEndedError(target.user.email);
    }
    leaveFor(active, ACCOUNT_HOME);
};

/** Leaves for the account the browser just signed in to beside this one, at `destination` (features/auth/Login.vue). */
const arriveAsAdded = async (destination: string): Promise<void> => {
    const added = await auth.activeAccount();
    if (added === null) {
        throw new Error(t(`auth.useAuth.sessionCheckFailed`));
    }
    leaveFor(added, destination);
};

/** Takes up an account still signed in on this browser, from a page with nobody's session active (the sign-in screen). */
const continueAs = async (target: DeviceSession, destination: string): Promise<void> => {
    let active: User;
    try {
        active = await auth.activateDeviceSession(target.token);
    } catch {
        others.value = others.value.filter((entry) => entry.token !== target.token);
        throw new SignInEndedError(target.user.email);
    }
    leaveFor(active, destination);
};

// The account the platform made active after the one in front of the reader went, and the page left for it; nobody's,
// when it found none still signed in, which ends as a sign-out of everything.
const carryOn = async (): Promise<SignedOutAs> => {
    // allow(silent-catch): an unanswered ask is answered as nobody: the sign-out already happened, and the login screen lists who is left.
    const next = await auth.activeAccount().catch(() => null);
    if (next !== null) {
        leaveFor(next, ACCOUNT_HOME);
        return `switched`;
    }
    leaveForNobody();
    await invalidatePlatformAuth();
    return `signed-out`;
};

/**
 * Signs out of the account in front of the reader only, when another is signed in here: its sign-in ends, this device
 * forgets it, and the browser carries on as the next account. The only account signs out as before (useAuth `signOut`).
 */
const signOutHere = async (): Promise<SignedOutAs> => {
    const current = auth.user.value;
    const token = auth.sessionToken();
    await refreshOthers();
    if (current === null || token === undefined || others.value.length === 0) {
        await auth.signOut();
        return `signed-out`;
    }
    await auth.revokeDeviceSession(token);
    forgetAccount(current.email);
    await forgetAccountTraces();
    return carryOn();
};

/** Signs out of every account this browser holds (useAuth `signOut`). */
const signOutEverywhere = async (): Promise<void> => {
    await auth.signOut();
};

/** Deletes the account in front of the reader, then carries on as another still signed in here, if one is. */
const deleteAndContinue = async (sandboxes: readonly SandboxSummary[]): Promise<SignedOutAs> => {
    await refreshOthers();
    const next = others.value[0];
    await auth.deleteAccount(sandboxes, { continuing: next !== undefined });
    if (next === undefined) {
        return `signed-out`;
    }
    try {
        leaveFor(await auth.activateDeviceSession(next.token), ACCOUNT_HOME);
        return `switched`;
    } catch {
        return carryOn();
    }
};

export const useDeviceAccounts = () => ({
    others,
    /** Whether another account may be added beside these, under the platform's limit. */
    canAdd: computed(() => held.value < MAX_DEVICE_ACCOUNTS),
    refreshOthers,
    switchTo,
    arriveAsAdded,
    continueAs,
    signOutHere,
    signOutEverywhere,
    deleteAndContinue,
});

// One list per page, as useAuth keeps one user.
reloadOnHotUpdate(import.meta);
