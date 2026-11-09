import type { SandboxSummary, SignInMethod, User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient, multiSessionClient } from "better-auth/client/plugins";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { environment } from "../../app/environments/environment";
import { localFace } from "../../app/environments/local";
import { useSandboxSession } from "../session/sandboxSession";
import { emailCodeError } from "./emailCode";
import { accountWaysIn } from "./signInMethods";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "../../lib/authLifecycle";
import { apiClient } from "../../lib/useApi";
import { forgetAccount } from "../directory/deviceDirectory";
import { noteAppAccount } from "./appAccounts";
import { directMode } from "../directory/directState";
import { z } from "zod";
import { platformHealth, reportedFetch } from "../../lib/platform/platformHealth";
import { markBoot } from "../../app/perf/boot";
import {
    accountExpectation,
    assertAccountCurrent,
    checkAnswerAccount,
    enterAccount,
    leaveForNobody,
    releaseAccount,
    setAccountReconciler,
} from "../../lib/accounts/accountBoundary";
import { forgetAccountTraces } from "./accountTeardown";

// Module-level Better Auth client, pointed at the API origin; callbackURL still returns to the SPA's own origin. The
// email-OTP plugin is the second way in: one mailed code, typed here or followed from the mail's link (/login/confirm).
// The multi-session plugin is the browser's other accounts (deviceAccounts.ts). Every call that changes something says
// which account this page is drawn for, and one the platform refused as meant for someone else has the page find out who
// is signed in now (lib/accounts/accountBoundary.ts).
const client = createAuthClient({
    baseURL: environment.api.url,
    plugins: [emailOTPClient(), multiSessionClient()],
    fetchOptions: {
        // Every answer the session check and the sign-in calls get, and every call nothing answered, is reported to the
        // one reading of the platform's health (lib/platform/platformHealth.ts).
        customFetchImpl: (input, init) => reportedFetch(() => globalThis.fetch(input, init)),
        onRequest: (context) => {
            assertAccountCurrent();
            for (const [name, value] of Object.entries(accountExpectation(context.method))) {
                context.headers.set(name, value);
            }
            return context;
        },
        onResponse: async (context) => {
            await checkAnswerAccount(context.response);
        },
    },
});

const { retireAccountAccess } = useSandboxSession();

// allow(module-state): the signed-in account, above every sandbox
const user = ref<User | null>(null);
// The active session's token, which signing out of just this account names (deviceAccounts.ts); kept in memory only.
let sessionToken: string | undefined;
let refreshing: Promise<User | null> | undefined;
// Whether the account is leaving because the reader asked (a sign-out, a deletion) rather than because its session ended:
// the page goes elsewhere by itself then (afterSignOut.ts), and nothing should ask to sign in again on the way out. Never
// cleared: a page that signed out on purpose is about to be replaced.
// allow(module-state): about this page's life, which the sign-out's own navigation ends
let leaving = false;

// How the account signs in, which the session's own answer does not carry: asked of /me once per account and kept, since
// it changes only when Google is linked, and linking returns through Google's redirect, which loads the page afresh. A
// failed ask is not kept, so the next session check asks again; until then the account reads as a Google one, the
// answer every platform from before email sign-in gives.
let methodsKnown: { readonly id: string; readonly methods: readonly SignInMethod[] | undefined } | undefined;
const signInMethodsOf = async (id: string): Promise<readonly SignInMethod[] | undefined> => {
    if (methodsKnown?.id === id) {
        return methodsKnown.methods;
    }
    try {
        const me = await apiClient.me.get();
        const methods = me?.id === id ? me.signInMethods : undefined;
        methodsKnown = { id, methods };
        return methods;
    } catch (error) {
        console.warn(`[auth] the platform could not say how this account signs in:`, error);
        return undefined;
    }
};

// The account as every reader holds it, with its ways in written beside it for the session module (signInMethods.ts).
const holdAccount = (account: User | null): void => {
    user.value = account;
    if (account !== null) {
        void noteAppAccount(account.email);
    }
    accountWaysIn.value = account === null ? undefined : { email: account.email, methods: account.signInMethods };
};

