import type { RouteLocationNormalized, RouteLocationRaw } from "vue-router";
import { useAuth } from "../features/auth/useAuth";
import { returnPath, signInAt } from "./signIn";

// One more ask of the platform, answering with where the reader belongs: the page they were headed for, the sign-in
// screen when the platform says there is no session, or undefined while it still can't answer. Every way off the
// unavailable screen (its button, its own background retry, a reload onto it) goes through this, so they cannot drift.
export const platformRetry = async (returnTo: unknown): Promise<RouteLocationRaw | undefined> => {
    const target = returnPath(returnTo);
    try {
        return (await useAuth().refresh()) === null ? signInAt(target) : target;
    } catch {
        return undefined;
    }
};

/** How long a reload's ask may delay the first paint before the screen is drawn instead. */
export const ENTRY_BUDGET_MS = 1500;

// A platform that hangs rather than refuses must not hold the boot on a blank splash: past the budget the caller is
// told nothing came back. The ask itself keeps running, and the screen's own retry collects whatever it answers.
const within = <T>(work: Promise<T>): Promise<T | undefined> =>
    Promise.race([work, new Promise<undefined>((resolve) => setTimeout(resolve, ENTRY_BUDGET_MS, undefined))]);

// Entry rule for /platform-unavailable. A direct hit (a reload, a bookmark, a restored tab) asks again before the
// screen is drawn, so refreshing the page recovers exactly like pressing "Try again" — otherwise the URL pins the
// reader to a dead screen no reload can leave. A redirect from a check that just failed carries `redirectedFrom`
// and skips the duplicate ask; it also cannot loop, since this only ever redirects on an answer.
export const retryOnEntry = async (to: RouteLocationNormalized): Promise<boolean | RouteLocationRaw> =>
    to.redirectedFrom === undefined ? ((await within(platformRetry(to.query[`returnTo`]))) ?? true) : true;
