import type { SandboxSummary, SignInMethod, User } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import { createAuthClient } from "better-auth/client";
import { emailOTPClient } from "better-auth/client/plugins";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { announceDesktopRoster } from "../../app/environments/desktop";
import { environment } from "../../app/environments/environment";
import { localFace } from "../../app/environments/local";
import { clearImprints } from "@intentic/ui/skeleton-store";
import { clearPersistedQueries } from "../../lib/queryPersistence";
import { clearAccountStorage } from "../../app/storage/browserStorage";
import { useSandboxSession } from "../session/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { emailCodeError } from "./emailCode";
import { accountWaysIn } from "./signInMethods";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "../../lib/authLifecycle";
import { apiClient } from "../../lib/useApi";
import { forgetAccount } from "../directory/deviceDirectory";
import { directMode } from "../directory/directState";

// Module-level Better Auth client, pointed at the API origin; callbackURL still returns to the SPA's own origin. The
// email-OTP plugin is the second way in: one mailed code, typed here or followed from the mail's link (/login/confirm).
const client = createAuthClient({ baseURL: environment.api.url, plugins: [emailOTPClient()] });

const { clearCredential } = useGoogleIdentity();
const { clearSessions, retireAccountAccess } = useSandboxSession();

// allow(module-state): the signed-in account, above every sandbox
const user = ref<User | null>(null);
let refreshing: Promise<User | null> | undefined;

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
    accountWaysIn.value = account === null ? undefined : { email: account.email, methods: account.signInMethods };
};

onPlatformAuthInvalidated(async () => {
    // A desktop window on a folder of this computer runs as a placeholder with no platform session to lose, and the one
    // session it holds is its folder's: tearing down here would cut it off from its own files. What a sign-out or a
    // refused call ends there is the account the app reaches for it, which client/auth/useAccount.ts clears.
    if (localFace() !== undefined) {
        return;
    }
    // Signed-in runtime stops first, before storage/cache cleanup, so no live daemon stream outlives the teardown.
    holdAccount(null);
    methodsKnown = undefined;
    directMode.value = false;
    clearCredential();
    clearSessions();
    // The desktop app's local windows list this account's sandboxes from what this page told it; none are theirs now.
    announceDesktopRoster([]);
    // The remembered loading imprints are the account's sandboxes' too: how many secrets, rows, agents each one held. So
    // is everything the account left in storage (open chats, drafts, recent prompts, the transcript mirror, which
    // sandbox was open); a device preference (theme, language, layout) stays. lib/browserStorage.ts declares which.
    await Promise.all([clearPersistedQueries(), clearImprints(), clearAccountStorage()]);
    // Module state that belongs to one sandbox (the open tabs, the roster, set-aside drafts, extensions' badges) is
    // emptied last, so what refills it on its next read finds the storage already cleared.
    resetSandboxScope();
});

const refresh = async (): Promise<User | null> => {
    const pending = (refreshing ??= (async () => {
        const { data, error } = await client.getSession();
        if (error) {
            throw new Error(error.message ?? t(`auth.useAuth.sessionCheckFailed`));
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

// Kicks off Google OAuth, returning to `callbackPath` on the SPA origin (a Better Auth trusted origin). Defaults to
// `/`; the invite-accept page passes its own URL to land back there after signing in.
const signInWithGoogle = async (callbackPath = `/`): Promise<void> => {
    await client.signIn.social({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
};

// One-directional: sends a credential this browser holds into the platform, never receives one back, so sandbox
// trust never depends on the platform's honesty. Throws on refusal; the credential stays uncleared, since that
// says nothing about whether the sandbox will refuse it too.
const signInWithGoogleCredential = async (idToken: string): Promise<void> => {
    const { error } = await client.$fetch(`/one-tap/callback`, { method: `POST`, body: { idToken } });
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.googleRefused`));
    }
    // Fills `user` early only; a failure here is a harmless blip after sign-in already succeeded.
    await refresh().catch(() => undefined);
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
const signInWithEmailCode = async (email: string, otp: string): Promise<void> => {
    const { error } = await client.signIn.emailOtp({ email: email.trim(), otp });
    if (error) {
        throw emailCodeError(error, t(`auth.emailCode.signInFailed`));
    }
    // Fills `user` early only, as after a Google credential: the sign-in already succeeded.
    // allow(silent-catch): a failed re-read is a blip after a sign-in that worked; the next session check fills `user`.
    await refresh().catch(() => undefined);
};

// Adds a Google sign-in to the account signed in now (the platform trusts Google for linking), returning to
// `callbackPath`: what the free hosted machine and the trial ask of an account that signs in by email.
const linkGoogle = async (callbackPath = `/`): Promise<void> => {
    const { error } = await client.linkSocial({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.linkGoogleFailed`));
    }
};

const signOut = async (): Promise<void> => {
    // Server session goes first; a blocked local storage must never block the authoritative logout.
    const { error } = await client.signOut();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.signOutFailed`));
    }
    // Only an explicit sign-out: a refused session (the teardown below) is when this device's memory is needed most.
    if (user.value !== null) {
        forgetAccount(user.value.email);
    }
    await invalidatePlatformAuth();
};

// Opens this window as an account the platform cannot vouch for right now (recovery/directMode.ts): the account this
// device last saw it list, whole, so everything keyed by it reads as before. The next session check the platform
// answers replaces it, or signs out.
const enterDirect = (account: User): void => {
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
// needs a fresh session for password-less users, surfacing a stale one as the returned error.
const deleteAccount = async (sandboxes: readonly SandboxSummary[]): Promise<void> => {
    await retireAccountAccess(sandboxes);
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? t(`auth.useAuth.accountDeletionFailed`));
    }
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
    };
}

// One signed-in account per window: a hot update that re-ran this module (a change to anything it imports, such as
// the environment files) would mint a fresh `user` of null that no route guard re-resolves, dropping the account
// from every component re-run with it while the rest keep the old one (hotReload.ts).
reloadOnHotUpdate(import.meta);