onPlatformAuthInvalidated(async () => {
    // A desktop window on a folder of this computer runs as a placeholder with no platform session to lose, and the one
    // session it holds is its folder's: tearing down here would cut it off from its own files. What a sign-out or a
    // refused call ends there is the account the app reaches for it, which client/auth/useAccount.ts clears.
    if (localFace() !== undefined) {
        return;
    }
    // Signed-in runtime stops first, before storage/cache cleanup, so no live daemon stream outlives the teardown. The
    // account's session ended, so it is this page's no longer: the next one entered starts afresh (lib/accounts/accountBoundary.ts).
    holdAccount(null);
    methodsKnown = undefined;
    sessionToken = undefined;
    directMode.value = false;
    releaseAccount();
    // This account's traces, and only this account's: another signed in on this browser keeps its own (accountTeardown.ts).
    // A sign-out or deletion asked for here cleared what it meant to before it said so.
    if (!leaving) {
        await forgetAccountTraces();
    }
});

// What the session check answers when the platform itself answers: a session object, or null for none.
const SessionAnswerSchema = z.union([z.null(), z.looseObject({ user: z.looseObject({}), session: z.looseObject({}) })]);

const refresh = async (): Promise<User | null> => {
    const pending = (refreshing ??= (async () => {
        const { data, error } = await client.getSession();
        // The platform's answer to the start's session check (app/perf/boot.ts; only the first one counts).
        markBoot(`session`);
        if (error) {
            throw new Error(error.message ?? t(`auth.useAuth.sessionCheckFailed`));
        }
        // Only the platform's own word is an answer: a session, or `null` for none. Anything else that came back 200 (a
        // captive portal's or a proxy's page, text where JSON belongs) is no answer at all, and must not sign the window
        // out and throw away its daemon sessions as an authoritative "no session" would (2026-11-09).
        if (!SessionAnswerSchema.safeParse(data).success) {
            platformHealth.noteUnreachable();
            throw new Error(t(`auth.useAuth.sessionCheckFailed`));
        }
        if (data?.user === undefined) {
            // Only tears down when there was a session to lose; invalidating on a cold signed-out load would cancel
            // /desktop-auth's Google mint mid-flight (it starts the mint before checking the session) and kill silent
            // re-auth
            // for the page's life.
            if (user.value !== null) {
                await invalidatePlatformAuth();
            }
            return null;
        }
        const account: User = { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null };
        // The account this page is drawn for, or another one now (a switch in another tab, a sign-in that ended
        // somewhere else): then the page is reloading as it, and draws nothing more as the one it was.
        if (enterAccount(account) === `reloading`) {
            return new Promise<never>(() => undefined);
        }
        sessionToken = data.session.token;
        const methods = await signInMethodsOf(data.user.id);
        if (methods !== undefined) {
            account.signInMethods = [...methods];
        }
        holdAccount(account);
        // The platform answered with a session: whatever was opened directly is on it again.
        directMode.value = false;
        return user.value;
    })().finally(() => {
        refreshing = undefined;
    }));
    return pending;
};

// An answer made as someone else (lib/accounts/accountBoundary.ts) is settled by asking who is signed in now.
setAccountReconciler(async () => {
    await refresh();
});

// Kicks off Google OAuth, returning to `callbackPath` on the SPA origin (a Better Auth trusted origin). Defaults to
// `/`; the invite-accept page passes its own URL to land back there after signing in. `chooseAccount` is an account being
// added beside the one signed in: Google is told to ask which account (`prompt=select_account`), since with one Google
// session in this browser it would otherwise answer with that one again, the account already here.
const signInWithGoogle = async (callbackPath = `/`, options: { readonly chooseAccount?: boolean } = {}): Promise<void> => {
    const callbackURL = `${globalThis.location.origin}${callbackPath}`;
    if (options.chooseAccount !== true) {
        await client.signIn.social({ provider: `google`, callbackURL });
        return;
    }
    const { data, error } = await client.signIn.social({ provider: `google`, callbackURL, disableRedirect: true });
    if (error || data?.url === undefined) {
        throw new Error(error?.message ?? t(`auth.useAuth.googleRefused`));
    }
    const authorize = new URL(data.url);
    authorize.searchParams.set(`prompt`, `select_account`);
    globalThis.location.href = authorize.toString();
};

