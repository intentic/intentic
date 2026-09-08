import type { SandboxSummary, User } from "@intentic/api-contract";
import { createAuthClient } from "better-auth/client";
import { ref } from "vue";
import { environment } from "../../app/environments/environment";
import { clearPersistedQueries } from "../../lib/queryPersistence";
import { useSandboxSession } from "../sandbox/client/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "./authLifecycle";

// Module-level Better Auth client, pointed at the API origin; callbackURL still returns to the SPA's own origin.
const client = createAuthClient({ baseURL: environment.api.url });

const { clearCredential } = useGoogleIdentity();
const { clearSessions, retireAccountAccess } = useSandboxSession();

const user = ref<User | null>(null);
let refreshing: Promise<User | null> | undefined;

onPlatformAuthInvalidated(async () => {
    // Signed-in runtime stops first, before storage/cache cleanup, so no live daemon stream outlives the teardown.
    user.value = null;
    clearCredential();
    clearSessions();
    await clearPersistedQueries();
});

const refresh = async (): Promise<User | null> => {
    const pending = (refreshing ??= (async () => {
        const { data, error } = await client.getSession();
        if (error) {
            throw new Error(error.message ?? `Couldn't check your session.`);
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
        throw new Error(error.message ?? `Google sign-in was refused.`);
    }
    // Fills `user` early only; a failure here is a harmless blip after sign-in already succeeded.
    await refresh().catch(() => undefined);
};

const signOut = async (): Promise<void> => {
    // Server session goes first; a blocked local storage must never block the authoritative logout.
    const { error } = await client.signOut();
    if (error) {
        throw new Error(error.message ?? `Sign out failed.`);
    }
    await invalidatePlatformAuth();
};

// Settings profile update via Better Auth's update-user endpoint (validated server-side by auth.ts's user.update
// hook); re-reads the session so `user` picks up the change.
const updateProfile = async (input: { name?: string; image?: string }): Promise<void> => {
    const { error } = await client.updateUser(input);
    if (error) {
        throw new Error(error.message ?? `Profile update failed.`);
    }
    await refresh();
};

// GDPR account deletion; Prisma cascades remove sessions/accounts/sandboxes/grants with the user row. Better Auth
// needs a fresh session for password-less users, surfacing a stale one as the returned error.
const deleteAccount = async (sandboxes: readonly SandboxSummary[]): Promise<void> => {
    await retireAccountAccess(sandboxes);
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? `Account deletion failed.`);
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
    return { user, refresh, signInWithGoogle, signInWithGoogleCredential, signOut, updateProfile, deleteAccount };
}
