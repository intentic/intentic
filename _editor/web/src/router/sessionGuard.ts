import type { User } from "@intentic/api-contract";
import { topPath } from "@intentic/sandbox-contract/app-routes";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { useAuth } from "../client/auth/useAuth";
import { restorePersistedQueries } from "../lib/queryPersistence";
import { signInAt } from "../lib/routes/signIn";
import { restoreImprints } from "../lib/skeletonPersistence";
import { isHomePath } from "../lib/routes/home";
import { enterShell } from "../lib/accounts/accountBoundary";
import { activeSandboxId } from "../app/storage/activeSandbox";
import { rememberedAccount } from "../client/directory/deviceDirectory";
import { platformHealth } from "../lib/platform/platformHealth";
import { normalizeDaemonUrl } from "../lib/daemonUrl";
import { enterFromMemory, type MemoryChoice } from "../features/sandbox/recovery/directMode";

// Resolves the session once (Better Auth cookie); redirects to /login only when the platform authoritatively says none.
// An unavailable platform gets its own retry screen, not treated as a sign-out.
type Resolved = { readonly user: User } | { readonly redirect: RouteLocationRaw; readonly signedOut: boolean };

// A platform that hangs rather than refuses must not hold the first paint on a blank screen: past this the reader gets
// the outage screen, and with it the sandboxes this device can open without the platform (recovery/README.md). The
// check keeps running, and the screen's own retry collects whatever it answers.
const SESSION_BUDGET_MS = 10_000;

const withinBudget = <T>(work: Promise<T>, budgetMs: number): Promise<T> =>
    Promise.race([work, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`the platform did not answer in time`)), budgetMs))]);

// Which remembered sandbox an automatic entry opens for this address: the one a sandbox's own address names (`/open?url=`),
// and only that one, since an address this device does not remember is the outage screen's to offer; else the one this
// window had open.
export const memoryChoice = (to: RouteLocationNormalized): MemoryChoice => {
    if (to.path === topPath(`open`)) {
        const named = [to.query[`url`]].flat()[0];
        return { daemonUrl: (named === null || named === undefined ? undefined : normalizeDaemonUrl(named)) ?? `` };
    }
    return activeSandboxId.value === undefined ? {} : { activeId: activeSandboxId.value };
};

export const unavailable = (to: RouteLocationNormalized): RouteLocationRaw => ({
    path: topPath(`platformUnavailable`),
    query: { returnTo: to.fullPath },
});

export const resolveUser = async (to: RouteLocationNormalized): Promise<Resolved> => {
    const { user, refresh } = useAuth();
    let current = user.value;
    if (current === null) {
        try {
            current = await withinBudget(refresh(), SESSION_BUDGET_MS);
        } catch {
            // A check that hung past the budget told the platform's health nothing yet; one that failed already did
            // (useAuth.ts reports every answer), and a refusal it answered stays the platform answering.
            if (platformHealth.state.value !== `up`) {
                platformHealth.noteUnreachable();
            }
            // A device that remembers the account opens the workspace as it, at once (recovery/directMode.ts).
            const remembered = enterFromMemory(rememberedAccount(), memoryChoice(to));
            return remembered === undefined ? { redirect: unavailable(to), signedOut: false } : { user: remembered };
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
        // A link naming a sandbox the old way (`?sandbox=`) is about an account's, and every other workspace route asks
        // for sign-in; Home's own page of a sandbox gone with the session shows that first run too.
        return isHomePath(to.path) && to.query[`sandbox`] === undefined && resolved.signedOut ? true : resolved.redirect;
    }
    // A page that read another account's drawer at import (the browser moved accounts since it loaded) enters by a full
    // navigation, so nothing it holds reaches this account's shell (lib/accounts/accountBoundary.ts).
    if (!enterShell(to.fullPath)) {
        return false;
    }
    await Promise.all([restorePersistedQueries(resolved.user.id), restoreImprints()]);
    return true;
};