// Who the browser's active session is, asked of the platform without taking it as this page's (refresh does that): what
// an account added, switched to or left for is, before the page leaves for it (deviceAccounts.ts).
const activeAccount = async (): Promise<User | null> => {
    const { data, error } = await client.getSession();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.sessionCheckFailed`));
    }
    return data?.user === undefined ? null : { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null };
};

// What a sign-in does once the platform took it: taken as this page's account, or, for an account being added beside
// the one signed in (`adding`), left for the caller to leave for (deviceAccounts.ts `arriveAsAdded`), since this page is
// drawn for the other one.
const afterSignIn = async (adding: boolean): Promise<void> => {
    if (adding) {
        return;
    }
    // Fills `user` early only; a failure here is a harmless blip after sign-in already succeeded.
    // allow(silent-catch): a failed re-read is a blip after a sign-in that worked; the next session check fills `user`.
    await refresh().catch(() => undefined);
};

// One-directional: sends a credential this browser holds into the platform, never receives one back, so sandbox
// trust never depends on the platform's honesty. Throws on refusal; the credential stays uncleared, since that
// says nothing about whether the sandbox will refuse it too.
const signInWithGoogleCredential = async (idToken: string, options: { readonly adding?: boolean } = {}): Promise<void> => {
    const { error } = await client.$fetch(`/one-tap/callback`, { method: `POST`, body: { idToken } });
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.googleRefused`));
    }
    await afterSignIn(options.adding === true);
};

// The second way in: a six-digit code mailed to the address. The platform answers alike whether or not an account holds
// it, and creates one at the first sign-in, so the screens that call this show the terms before anything is sent.
const sendEmailCode = async (email: string): Promise<void> => {
    const { error } = await client.emailOtp.sendVerificationOtp({ email: email.trim(), type: `sign-in` });
    if (error) {
        throw emailCodeError(error, t(`auth.emailCode.sendFailed`));
    }
};

// Spends the code (typed, or carried by the mail's link to /login/confirm) on a platform session.
const signInWithEmailCode = async (email: string, otp: string, options: { readonly adding?: boolean } = {}): Promise<void> => {
    const { error } = await client.signIn.emailOtp({ email: email.trim(), otp });
    if (error) {
        throw emailCodeError(error, t(`auth.emailCode.signInFailed`));
    }
    await afterSignIn(options.adding === true);
};

// Adds a Google sign-in to the account signed in now (the platform trusts Google for linking), returning to
// `callbackPath`: what the free hosted machine and the trial ask of an account that signs in by email.
const linkGoogle = async (callbackPath = `/`): Promise<void> => {
    const { error } = await client.linkSocial({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.linkGoogleFailed`));
    }
};

// The accounts signed in on this browser (Better Auth's device sessions), each with the token that names it to the
// platform, held in memory only. A sixth account signed in past MAX_DEVICE_ACCOUNTS is active but not listed, so the list
// may not hold the active one.
export interface DeviceSession {
    readonly token: string;
    readonly user: User;
}

const listDeviceSessions = async (): Promise<readonly DeviceSession[]> => {
    const { data, error } = await client.multiSession.listDeviceSessions();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.sessionCheckFailed`));
    }
    return (data ?? []).map((entry) => ({
        token: entry.session.token,
        user: { id: entry.user.id, email: entry.user.email, name: entry.user.name, image: entry.user.image ?? null },
    }));
};

// Makes one of the browser's signed-in accounts the active one: the platform answers as it from then on, in every tab.
// Refused when that sign-in has ended meanwhile.
const activateDeviceSession = async (token: string): Promise<User> => {
    const { data, error } = await client.multiSession.setActive({ sessionToken: token });
    if (error || data === null) {
        throw new Error(error?.message ?? t(`auth.useAuth.sessionCheckFailed`));
    }
    return { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null };
};

