import type { SandboxSummary, User } from "@intentic-app/api-contract";
import { createAuthClient } from "better-auth/client";
import { ref } from "vue";
import { environment } from "../environments/environment";
import { clearPersistedQueries } from "./queryPersistence";
import { useSandboxSession } from "./sandbox/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { invalidatePlatformAuth, onPlatformAuthInvalidated } from "./authLifecycle";

/* Better Auth browser client + session, as a module-level singleton. The browser calls the API directly;
 * point Better Auth at the API origin (the client appends its /api/auth basePath).
 * callbackURL still returns to the SPA's own origin. */
const client = createAuthClient({ baseURL: environment.api.url });

const { clearCredential } = useGoogleIdentity();
const { clearSessions, retireAccountAccess } = useSandboxSession();

const user = ref<User | null>(null);
let refreshing: Promise<User | null> | undefined;

onPlatformAuthInvalidated(async () => {
    // Stop the signed-in runtime first; storage/cache cleanup follows without leaving a live daemon stream in
    // the window meanwhile. Every storage operation beneath these calls is safe when persistence is blocked.
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
            await invalidatePlatformAuth();
            return null;
        }
        user.value = { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null };
        return user.value;
    })().finally(() => {
        refreshing = undefined;
    }));
    return pending;
};

// Kicks off Google OAuth, returning to `callbackPath` on the SPA origin afterwards (any path is allowed, the
// origin is a Better Auth trusted origin). Defaults to `/`; the invite-accept page passes its own URL so an
// unauthenticated invitee lands back on the invite after signing in.
const signInWithGoogle = async (callbackPath = `/`): Promise<void> => {
    await client.signIn.social({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
};

/* THE SAME SIGN-IN, DONE IN THE BROWSER, where the credential can be kept.
 *
 * The redirect above proves the user to the platform and leaves this window with nothing, so the sandbox had
 * to ask for Google a second time: the daemon authenticates the end user against Google directly (it does not
 * trust us, by design), and only the browser can hand it a Google-signed token. Minting that token HERE and
 * spending it on the platform too collapses the two asks into one.
 *
 * Deliberately one-directional: this sends a Google credential the browser already holds INTO the platform.
 * The platform never hands one back, so nothing the sandbox trusts depends on the platform being honest, a
 * daemon that is forked, older, or modified to distrust the platform entirely sees exactly what it sees today.
 *
 * Throws when the platform will not take it (a self-hosted build without the endpoint, a client-id mismatch,
 * a token Google will not vouch for). Callers fall back to the redirect; the Google credential is NOT cleared
 * on the way out, because a platform that rejects it says nothing about whether the sandbox will. */
const signInWithGoogleCredential = async (idToken: string): Promise<void> => {
    const { error } = await client.$fetch(`/one-tap/callback`, { method: `POST`, body: { idToken } });
    if (error) {
        throw new Error(error.message ?? `Google sign-in was refused.`);
    }
    // The session cookie is set by the call above; this only fills the shared `user` ref early. A failure here
    // is a blip AFTER a sign-in that already happened, and throwing would tell the caller the opposite, so
    // let the route guard resolve the session on the way in, as it does on every reload.
    await refresh().catch(() => undefined);
};

const signOut = async (): Promise<void> => {
    // The server session goes first. Local storage being blocked must never prevent the authoritative logout.
    const { error } = await client.signOut();
    if (error) {
        throw new Error(error.message ?? `Sign out failed.`);
    }
    await invalidatePlatformAuth();
};

// Settings → profile: display name + avatar (a small data URL) via Better Auth's built-in update-user
// endpoint (validated server-side by the auth.ts user.update hook), then re-read the session so every
// render of the shared `user` ref picks up the change.
const updateProfile = async (input: { name?: string; image?: string }): Promise<void> => {
    const { error } = await client.updateUser(input);
    if (error) {
        throw new Error(error.message ?? `Profile update failed.`);
    }
    await refresh();
};

// GDPR account deletion (Settings → danger zone). Prisma cascades remove sessions/accounts/sandboxes/grants
// with the user row. Better Auth requires a fresh session for password-less users, a stale one surfaces as
// the returned error.
const deleteAccount = async (sandboxes: readonly SandboxSummary[]): Promise<void> => {
    await retireAccountAccess(sandboxes);
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? `Account deletion failed.`);
    }
    await invalidatePlatformAuth();
};

// Better Auth's cookie can refresh, expire, or be revoked while this SPA stays open for days. Focus/online are
// the moments a background tab becomes actionable again; protected platform RPCs provide the immediate 401
// path while it remains active (useApi.ts).
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
