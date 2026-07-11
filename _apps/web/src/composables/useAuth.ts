import type { Entitlements, Plan, User } from "@intentic-app/api-contract";
import { stripeClient } from "@better-auth/stripe/client";
import { hashKey } from "@tanstack/vue-query";
import { createAuthClient } from "better-auth/client";
import { ref } from "vue";
import { environment } from "../environments/environment";
import { clearPersistedQueries, queryClient } from "./queryPersistence";
import { apiClient } from "./useApi";
import { useGoogleIdentity } from "./useGoogleIdentity";

/* Better Auth browser client + session, as a module-level singleton. The browser calls the API directly;
 * point Better Auth at the API origin (the client appends its /api/auth basePath).
 * callbackURL still returns to the SPA's own origin. The stripe client plugin adds subscription.upgrade (used
 * by upgradeToPro) which talks to the server plugin. */
const client = createAuthClient({
    baseURL: environment.api.url,
    plugins: [stripeClient({ subscription: true })],
});

const { clearCredential } = useGoogleIdentity();

const user = ref<User | null>(null);
// The central account's billing tier — surfaced as a badge in the account panel. `undefined` until the
// server resolves it, so the UI can render nothing plan-dependent instead of flashing the free state.
const plan = ref<Plan | undefined>(undefined);
// What the tier entitles the account to, for early upsell rendering only — the API enforces regardless.
const entitlements = ref<Entitlements | undefined>(undefined);
// plan/entitlements now live in the shared query cache (dedup + SWR + IndexedDB persistence, like the daemon
// queries) — non-sensitive, so unlike sandbox.list they DO persist, painting the badge instantly on reload. A
// QueryCache subscription mirrors the cache entry into the refs above that every consumer already reads (see
// useSandbox for why the cache — not a QueryObserver — is the subscription target: it survives clear() at logout).
const BILLING_PLAN_KEY = [`billing`, `plan`];
const billingPlanQuery = { queryKey: BILLING_PLAN_KEY, queryFn: () => apiClient.billing.plan(), staleTime: 60_000 };
const BILLING_PLAN_HASH = hashKey(BILLING_PLAN_KEY);
queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === BILLING_PLAN_HASH) {
        const data = queryClient.getQueryData<Awaited<ReturnType<typeof apiClient.billing.plan>>>(BILLING_PLAN_KEY);
        plan.value = data?.plan;
        entitlements.value = data?.entitlements;
    }
});
// Visibility of the app's single Upgrade dialog (mounted in App.vue): a plan-gate hit anywhere opens it.
const upgradeOpen = ref(false);

const refresh = async (): Promise<User | null> => {
    const { data } = await client.getSession();
    user.value = data?.user ? { id: data.user.id, email: data.user.email, name: data.user.name, image: data.user.image ?? null } : null;
    return user.value;
};

// Read the server-resolved tier + entitlements into the shared cache (the observer above writes the refs). The
// account panel calls this on open; re-open within staleTime skips the HTTP. Best-effort — a failure leaves the
// last-known value (unknown before the first success), and the caught rejection keeps the @show="refreshPlan"
// handler from surfacing an unhandled rejection. Purely presentational: the API re-checks the subscription on
// every gated route regardless.
const refreshPlan = (): Promise<unknown> => queryClient.fetchQuery(billingPlanQuery).catch(() => undefined);

// Kicks off Google OAuth, returning to `callbackPath` on the SPA origin afterwards (any path is allowed — the
// origin is a Better Auth trusted origin). Defaults to `/`; the invite-accept page passes its own URL so an
// unauthenticated invitee lands back on the invite after signing in.
const signInWithGoogle = async (callbackPath = `/`): Promise<void> => {
    await client.signIn.social({ provider: `google`, callbackURL: `${globalThis.location.origin}${callbackPath}` });
};

const signOut = async (): Promise<void> => {
    clearCredential();
    await clearPersistedQueries();
    await client.signOut();
    user.value = null;
    plan.value = undefined;
    entitlements.value = undefined;
    upgradeOpen.value = false;
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

// GDPR account deletion (Settings → danger zone). The server hook deletes the Stripe customer first, then
// Prisma cascades remove sessions/accounts/sandboxes/grants with the user row. Better Auth requires a fresh
// session for password-less users — a stale one surfaces as the returned error.
const deleteAccount = async (): Promise<void> => {
    const { error } = await client.deleteUser();
    if (error) {
        throw new Error(error.message ?? `Account deletion failed.`);
    }
    clearCredential();
    await clearPersistedQueries();
    user.value = null;
    plan.value = undefined;
    entitlements.value = undefined;
    upgradeOpen.value = false;
};

// Start checkout for the platform's "pro" plan. Redirects the whole page to Stripe Checkout, then back to the
// SPA origin (a trusted origin) on success/cancel. This is only the checkout hand-off — gating is enforced
// server-side (entitlements.ts) on the API routes themselves.
const upgradeToPro = async (): Promise<void> => {
    await client.subscription.upgrade({
        plan: `pro`,
        successUrl: `${globalThis.location.origin}/?billing=success`,
        cancelUrl: `${globalThis.location.origin}/?billing=cancel`,
    });
};

export function useAuth() {
    return { user, plan, entitlements, upgradeOpen, refresh, refreshPlan, signInWithGoogle, signOut, updateProfile, deleteAccount, upgradeToPro };
}
