import type { User } from "@intentic-app/api-contract";
import { createAuthClient } from "better-auth/client";
import { ref } from "vue";
import { environment } from "../environments/environment";
import { clearPersistedQueries } from "./queryPersistence";
import { useSandboxSession } from "./sandbox/sandboxSession";
import { useGoogleIdentity } from "./useGoogleIdentity";

/* Better Auth browser client + session, as a module-level singleton. The browser calls the API directly;
 * point Better Auth at the API origin (the client appends its /api/auth basePath).
 * callbackURL still returns to the SPA's own origin. */
const client = createAuthClient({ baseURL: environment.api.url });

const { clearCredential } = useGoogleIdentity();
const { clearSessions } = useSandboxSession();

const user = ref<User | null>(null);

const refresh = async (): Promise<User | null> => {
    const { data } = await client.getSession();
    user.value = data?.user ? { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null } : null;
    return user.value;
};

// Kicks off Google OAuth, returning to `callbackPath` on the SPA origin afterwards (any path is allowed — the
// origin is a Better Auth trusted origin). Defaults to `/`; the invite-accept page passes its own URL so an
// unauthenticated invitee lands back on the invite after signing in.
const signInWithGoogle = async (callbackPath = `/`): Promise<void> => {
    await client.signIn.social({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
};

const signOut = async (): Promise<void> => {
    clearCredential();
    clearSessions();
    await clearPersistedQueries();
    await client.signOut();
    user.value = null;
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
// with the user row. Better Auth requires a fresh session for password-less users — a stale one surfaces as
// the returned error.
const deleteAccount = async (): Promise<void> => {
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? `Account deletion failed.`);
    }
    clearCredential();
    clearSessions();
    await clearPersistedQueries();
    user.value = null;
};

export function useAuth() {
    return { user, refresh, signInWithGoogle, signOut, updateProfile, deleteAccount };
}
