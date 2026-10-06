import type { SandboxSummary, User } from "@intentic/api-contract";
import { t } from "@intentic/ui/i18n";
import { createAuthClient } from "better-auth/client";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../app/hotReload";
import { announceDesktopRoster } from "../../app/environments/desktop";
import { environment } from "../../app/environments/environment";
import { localFace } from "../../app/environments/local";
import { clearImprints } from "@intentic/ui/skeleton-store";
import { clearPersistedQueries } from "../../lib/queryPersistence";
import { useSandboxSession } from "../session/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "../../lib/authLifecycle";
import { forgetAccount } from "../directory/deviceDirectory";
import { directMode } from "../directory/directState";

// Module-level Better Auth client, pointed at the API origin; callbackURL still returns to the SPA's own origin.
const client = createAuthClient({ baseURL: environment.api.url });

const { clearCredential } = useGoogleIdentity();
const { clearSessions, retireAccountAccess } = useSandboxSession();

// allow(module-state): the signed-in account, above every sandbox
const user = ref<User | null>(null);
let refreshing: Promise<User | null> | undefined;

onPlatformAuthInvalidated(async () => {
    // A desktop window on a folder of this computer runs as a placeholder with no platform session to lose, and the one
    // session it holds is its folder's: tearing down here would cut it off from its own files. What a sign-out or a
    // refused call ends there is the account the app reaches for it, which client/auth/useAccount.ts clears.
    if (localFace() !== undefined) {
        return;
    }
    // Signed-in runtime stops first, before storage/cache cleanup, so no live daemon stream outlives the teardown.
    user.value = null;
    directMode.value = false;
    clearCredential();
    clearSessions();
    // The desktop app's local windows list this account's sandboxes from what this page told it; none are theirs now.
    announceDesktopRoster([]);
    // The remembered loading imprints are the account's sandboxes' too: how many secrets, rows, agents each one held.
    await Promise.all([clearPersistedQueries(), clearImprints()]);
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
        user.value = { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null };
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
    user.value = account;
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
    return { user, refresh, signInWithGoogle, signInWithGoogleCredential, signOut, updateProfile, deleteAccount, enterDirect };
}

// One signed-in account per window: a hot update that re-ran this module (a change to anything it imports, such as
// the environment files) would mint a fresh `user` of null that no route guard re-resolves, dropping the account
// from every component re-run with it while the rest keep the old one (hotReload.ts).
reloadOnHotUpdate(import.meta);
