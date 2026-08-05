import type { SandboxSummary } from "@intentic-app/api-contract";
import type { RouteLocationRaw } from "vue-router";

/* Does this account have a WORKSPACE to open, or an unfinished setup to go back to?
 *
 * Its own function, and tested, because it is one predicate that decides the first screen of every session and
 * it has already been wrong once in a way nothing caught. The guard used to ask `sandboxes.length === 0`, and a
 * row exists from the moment a name is typed on /setup — long before anything has been installed anywhere. So
 * naming a sandbox and closing the tab was enough to come back to the full workspace shell: the unstarted
 * sandbox in the switcher, a Google sign-in prompt raised by the first daemon call, and a gate reading "Your
 * sandbox reported in" about a machine that had never been started.
 *
 * `lastSeenAt` is the test because it is a fact that never un-happens. The daemon's announce stamps it, and so
 * does sandbox.attach for the bring-your-own-domain lane, so a non-null value means "this has been a real
 * workspace at least once". A sandbox that is merely DOWN keeps its stamp and still opens the shell — the
 * switcher's offline handling is what that case is for, and bouncing the whole shell on a dead daemon is a
 * thing this deliberately does not do. Only the never-up ones are turned away. */
export const setupRedirect = (sandboxes: readonly SandboxSummary[]): RouteLocationRaw | undefined => {
    if (sandboxes.some((entry) => entry.lastSeenAt !== null)) {
        return undefined;
    }
    /* Carry the unfinished sandbox so /setup RESUMES it instead of opening a blank create form. Not tidiness:
     * the free plan includes one sandbox, so a blank form is a form whose Create can only 402 against the very
     * row that caused this redirect — and the row itself is invisible from there.
     *
     * Owned only. A member cannot mint a setup code for someone else's sandbox, so resuming theirs would strand
     * them on a step they are not allowed to finish; they get the plain form, which offers the attach lane. */
    const unfinished = sandboxes.find((entry) => entry.role === `owner`);
    return unfinished === undefined ? `/setup` : { path: `/setup`, query: { sandbox: unfinished.id } };
};