// Ends one of the browser's accounts; ending the active one makes the platform activate another still signed in.
const revokeDeviceSession = async (token: string): Promise<void> => {
    const { error } = await client.multiSession.revoke({ sessionToken: token });
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.signOutFailed`));
    }
};

// Signs out of EVERY account this browser holds: Better Auth's sign-out ends each device session, so each is forgotten
// here too, and every account's drawer with it. Signing out of only the account in front of the reader is
// deviceAccounts.ts `signOutHere`, which comes here when it is the only one.
const signOut = async (): Promise<void> => {
    // Who else is signed in here, asked first: once the platform has ended them all it can no longer say.
    // allow(silent-catch): an unanswered list forgets only the account in hand; the others' memory is harmless.
    const others = await listDeviceSessions().catch((): readonly DeviceSession[] => []);
    // Server session goes first; a blocked local storage must never block the authoritative logout.
    const { error } = await client.signOut();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.signOutFailed`));
    }
    // Only an explicit sign-out: a refused session (the teardown below) is when this device's memory is needed most.
    const signedOut = new Set([...others.map((entry) => entry.user.email), ...(user.value === null ? [] : [user.value.email])]);
    for (const email of signedOut) {
        forgetAccount(email);
    }
    leaving = true;
    await forgetAccountTraces(`every`);
    leaveForNobody();
    await invalidatePlatformAuth();
};

// Opens this window as an account the platform cannot vouch for right now (recovery/directMode.ts): the account this
// device last saw it list, whole, so everything keyed by it reads as before. The next session check the platform
// answers replaces it, or signs out.
const enterDirect = (account: User): void => {
    if (enterAccount(account) === `reloading`) {
        return;
    }
    holdAccount(account);
    directMode.value = true;
};

// Settings profile update via Better Auth's update-user endpoint (validated server-side by auth.ts's user.update
// hook); re-reads the session so `user` picks up the change.
const updateProfile = async (input: { name?: string; image?: string }): Promise<void> => {
    const { error } = await client.updateUser(input);
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.profileUpdateFailed`));
    }
    await refresh();
};

// GDPR account deletion; Prisma cascades remove sessions/accounts/sandboxes/grants with the user row. Better Auth
// needs a fresh session for password-less users, surfacing a stale one as the returned error. The deleted account is
// forgotten here whole; another account still signed in on this browser is the caller's to carry on as
// (deviceAccounts.ts `deleteAndContinue`), so `continuing` leaves the page in place for it instead of signing it out.
const deleteAccount = async (sandboxes: readonly SandboxSummary[], options: { readonly continuing?: boolean } = {}): Promise<void> => {
    await retireAccountAccess(sandboxes);
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.accountDeletionFailed`));
    }
    if (user.value !== null) {
        forgetAccount(user.value.email);
    }
    leaving = true;
    await forgetAccountTraces();
    if (options.continuing === true) {
        return;
    }
    leaveForNobody();
    await invalidatePlatformAuth();
};

// The auth cookie can expire or be revoked while this SPA stays open for days; focus/online catch a background tab
// becoming active again, alongside the 401 path protected RPCs already provide (useApi.ts).
const revalidateIfSignedIn = (): void => {
    if (user.value !== null) {
        void refresh().catch(() => undefined);
    }
};
globalThis.addEventListener?.(`focus`, revalidateIfSignedIn);
globalThis.addEventListener?.(`online`, revalidateIfSignedIn);
globalThis.document?.addEventListener(`visibilitychange`, () => {
    if (document.visibilityState === `visible`) {
        revalidateIfSignedIn();
    }
});

export function useAuth() {
    return {
        user,
        refresh,
        signInWithGoogle,
        signInWithGoogleCredential,
        sendEmailCode,
        signInWithEmailCode,
        linkGoogle,
        signOut,
        updateProfile,
        deleteAccount,
        enterDirect,
        activeAccount,
        listDeviceSessions,
        activateDeviceSession,
        revokeDeviceSession,
        sessionToken: (): string | undefined => sessionToken,
        signingOut: (): boolean => leaving,
    };
}

// One signed-in account per window: a hot update that re-ran this module (a change to anything it imports, such as
// the environment files) would mint a fresh `user` of null that no route guard re-resolves, dropping the account
// from every component re-run with it while the rest keep the old one (hotReload.ts).
reloadOnHotUpdate(import.meta);
