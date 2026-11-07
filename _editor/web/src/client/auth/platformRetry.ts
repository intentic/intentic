import { within } from "@intentic/base/async";
import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { useAuth } from "./useAuth";
import { returnPath } from "../../lib/routes/signIn";

// One more ask of the platform, answering with where the reader belongs: once it answers at all, the page they were headed
// for, whose own guards then rule on the session as they would have if the first ask had been answered (requireAuth,
// router/sessionGuard.ts): sign-in for a page that needs one, Home kept for a reader with none, as a cold load leaves
// them. Undefined while it still can't answer. Every way off the unavailable screen (its button, its own background
// retry, a reload onto it) goes through this, so they cannot drift.
// Sending "no session" to sign-in here, ahead of the guards, put a signed-out reader on Home under a sign-in prompt they
// never asked for, covering Home's own Sign in (e2e-signin, run 42383887317).
export const platformRetry = async (returnTo: unknown): Promise<RouteLocationRaw | undefined> => {
    try {
        await useAuth().refresh();
    } catch {
        return undefined;
    }
    return returnPath(returnTo);
};

/** How long a reload's ask may delay the first paint before the screen is drawn instead. */
export const ENTRY_BUDGET_MS = 1500;

// A platform that hangs rather than refuses must not hold the boot on a blank splash: past the budget the caller is
// told nothing came back. The ask itself keeps running, and the screen's own retry collects whatever it answers.
const withinBudget = <T>(work: Promise<T>): Promise<T | undefined> => within(work, ENTRY_BUDGET_MS, undefined);

// Entry rule for /platform-unavailable. A direct hit (a reload, a bookmark, a restored tab) asks again before the
// screen is drawn, so refreshing the page recovers exactly like pressing "Try again" — otherwise the URL pins the
// reader to a dead screen no reload can leave. A redirect from a check that just failed carries `redirectedFrom`
// and skips the duplicate ask; it also cannot loop, since this only ever redirects on an answer.
export const retryOnEntry = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> =>
    to.redirectedFrom === undefined ? ((await withinBudget(platformRetry(to.query[`returnTo`]))) ?? true) : true;
