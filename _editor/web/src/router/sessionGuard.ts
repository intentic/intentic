import type { User } from "@intentic/api-contract";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { useAuth } from "../client/auth/useAuth";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { signInAt } from "../lib/routes/signIn";
import { restoreImprints } from "../lib/skeletonPersistence";
import { isHomePath } from "../lib/routes/home";

// Resolves the session once (Better Auth cookie); redirects to /login only when the platform authoritatively says none.
// An unavailable platform gets its own retry screen, not treated as a sign-out.
type Resolved = { readonly user: User } | { readonly redirect: RouteLocationRaw; readonly signedOut: boolean };

// A platform that hangs rather than refuses must not hold the first paint on a blank screen: past this the reader gets
// the outage screen, and with it the sandboxes this device can open without the platform (recovery/README.md). The
// check keeps running, and the screen's own retry collects whatever it answers.
const SESSION_BUDGET_MS = 10_000;

const withinBudget = <T>(work: Promise<T>, budgetMs: number): Promise<T> =>
    Promise.race([work, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`the platform did not answer in time`)), budgetMs))]);

export const unavailable = (to: RouteLocationNormalized): RouteLocationRaw => ({ path: `/platform-unavailable`, query: { returnTo: to.fullPath } });

export const resolveUser = async (to: RouteLocationNormalized): Promise<Resolved> => {
    const { user, refresh } = useAuth();
    let current = user.value;
    if (current === null) {
        try {
            current = await withinBudget(refresh(), SESSION_BUDGET_MS);
        } catch {
            return { redirect: unavailable(to), signedOut: false };
        }
    }
    // Signed out: the login screen carries the page that asked for it, the address asked for rather than where the shell's
    // own redirect put it, so `/?sandbox=<id>` comes back as itself and opens that sandbox rather than Home.
    return current ? { user: current } : { redirect: signInAt((to.redirectedFrom ?? to).fullPath), signedOut: true };
};

// Signed in, with a user in hand: hydrate the query cache from IndexedDB (per-user buster) before any route mounts, so
// a reload paints the last-known workspace instead of blocking on the daemon, and the active sandbox's remembered
// loading shapes beside it, so whatever the cache cannot paint yet is outlined in the shape it last had.
export const requireAuth = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> => {
    const resolved = await resolveUser(to);
    if (!(`user` in resolved)) {
        // Home's first run is useful before an account exists, and the bare address lands there (lib/routes/firstScreens.ts).
        // A link naming a sandbox (`?sandbox=`) is about an account's, and every other workspace route asks for sign-in.
        return isHomePath(to.path) && to.query[`sandbox`] === undefined && resolved.signedOut ? true : resolved.redirect;
    }
    await Promise.all([restorePersistedQueries(resolved.user.id), restoreImprints()]);
    return true;
};
